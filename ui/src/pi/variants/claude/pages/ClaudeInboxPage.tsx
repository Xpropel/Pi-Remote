import { useState } from "react"
import type { PiContainerProps } from "@/pi/containers/types"
import type { InboxEntry } from "@/relay/inbox"
import { inboxConfirmAnswerOf, inboxDetailOf, inboxEntryTitleOf, inboxGroupsOf } from "@/pi/model/inboxView"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { relativeTimeLabel } from "@/pi/sidebar/model"

/**
 * Claude-shell pending-answer inbox (design D section 1.5). This shell is
 * self-contained and cannot import the Cursor InboxContainer, so it renders
 * the same relay ledger with its own primitives: waiting / error / done
 * groups, confirm rows answerable in place, ask / select / input rows jump
 * into their room (the ledger carries no payloads to answer from here),
 * done / error rows dismissible.
 */
export function ClaudeInboxPage({ p }: { p: PiContainerProps }) {
  const { relay, act } = p
  const [answering, setAnswering] = useState<string | null>(null)
  const now = Date.now()
  const entries = relay.inbox
  const roomsById = new Map(relay.rooms.map((room) => [room.id, room]))
  const sessionsById = new Map(sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).map((session) => [session.id, session]))
  const devicesById = new Map(relay.devices.map((device) => [device.id, device]))
  const groups = inboxGroupsOf(entries)

  const openEntry = (entry: InboxEntry) => {
    if (entry.deviceId && entry.deviceId !== relay.selectedDeviceId) relay.selectDevice(entry.deviceId)
    if (entry.roomId !== relay.roomId) relay.selectRoom(entry.roomId)
    act.openSession()
    if (p.variant === "phone") act.setPhonePage("chat")
  }
  const answerConfirm = (entry: InboxEntry, dialogId: string, action: "allow" | "deny") => {
    if (answering) return
    setAnswering(entry.key)
    void relay.sendDialogAnswerTo(entry.roomId, dialogId, { action }).finally(() => setAnswering(null))
  }

  return (
    <div className="claude-inbox" data-pi-ui-part="page">
      <h1 className="claude-inbox-title">待答</h1>
      {entries.length === 0 ? (
        <p className="claude-inbox-empty">没有等你处理的事。</p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} className="claude-inbox-group">
            <h2 className="claude-inbox-group-title">{group.label}</h2>
            <div className="claude-inbox-rows">
              {group.entries.map((entry) => {
                const answer = inboxConfirmAnswerOf(entry)
                return (
                  <div
                    key={entry.key}
                    role="button"
                    tabIndex={0}
                    className="claude-inbox-row"
                    onClick={() => openEntry(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openEntry(entry)
                    }}
                  >
                    <div className="claude-inbox-row-main">
                      <div className="claude-inbox-row-title">{inboxEntryTitleOf(entry, roomsById, sessionsById, devicesById)}</div>
                      <div className="claude-inbox-row-detail">{inboxDetailOf(entry)}</div>
                    </div>
                    <span className="claude-inbox-row-time">{relativeTimeLabel(now, entry.at)}</span>
                    {answer ? (
                      <>
                        <button
                          type="button"
                          className="claude-inbox-action"
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
                          className="claude-inbox-action claude-inbox-action-deny"
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
                        className="claude-inbox-action"
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
