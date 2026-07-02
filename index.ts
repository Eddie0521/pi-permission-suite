/**
 * Pi Permission Suite Extension
 *
 * 模式：Act / Auto / Ask / Plan
 * 快捷键：Ctrl+Q
 * 命令：/approval-mode, /approval-status
 * 工具：set_approval_mode (agent可调用)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, ApprovalState } from "./types.ts";
import { RuleEngine } from "./rules.ts";
import { autoApprove } from "./approver.ts";
import { Type } from "typebox";

// ─── 模式配置 ──────────────────────────────────────────────────────

const RO = ["read", "grep", "find", "ls"];
const ALL = [...RO, "bash", "edit", "write"];

const MODE: Record<ApprovalMode, { tools: string[]; desc: string; icon: string }> = {
  ask:  { tools: RO, desc: "只读问答", icon: "❓" },
  auto: { tools: ALL, desc: "subagent审批", icon: "🤖" },
  act:  { tools: ALL, desc: "完全权限", icon: "⚡" },
  plan: { tools: RO, desc: "只读计划", icon: "📋" },
};

const ORDER: ApprovalMode[] = ["act", "auto", "ask", "plan"];

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function(pi: ExtensionAPI): void {
  let mode: ApprovalMode = "act";
  const rules = new RuleEngine();
  const stats = { approved: 0, denied: 0, escalated: 0 };
  const cfg = (m: ApprovalMode) => MODE[m];

  function apply(m: ApprovalMode) {
    mode = m;
    // 不再调用 setActiveTools，避免覆盖扩展注册的工具
    pi.appendEntry("pi-permission-suite-state", { mode, ...stats } satisfies ApprovalState);
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("accent", `${cfg(mode).icon} ${mode.toUpperCase()}`));
  }

  // ─── 命令 ──────────────────────────────────────────────────────

  pi.registerCommand("approval-mode", {
    description: "切换审批模式 (ask/auto/act/plan)",
    getArgumentCompletions: (p) => ORDER.filter((m) => m.startsWith(p)).map((m) => ({ value: m, label: `${cfg(m).icon} ${m}` })),
    handler: async (args, ctx) => {
      const t = args?.trim().toLowerCase() as ApprovalMode | undefined;
      if (t && MODE[t]) apply(t);
      else {
        const ch = await ctx.ui.select("模式：", ORDER.map((m) => ({ label: `${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, value: m })));
        if (ch) apply(ch); else return;
      }
      ctx.ui.notify(`${cfg(mode).icon} ${mode.toUpperCase()}`, "info");
      updateStatus(ctx);
    },
  });

  // ─── 工具：agent可调用 ────────────────────────────────────────────

  pi.registerTool({
    name: "set_approval_mode",
    label: "Set Approval Mode",
    description: `切换审批模式。

可用模式：
• act - 完全权限（默认）
• auto - subagent审批
• ask - 只读问答
• plan - 只读计划`,
    parameters: Type.Object({
      mode: Type.Union([
        Type.Literal("act"),
        Type.Literal("auto"),
        Type.Literal("ask"),
        Type.Literal("plan"),
      ], { description: "要切换的目标模式" }),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const m = params.mode as ApprovalMode;
      const prev = mode;
      apply(m);
      ctx.ui.notify(`${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, "info");
      updateStatus(ctx);
      return {
        content: [{
          type: "text" as const,
          text: `已从 ${prev} 切换到 ${m} 模式。${cfg(m).desc}`,
        }],
      };
    },
  });

  // ─── 快捷键 ────────────────────────────────────────────────────

  pi.registerShortcut("ctrl+q", {
    description: "循环切换审批模式",
    handler: async (ctx) => {
      const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      apply(next);
      ctx.ui.notify(`${cfg(next).icon} ${next.toUpperCase()}`, "info");
      updateStatus(ctx);
    },
  });

  // ─── tool_call 拦截 ────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const { toolName, input } = event;
    const inp = input as Record<string, unknown>;

    // 1. deny 规则（所有模式）— bash 用 tree-sitter 异步解析
    const result = toolName === "bash"
      ? await rules.evaluateAsync(toolName, inp)
      : rules.evaluate(toolName, inp);

    if (result === "deny") {
      const msg = rules.getDenyMessage(toolName, inp) ?? "被安全规则拒绝";
      stats.denied++;
      ctx.ui.notify(msg, "error");
      return { block: true, reason: msg };
    }

    // 2. Act：全部放行
    if (mode === "act") { stats.approved++; return undefined; }

    // 3. Ask/Plan：只读（复用 ALLOW 规则，bash 只读命令也放行）
    if (mode === "ask" || mode === "plan") {
      if (result === "allow") {
        stats.approved++;
        return undefined;
      }
      stats.denied++;
      return { block: true, reason: `${cfg(mode).icon} ${mode.toUpperCase()}: ${toolName} 已禁用` };
    }

    // 4. Auto：allow 放行，其余走 subagent
    if (mode === "auto") {
      if (result === "allow") { stats.approved++; return undefined; }

      ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("warning", "🤖 审批中..."));
      const decision = await autoApprove(ctx, toolName, inp);

      if (decision.approved) {
        stats.approved++;
        if (decision.source === "human") stats.escalated++;
      } else {
        stats.denied++;
      }
      updateStatus(ctx);

      return decision.approved
        ? undefined
        : { block: true, reason: `Auto 拒绝 (${decision.source}): ${decision.reason}` };
    }

    return undefined;
  });

  // ─── 系统提示 ──────────────────────────────────────────────────

  pi.on("before_agent_start", async () => ({
    message: {
      customType: "pi-permission-suite-context",
      content: `[审批: ${cfg(mode).icon} ${mode.toUpperCase()}] ${cfg(mode).desc}`,
      display: false,
    },
  }));

  // ─── 会话恢复 ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const e = ctx.sessionManager.getEntries()
      .filter((x: any) => x.customType === "pi-permission-suite-state")
      .pop() as { data?: ApprovalState } | undefined;

    if (e?.data) {
      mode = e.data.mode ?? "act";
      stats.approved = e.data.approved ?? 0;
      stats.denied = e.data.denied ?? 0;
      stats.escalated = e.data.escalated ?? 0;
    }

    // 更新 CWD 供规则引擎使用（path 规则需要）
    rules.setCwd(ctx.cwd);

    // 不再调用 setActiveTools，避免覆盖扩展注册的工具
    updateStatus(ctx);
  });
}
