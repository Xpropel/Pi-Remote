/** 审批回执（推导：8s 或下一张卡出现时消失；一行灰字） */
export function CodexApprovalReceipt({ status, note }: { status: "denied" | "expired" | "answered-elsewhere"; note?: string }) {
  const text = status === "denied" ? "已拒绝" : status === "expired" ? "已超时，pi 按默认处理" : "已在其他设备回答"
  return (
    <div className="cx-approval-receipt" role="status">
      {text}
      {note ? ` · ${note}` : ""}
    </div>
  )
}
