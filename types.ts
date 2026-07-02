/**
 * Pi Permission Suite — 公共类型
 */

/** 审批模式 */
export type ApprovalMode = "act" | "auto" | "ask" | "plan";

/** 审批决策 */
export interface ApprovalDecision {
  approved: boolean;
  source: "subagent" | "human";
  reason?: string;
}

/** 持久化状态 */
export interface ApprovalState {
  mode: ApprovalMode;
  approved: number;
  denied: number;
  escalated: number;
}
