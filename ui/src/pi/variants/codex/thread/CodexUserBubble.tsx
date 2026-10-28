import { memo } from "react"
import type { Item } from "@/relay/transcript"
import { CodexImagePart } from "./CodexImagePart"

/** 用户气泡（[X-§3] / X-04-1：右对齐、16 圆角、13/20、最大 85%、灰底） */
export const CodexUserBubble = memo(function CodexUserBubble({ item, phone }: { item: Extract<Item, { kind: "user" }>; phone: boolean }) {
  let status: string | null = null
  if (item.failed) status = "发送失败 · 重试"
  else if ((item as Extract<Item, { kind: "user" }> & { outbox?: boolean }).outbox) status = "等重连后发送"
  else if (item.status === "sending") status = "发送中…"
  return (
    <div className="cx-user-turn" data-p4-surface="CX-THREAD-01" data-p4-ready="" data-pi-ui-part="bubble">
      <div className="cx-bubble">
        {item.text ? <div className="cx-bubble-text">{item.text}</div> : null}
        {item.images.length > 0 ? (
          <div className="cx-bubble-images" data-p4-surface="CX-THREAD-08" data-p4-ready="" data-p4-partial="Pi UserItem 无文件附件字段，文件引用经 composer 承载">
            {item.images.map((image, index) => (
              <CodexImagePart key={index} image={image} height={phone ? 120 : 160} />
            ))}
          </div>
        ) : null}
        {item.from === "remote" || item.remote ? <span className="cx-bubble-remote">来自网页</span> : null}
      </div>
      {status ? <span className="cx-msg-status" data-bad={item.failed ? "" : undefined}>{status}</span> : null}
    </div>
  )
})
