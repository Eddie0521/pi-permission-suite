/**
 * Pi Permission Suite Extension
 *
 * 模式：Act / Auto / Ask / Plan
 * 快捷键：Ctrl+Q
 * 命令：/approval-mode
 * 工具：set_approval_mode (agent可调用)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, ApprovalState } from "./types.ts";
import { RuleEngine } from "./rules.ts";
import { autoApprove } from "./approver.ts";
import { Type } from "typebox";

// ─── 模式配置 ──────────────────────────────────────────────────────

const RO = ["read", "grep", "find", "ls", "question", "questionnaire", "web_search", "fetch_content", "get_search_content", "get_subagent_result", "goal_complete", "steer_subagent", "Agent"];
const ALL = [...RO, "bash", "edit", "write"];

const MODE: Record<ApprovalMode, { tools: string[]; desc: string; icon: string }> = {
  ask:  { tools: RO, desc: "只读问答", icon: "❓" },
  auto: { tools: ALL, desc: "subagent审批", icon: "🤖" },
  act:  { tools: ALL, desc: "完全权限", icon: "⚡" },
  plan: { tools: RO, desc: "只读计划", icon: "📋" },
};

const ORDER: ApprovalMode[] = ["act", "auto", "ask", "plan"];

// ─── 共享状态 ──────────────────────────────────────────────────────

interface SuiteState {
  mode: ApprovalMode;
  stats: { approved: number; denied: number; escalated: number };
  rules: RuleEngine;
}

function createState(): SuiteState {
  return { mode: "act", stats: { approved: 0, denied: 0, escalated: 0 }, rules: new RuleEngine() };
}

function cfg(m: ApprovalMode) { return MODE[m]; }

function apply(state: SuiteState, m: ApprovalMode, pi: ExtensionAPI) {
  state.mode = m;
  pi.appendEntry("pi-permission-suite-state", { mode: m, ...state.stats } satisfies ApprovalState);
}

function updateStatus(state: SuiteState, ctx: ExtensionContext) {
  ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("accent", `${cfg(state.mode).icon} ${state.mode.toUpperCase()}`));
}

// ─── 注册命令 ──────────────────────────────────────────────────────

function registerApprovalModeCommand(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerCommand("approval-mode", {
    description: "切换审批模式 (ask/auto/act/plan)",
    getArgumentCompletions: (p) => {
      const out: Array<{ value: string; label: string }> = [];
      for (const m of ORDER) {
        if (m.startsWith(p)) out.push({ value: m, label: `${cfg(m).icon} ${m}` });
      }
      return out;
    },
    handler: async (args, ctx) => {
      const t = args?.trim().toLowerCase() as ApprovalMode | undefined;
      if (t && MODE[t]) apply(state, t, pi);
      else {
        const ch = await ctx.ui.select("模式：", ORDER.map((m) => ({ label: `${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, value: m })));
        if (ch) apply(state, ch, pi); else return;
      }
      ctx.ui.notify(`${cfg(state.mode).icon} ${state.mode.toUpperCase()}`, "info");
      updateStatus(state, ctx);
    },
  });
}

// ─── 注册工具 ──────────────────────────────────────────────────────

function registerApprovalModeTool(pi: ExtensionAPI, state: SuiteState): void {
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
      const prev = state.mode;
      apply(state, m, pi);
      ctx.ui.notify(`${cfg(m).icon} ${m.toUpperCase()} — ${cfg(m).desc}`, "info");
      updateStatus(state, ctx);
      return {
        content: [{ type: "text" as const, text: `已从 ${prev} 切换到 ${m} 模式。${cfg(m).desc}` }],
      };
    },
  });
}

// ─── 注册快捷键 ────────────────────────────────────────────────────

function registerApprovalShortcut(pi: ExtensionAPI, state: SuiteState): void {
  pi.registerShortcut("ctrl+q", {
    description: "循环切换审批模式",
    handler: (ctx) => {
      const next = ORDER[(ORDER.indexOf(state.mode) + 1) % ORDER.length];
      apply(state, next, pi);
      ctx.ui.notify(`${cfg(next).icon} ${next.toUpperCase()}`, "info");
      updateStatus(state, ctx);
    },
  });
}

// ─── tool_call 处理 ────────────────────────────────────────────────

async function handleToolCall(
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
  state: SuiteState,
): Promise<{ block: true; reason: string } | undefined> {
  const toolName = event.toolName;
  const inp = event.input as Record<string, unknown>;

  // 1. deny 规则（所有模式）— bash 用 tree-sitter 异步解析
  const result = toolName === "bash"
    ? await state.rules.evaluateAsync(toolName, inp)
    : state.rules.evaluate(toolName, inp);

  if (result === "deny") {
    const msg = state.rules.getDenyMessage(toolName, inp) ?? "被安全规则拒绝";
    state.stats.denied++;
    ctx.ui.notify(msg, "error");
    return { block: true, reason: msg };
  }

  // 2. Act：全部放行
  if (state.mode === "act") { state.stats.approved++; return undefined; }

  // 3. Ask/Plan：只读（复用 ALLOW 规则，bash 只读命令也放行）
  if (state.mode === "ask" || state.mode === "plan") {
    if (result === "allow") {
      state.stats.approved++;
      return undefined;
    }
    state.stats.denied++;
    return { block: true, reason: `${cfg(state.mode).icon} ${state.mode.toUpperCase()}: ${toolName} 已禁用` };
  }

  // 4. Auto：allow 放行，其余走 subagent
  if (state.mode === "auto") {
    if (result === "allow") { state.stats.approved++; return undefined; }

    ctx.ui.setStatus("pi-permission-suite", ctx.ui.theme.fg("warning", "🤖 审批中..."));
    const decision = await autoApprove(ctx, toolName, inp);

    if (decision.approved) {
      state.stats.approved++;
      if (decision.source === "human") state.stats.escalated++;
    } else {
      state.stats.denied++;
    }
    updateStatus(state, ctx);

    return decision.approved
      ? undefined
      : { block: true, reason: `Auto 拒绝 (${decision.source}): ${decision.reason}` };
  }

  return undefined;
}

// ─── before_agent_start 处理 ───────────────────────────────────────

function handleBeforeAgentStart(state: SuiteState) {
  return {
    message: {
      customType: "pi-permission-suite-context",
      content: `[审批: ${cfg(state.mode).icon} ${state.mode.toUpperCase()}] ${cfg(state.mode).desc}`,
      display: false,
    },
  };
}

// ─── session_start 处理 ────────────────────────────────────────────

function handleSessionStart(
  ctx: ExtensionContext,
  state: SuiteState,
): void {
  const e = ctx.sessionManager.getEntries()
    .filter((x: unknown): x is { customType: string } =>
      typeof x === "object" && x !== null && "customType" in x &&
      (x as Record<string, unknown>).customType === "pi-permission-suite-state"
    )
    .pop() as { data?: ApprovalState } | undefined;

  if (e?.data) {
    state.mode = e.data.mode ?? "act";
    state.stats.approved = e.data.approved ?? 0;
    state.stats.denied = e.data.denied ?? 0;
    state.stats.escalated = e.data.escalated ?? 0;
  }

  state.rules.setCwd(ctx.cwd);
  updateStatus(state, ctx);
}

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function(pi: ExtensionAPI): void {
  const state = createState();

  registerApprovalModeCommand(pi, state);
  registerApprovalModeTool(pi, state);
  registerApprovalShortcut(pi, state);

  pi.on("tool_call", (event, ctx) => handleToolCall(event, ctx, state));
  pi.on("before_agent_start", () => handleBeforeAgentStart(state));
  pi.on("session_start", (_event, ctx) => handleSessionStart(ctx, state));
}
