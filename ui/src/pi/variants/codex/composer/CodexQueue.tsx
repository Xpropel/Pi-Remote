import { useState } from "react"
import { Pencil, Trash2, X } from "../icons/CodexIcons"

type QueueItem = { id: string; text: string }
type QueueLike = { steering: readonly unknown[]; followUp: readonly unknown[] }

/**
 * 队列行（CX-COMP-05 / [X-§4]）：运行中再发进队列，不打断；一行 12px 灰字，可展开编辑/删除。
 * 编辑走 relay.queueEdit（queue_edit，保 id/段位/图片/位次），删除走 relay.queueCancel（queue_cancel）。
 */
export function CodexQueue({
  queue,
  count,
  onEdit,
  onCancel,
}: {
  queue: QueueLike
  count: number
  onEdit: (id: string, text: string) => void | Promise<void>
  onCancel: (id: string) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const items: QueueItem[] = [...queue.steering, ...queue.followUp]
    .map((entry) => entry as { id?: unknown; text?: unknown })
    .filter((entry) => typeof entry.id === "string")
    .map((entry) => ({ id: String(entry.id), text: String(entry.text ?? "") }))
  if (count <= 0) return null
  return (
    <div className="cx-queue" data-p4-surface="CX-COMP-05" data-p4-ready="">
      <button type="button" className="cx-queue-line" title="排队中的消息，点开可编辑或取消" aria-expanded={open} data-p4-action="toggle-queue" onClick={() => setOpen((value) => !value)}>
        已排队 {count} 条 · 按顺序发送
        <span className="cx-queue-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <ul className="cx-queue-list">
          {items.map((item) => (
            <li className="cx-queue-item" key={item.id}>
              {editId === item.id ? (
                <div className="cx-queue-edit">
                  <input
                    className="cx-queue-input"
                    value={draft}
                    aria-label="编辑排队消息"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void onEdit(item.id, draft.trim())
                        setEditId(null)
                      } else if (event.key === "Escape") setEditId(null)
                    }}
                  />
                  <button
                    type="button"
                    className="cx-queue-btn"
                    data-p4-action="queue-save"
                    onClick={() => {
                      if (draft.trim()) void onEdit(item.id, draft.trim())
                      setEditId(null)
                    }}
                  >
                    保存
                  </button>
                  <button type="button" className="cx-queue-btn" aria-label="取消编辑" onClick={() => setEditId(null)}>
                    <X aria-hidden size={11} strokeWidth={2} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="cx-queue-text">{item.text}</span>
                  <button
                    type="button"
                    className="cx-queue-btn"
                    aria-label="编辑排队消息"
                    data-p4-action="queue-edit"
                    onClick={() => {
                      setEditId(item.id)
                      setDraft(item.text)
                    }}
                  >
                    <Pencil aria-hidden size={11} strokeWidth={1.75} />
                  </button>
                  <button type="button" className="cx-queue-btn" aria-label="删除排队消息" data-p4-action="queue-cancel" onClick={() => void onCancel(item.id)}>
                    <Trash2 aria-hidden size={11} strokeWidth={1.75} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
