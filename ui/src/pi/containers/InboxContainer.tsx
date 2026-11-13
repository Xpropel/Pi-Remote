import { useState, type ReactNode } from "react"
import { Button, GhostIconButton } from "@/components/kit"
import { CircleAlert, CircleCheck, CircleQuestionMark, Inbox, X } from "@/components/kit/icons"
import { PiCenteredState } from "@/components/pi/shared"
import type { InboxEntry } from "@/relay/inbox"
import { useNow } from "@/pi/hooks/useNow"
import { inboxViewOf, openInboxEntry, type InboxViewRow } from "@/pi/model/inboxView"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import type { PiContainerProps } from "./types"

/**
 * 收件箱视图（设计 D §1.5）：主区整页清单，数据只来自 relay 账本（relay.inbox，
 * 只含元数据）。按 kind 三组——等你回答 / 出错了 / 已完成未读；行 = 会话标题 + 状态行
 * + 相对时间。confirm 类且可答的 waiting 条目可原地答（不需要 options 的只有它：
 * 账本按设计不存 options/message，select/input/editor 点行进房后在对话卡上答）；
 * done/error 行可清除（waiting 不给清除钮——relay 账本层也会拒，防假清零）。
 * 分组、标题、状态行、可答 / 可清除与点行进房都在 inboxView（与手机待答页同一份），这里只管版式。
 * 版式：顶部 44 标题条（与会话顶栏同高）+ 居中 720 列；行 = 打开按钮 + 并列的动作按钮（不嵌套可交互元素）。
 */
const ICONS: Record<InboxEntry["kind"], ReactNode> = {
  waiting: <CircleQuestionMark aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-pi-attention)" />,
  error: <CircleAlert aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-pi-error)" />,
  done: <CircleCheck aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-green)" />,
}

export function InboxContainer(props: PiContainerProps) {
  const { relay, act } = props
  const [answering, setAnswering] = useState<string | null>(null)
  const now = useNow(30_000)
  const entries = relay.inbox
  const sections = inboxViewOf({
    entries,
    rooms: relay.rooms,
    sessions: sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice),
    devices: relay.devices,
    now,
  })

  const openEntry = (row: InboxViewRow) => {
    openInboxEntry(relay, row.entry)
    act.openSession()
  }

  const answerConfirm = (row: InboxViewRow, action: "allow" | "deny") => {
    if (!row.confirm || answering) return
    setAnswering(row.key)
    void relay.sendDialogAnswerTo(row.entry.roomId, row.confirm.dialogId, { action }).finally(() => setAnswering(null))
  }

  return (
    <div data-pi-inbox="" className="flex h-full min-h-0 flex-col">
      <header className="flex h-(--cw-pi-topbar-h) shrink-0 items-center gap-2 px-5">
        <h1 className="m-0 text-(length:--cw-text-md) leading-(--cw-leading-tight) font-semibold text-(--cw-text)">待答</h1>
        {entries.length > 0 ? (
          <span className="text-(length:--cw-text-sm) leading-(--cw-leading-tight) text-(--cw-pi-text-secondary) tabular-nums">{entries.length}</span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex min-h-full items-center justify-center pb-[12vh]">
            <PiCenteredState
              icon={<Inbox aria-hidden size={28} strokeWidth={1.5} className="text-(--cw-text-4)" />}
              title="没有等你处理的事"
              body="会话里有提问、出错或完成未读时，会汇总到这里。"
            />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[720px] px-6 pt-1 pb-10">
            {sections.map((section) => {
              const headingId = `pi-inbox-${section.kind}`
              return (
                <section key={section.kind} aria-labelledby={headingId} className="mt-6 first:mt-2">
                  <h2
                    id={headingId}
                    className="m-0 flex items-baseline gap-1.5 px-3 text-(length:--cw-text-sm) leading-5 font-medium text-(--cw-pi-text-secondary)"
                  >
                    {section.label}
                    <span className="font-normal text-(--cw-text-3) tabular-nums">{section.rows.length}</span>
                  </h2>
                  <ul className="m-0 mt-1 flex list-none flex-col gap-px p-0">
                    {section.rows.map((row) => {
                      const busy = answering === row.key
                      return (
                        <li
                          key={row.key}
                          className="flex min-h-[52px] items-center gap-1.5 rounded-(--cw-radius-row) pr-2 transition-colors duration-100 hover:bg-(--cw-row-hover) focus-within:bg-(--cw-row-hover)"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-(--cw-radius-row) py-2 pl-3 text-left"
                            onClick={() => openEntry(row)}
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center">{ICONS[section.kind]}</span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text)">{row.title}</span>
                              <span className="truncate text-(length:--cw-text-sm) leading-4 text-(--cw-pi-text-secondary)">{row.detail}</span>
                            </span>
                            <span className="shrink-0 pl-2 text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) tabular-nums">{row.timeLabel}</span>
                          </button>
                          {row.confirm ? (
                            <span className="flex shrink-0 items-center gap-1.5 pl-1">
                              <Button variant="outline" size="md" className="font-normal" disabled={busy} onClick={() => answerConfirm(row, "deny")}>
                                {row.confirm.denyLabel}
                              </Button>
                              <Button variant="solid-black" size="md" disabled={busy} onClick={() => answerConfirm(row, "allow")}>
                                {row.confirm.allowLabel}
                              </Button>
                            </span>
                          ) : null}
                          {row.dismissible ? (
                            <GhostIconButton label={`清除：${row.title}`} title="清除" icon={<X />} onClick={() => relay.dismissInbox(row.key)} />
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
