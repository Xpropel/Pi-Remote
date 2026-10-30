import { useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { attentionRoomTitle } from "@/relay/attention"
import type { InboxEntry } from "@/relay/inbox"
import { inboxConfirmAnswerOf, inboxDetailOf, inboxGroupsOf } from "@/pi/model/inboxView"
import { relativeTimeLabel } from "@/pi/sidebar/model"

/**
 * Codex-shell pending-answer inbox (design D section 1.5). This shell is
 * self-contained and cannot import the Cursor InboxContainer, so it renders
 * the same relay ledger with its own primitives: waiting / error / done
 * groups, confirm rows answerable in place, ask / select / input rows jump
 * into their room (the ledger carries no payloads to answer from here),
 * done / error rows dismissible.
 */
export function CodexInboxPage({ p, phone }: { p: VariantAppProps; phone?: boolean }) {
  const { relay, act } = p
  const [answering, setAnswering] = useState<string | null>(null)
  const now = Date.now()
  const entries = relay.inbox
  const roomsById = new Map(relay.rooms.map((room) => [room.id, room]))
  const groups = inboxGroupsOf(entries)

  const openEntry = (entry: InboxEntry) => {
    if (entry.deviceId && entry.deviceId !== relay.selectedDeviceId) relay.selectDevice(entry.deviceId)
    if (entry.roomId !== relay.roomId) relay.selectRoom(entry.roomId)
    act.openSession()
    if (phone) act.setPhonePage("chat")
  }
  const answerConfirm = (entry: InboxEntry, dialogId: string, action: "allow" | "deny") => {
    if (answering) return
    setAnswering(entry.key)
    void relay.sendDialogAnswerTo(entry.roomId, dialogId, { action }).finally(() => setAnswering(null))
  }

  return (
    <div className="cx-inbox" data-pi-ui-part="page">
      <h1 className="cx-inbox-title">待答</h1>
      {entries.length === 0 ? (
        <p className="cx-inbox-empty">没有等你处理的事。</p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} className="cx-inbox-group">
            <h2 className="cx-inbox-group-title">{group.label}</h2>
            <div className="cx-inbox-rows">
              {group.entries.map((entry) => {
                const answer = inboxConfirmAnswerOf(entry)
                return (
                  <div
                    key={entry.key}
                    role="button"
                    tabIndex={0}
                    className="cx-inbox-row"
                    onClick={() => openEntry(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openEntry(entry)
                    }}
                  >
                    <div className="cx-inbox-row-main">
                      <div className="cx-inbox-row-title">{attentionRoomTitle(roomsById.get(entry.roomId))}</div>
                      <div className="cx-inbox-row-detail">{inboxDetailOf(entry)}</div>
                    </div>
                    <span className="cx-inbox-row-time">{relativeTimeLabel(now, entry.at)}</span>
                    {answer ? (
                      <>
                        <button
                          type="button"
                          className="cx-inbox-action"
                          disabled={answering === entry.key}
                          onClick={(event) => {
                            event.stopPropagation()
                            answerConfirm(entry, answer.dialogId, "allow")
                          }}
                        >
                          {answer.allowLabel}
                        </button>
                        <button
                          type="button"
                          className="cx-inbox-action cx-inbox-action-deny"
                          disabled={answering === entry.key}
                          onClick={(event) => {
                            event.stopPropagation()
                            answerConfirm(entry, answer.dialogId, "deny")
                          }}
                        >
                          {answer.denyLabel}
                        </button>
                      </>
                    ) : null}
                    {entry.kind !== "waiting" ? (
                      <button
                        type="button"
                        className="cx-inbox-action"
                        onClick={(event) => {
                          event.stopPropagation()
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
        ))
      )}
    </div>
  )
}
