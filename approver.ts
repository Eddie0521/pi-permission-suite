/**
 * Pi Permission Suite — Auto Approver
 *
 * 自包含的自动审批，不依赖外部 subagent 扩展
 * 低置信度转人工
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSubprocess, loadAgent } from "./subprocess-runner.ts";
import type { ApprovalDecision } from "./types.ts";

const AGENT_NAME = "approver";
const CONFIDENCE_THRESHOLD = 0.7;

// ─── 格式化工具调用 ────────────────────────────────────────────────

function formatCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") return `$ ${input.command}`;
  if (["read", "write", "edit"].includes(toolName)) return `${toolName}: ${input.path}`;
  return JSON.stringify(input);
}

// ─── 解析响应 ──────────────────────────────────────────────────────

function parseResponse(text: string): { approved: boolean; reason: string; confidence: number } {
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      return {
        approved: Boolean(p.approved),
        reason: String(p.reason ?? ""),
        confidence: Math.min(1, Math.max(0, Number(p.confidence ?? 0.5))),
      };
    }
  } catch {
    // JSON 解析失败是预期行为 — 返回默认拒绝决策
  }
  return { approved: false, reason: "无法解析", confidence: 0 };
}

// ─── 升级到人工 ────────────────────────────────────────────────────

async function escalate(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, reason: string): Promise<ApprovalDecision> {
  if (!ctx.hasUI) return { approved: false, source: "human", reason: "No UI" };
  const fmt = formatCall(toolName, input);
  const c = await ctx.ui.select(`🤖 审批不确定\n\n${fmt}\n${reason}`, ["✅ 批准", "❌ 拒绝"]);
  return { approved: c?.includes("批准") ?? false, source: "human" };
}

export async function autoApprove(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> {
  // 加载 approver agent 配置
  const agent = loadAgent(AGENT_NAME);
  if (!agent) {
    return escalate(ctx, toolName, input, `Agent "${AGENT_NAME}" 未找到，请创建 ~/.pi/agent/agents/approver.md`);
  }

  const r = await runSubprocess(
    `评估：\n工具: ${toolName}\n参数: ${formatCall(toolName, input)}`,
    {
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      timeout: 10000,
    },
  );

  if (!r.success) return escalate(ctx, toolName, input, r.error ?? "调用失败");

  const decision = parseResponse(r.output);
  return decision.confidence >= CONFIDENCE_THRESHOLD
    ? { approved: decision.approved, source: "subagent", reason: decision.reason }
    : escalate(ctx, toolName, input, decision.reason);
}
