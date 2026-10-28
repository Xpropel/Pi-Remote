import { CodexApprovalCard } from "./CodexApprovalCard"

type Dialog = Parameters<typeof CodexApprovalCard>[0]["dialog"]

/**
 * confirm 形态审批卡的**舞台预览**（仅用于 codex-screens 对图；产品态永不渲染）：
 * 用合成 dialog 直接渲染自有 CodexApprovalCard（confirm → 「拒绝 / 允许一次」分裂按钮），
 * 由 CodexApp 在 `#/…&cx-approval=confirm` 且舞台模式下挂载（verify-ui-v2 §6-7 P3-7 的截图补拍）。
 */
export function CodexApprovalPreview({ phone }: { phone: boolean }) {
  const dialog = {
    dialogId: "codex-preview-confirm",
    kind: "confirm",
    title: "允许 pi 运行这条命令吗？",
    message: "npm test -- --grep 键盘",
    startedAt: Date.now() - 8_000,
    answerable: true,
  } as unknown as Dialog
  return (
    <div className="cx-approval-preview" data-variant={phone ? "phone" : "desktop"} data-pi-ui-part="approval">
      <div className="cx-approval-preview-inner">
        <CodexApprovalCard dialog={dialog} state="open" sending={false} failed={false} onAnswer={() => undefined} onRetry={() => undefined} />
      </div>
    </div>
  )
}
