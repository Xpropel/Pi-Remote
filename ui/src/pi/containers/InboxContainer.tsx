import { useState } from "react"
import { attentionRoomTitle } from "@/relay/attention"
import { inboxDialogIdOf, type InboxEntry } from "@/relay/inbox"
import { relativeTimeLabel } from "@/pi/sidebar/model"
import type { PiContainerProps } from "./types"

/**
 * 收件箱视图（设计 D §1.5）：主区整页清单，数据只来自 relay 账本（relay.inbox，
 * 只含元数据）。按 kind 三组——等你答 / 出错了 / 已完成未读；行 = 会话标题 + 状态行
 * + 相对时间。confirm 类且可答的 waiting 条目可原地答（不需要 options 的只有它：
 * 账本按设计不存 options/message，select/input/editor 点行进房后在对话卡上答）；
 * done/error 行可清除（waiting 不给清除钮——relay 账本层也会拒，防假清零）。
 * 状态行文案本期就地给（§2 的 roomStatusLine 落地后换同一生成函数）。
 */
function inboxDetailOf(entry: InboxEntry): string {
  if (entry.kind === "error") return entry.subkind === "schedule" ? entry.title || "定时消息发送失败" : "回合出错了，还没看"
  if (entry.kind === "done") return "回合已完成，还没看"
  // waiting
  if (entry.subkind === "ask") return entry.title || "等你回答"
  if (entry.subkind === "prompt") return entry.title || "有弹窗等你处理"
  if (entry.title) return `等你处理：${entry.title}`
  switch (entry.dialogKind) {
    case "confirm":
      return "等你确认"
    case "select":
      return "等你选择"
    case "input":
    case "editor":
      return "等你输入"
    default:
      return "有弹窗等你处理"
  }
}

const GROUPS: { kind: InboxEntry["kind"]; label: string }[] = [
  { kind: "waiting", label: "等你答" },
  { kind: "error", label: "出错了" },
  { kind: "done", label: "已完成未读" },
]

export function InboxContainer(props: PiContainerProps) {
  const { relay, act } = props
  const [answering, setAnswering] = useState<string | null>(null)
  const now = Date.now()
  const entries = relay.inbox
  const roomsById = new Map(relay.rooms.map((room) => [room.id, room]))

  const openEntry = (entry: InboxEntry) => {
    if (entry.deviceId && entry.deviceId !== relay.selectedDeviceId) relay.selectDevice(entry.deviceId)
    if (entry.roomId !== relay.roomId) relay.selectRoom(entry.roomId)
    act.openSession()
  }

  const answerConfirm = (entry: InboxEntry, action: "allow" | "deny") => {
    const dialogId = inboxDialogIdOf(entry)
    if (!dialogId || answering) return
    setAnswering(entry.key)
    void relay.sendDialogAnswerTo(entry.roomId, dialogId, { action }).finally(() => setAnswering(null))
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-5">
      <h1 className="m-0 text-(length:--cw-text-lg) font-(--cw-weight-semibold) text-(--cw-text-1)">待答</h1>
      {entries.length === 0 ? (
        <p className="mt-6 text-(length:--cw-text-sm) text-(--cw-text-3)">没有等你处理的事。</p>
      ) : (
        GROUPS.map((group) => {
          const rows = entries.filter((entry) => entry.kind === group.kind)
          if (!rows.length) return null
          return (
            <section key={group.kind} className="mt-6">
              <h2 className="m-0 text-(length:--cw-text-sm) font-(--cw-weight-medium) text-(--cw-text-2)">{group.label}</h2>
              <div className="mt-2 flex flex-col gap-1">
                {rows.map((entry) => {
                  const dialogId = inboxDialogIdOf(entry)
                  const canConfirm = entry.kind === "waiting" && entry.subkind === "dialog" && entry.dialogKind === "confirm" && entry.answerable === true && !!dialogId
                  return (
                    <div
                      key={entry.key}
                      role="button"
                      tabIndex={0}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-(--cw-hover-bg)"
                      onClick={() => openEntry(entry)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openEntry(entry)
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-(length:--cw-text-sm) text-(--cw-text-1)">{attentionRoomTitle(roomsById.get(entry.roomId))}</div>
                        <div className="truncate text-(length:--cw-text-xs) text-(--cw-text-3)">{inboxDetailOf(entry)}</div>
                      </div>
                      <span className="shrink-0 text-(length:--cw-text-xs) text-(--cw-text-3)">{relativeTimeLabel(now, entry.at)}</span>
                      {canConfirm ? (
                        <>
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-2 py-1 text-(length:--cw-text-xs) font-(--cw-weight-medium) text-(--cw-text-1) hover:bg-(--cw-hover-bg)"
                            disabled={answering === entry.key}
                            onClick={(e) => {
                              e.stopPropagation()
                              answerConfirm(entry, "allow")
                            }}
                          >
                            允许
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-2 py-1 text-(length:--cw-text-xs) font-(--cw-weight-medium) text-[color:var(--cw-pi-error,var(--cw-red))]"
                            disabled={answering === entry.key}
                            onClick={(e) => {
                              e.stopPropagation()
                              answerConfirm(entry, "deny")
                            }}
                          >
                            拒绝
                          </button>
                        </>
                      ) : null}
                      {entry.kind !== "waiting" ? (
                        <button
                          type="button"
                          className="shrink-0 rounded-md px-2 py-1 text-(length:--cw-text-xs) text-(--cw-text-3) hover:bg-(--cw-hover-bg)"
                          onClick={(e) => {
                            e.stopPropagation()
                            relay.dismissInbox(entry.key)
                          }}
                        >
                          清除
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
