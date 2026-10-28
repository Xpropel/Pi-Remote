import type { VariantAppProps } from "@/pi/variants/types"
import { CodexButton, CodexDialog } from "../primitives/primitives"
import { CodexBadge } from "../primitives/CodexCapability"

/**
 * Branch ready 弹窗（CX-DLG-04 / [X-§6]）：worktree 创建结果 + Next steps；原地换内容（不叠第二层浮层）。
 * 由 RunLocation 在 mock worktree 创建成功后打开；provider 真实创建时展示 provider 返回的 path/branch。
 */
export function CodexBranchReadyDialog({
  p,
  info,
  onClose,
}: {
  p: VariantAppProps
  info: { path: string; branch: string; repoPath?: string }
  onClose: () => void
}) {
  return (
    <CodexDialog
      title="Branch ready"
      onClose={onClose}
      width={460}
      data-p4-surface="CX-DLG-04"
      footer={
        <CodexButton kind="primary" onClick={onClose}>
          继续
        </CodexButton>
      }
    >
      <div className="cx-branch-ready" data-p4-surface="CX-DLG-04" data-capability-state="simulated" data-p4-ready="">
        <div className="cx-branch-ready-head">
          <CodexBadge tone="ok">已创建隔离副本</CodexBadge>
          <span className="cx-branch-ready-branch">{info.branch}</span>
        </div>
        <p className="cx-dialog-text">
          工作目录：<code>{info.path}</code>
        </p>
        <ul className="cx-branch-ready-steps">
          <li>后续消息会在这个独立目录里执行（与主工作区隔离）</li>
          <li>合并 / 清理由 worktree 扩展负责；本机 pi 默认不提供</li>
          <li>关闭本窗口后可从「运行位置 → 指定文件夹」再切换</li>
        </ul>
        <p className="cx-field-hint">隔离副本由 worktree 扩展创建（{p.relay.selectedDevice?.name ?? "当前设备"}）</p>
      </div>
    </CodexDialog>
  )
}
