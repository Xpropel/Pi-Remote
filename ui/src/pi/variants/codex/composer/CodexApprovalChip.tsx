import { ChevronDown } from "../icons/CodexIcons"

export type CodexApprovalMode = "auto" | "read" | "full"

export const CODEX_APPROVAL_LABEL: Record<CodexApprovalMode, string> = {
  auto: "自动审查",
  read: "只读观察",
  full: "完全放行",
}

export const CODEX_APPROVAL_HINT: Record<CodexApprovalMode, string> = {
  auto: "有风险时才弹审批卡（默认，等同 Pi 的审批能力）",
  read: "只读观察：审批卡只显示，需在电脑上回答",
  full: "全部放行（本机显示；实际权限仍由电脑端扩展决定）",
}

/** 蓝字审批 chip（[X-§4][X-图9③]：28px 高、蓝字、三档下拉） */
export function CodexApprovalChip({
  mode,
  open,
  label,
  title,
  capabilityState,
  onToggle,
}: {
  mode: CodexApprovalMode
  open: boolean
  label?: string
  title: string
  capabilityState: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="cx-approval-chip"
      aria-expanded={open}
      aria-haspopup="menu"
      data-mode={mode}
      data-p4-surface="CX-COMP-02"
      data-p4-action="approval-open"
      data-capability-state={capabilityState}
      title={title}
      onClick={onToggle}
    >
      <span className="cx-approval-dot" aria-hidden />
      {label ?? "审批 · 逐次确认"}
      <ChevronDown aria-hidden size={11} strokeWidth={1.75} />
    </button>
  )
}
