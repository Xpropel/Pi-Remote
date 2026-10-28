import type { ComponentProps, ReactNode } from "react"
import { MenuSurface } from "@/components/kit"
import { PiButton } from "@/components/pi/shared"
import { usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { agoText, DELIVERY_LABEL, hostMessageText } from "./options"
import type { CHostMessage } from "./types"
import type { PiRemoteQueueItem, PiRemoteQueueState } from "@/components/pi/shared/types"
import { C_ERROR, C_SECONDARY, rowText, TOUCH_44, type CVariant } from "./styles"

export interface PiQueuePanelProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  /** remote_queue_state（网页发的，可编辑 / 取消 / 立即发送） */
  remote: PiRemoteQueueState
  /** 本机终端的 queue_update（只读；元素是 AgentMessage） */
  host: { steering: CHostMessage[]; followUp: CHostMessage[] }
  /** 相对时间基准（"40 秒前"） */
  now: number
  /** 作为 PiSheet 内容（手机）：不画卡 */
  bare?: boolean
  /** P4：true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** P4 可交互：远程待发行的"立即发送 / 编辑 / 取消" */
  onAction?: (id: string, action: PiQueueAction) => void
  /**
   * P5（D-06，决定 5）：本页 outbox 段，排在最前（queueSectionsOf 的第一段）。title = "本页待发 · 等重连" / "本页待发"。
   * 每行"取消"（正在发的置灰）；回放失败的行红字"发送失败"+"重试 · 取消"；unknown = 可能已送达。不给 = 不出这一段（画廊屏）。
   */
  outbox?: { title: string; items: PiQueueOutboxItem[] } | null
  /** P5 可交互：outbox 行的"取消 / 重试"（按 cid） */
  onOutboxAction?: (cid: string, action: "cancel" | "retry") => void
  /**
   * P5：正在就地编辑的远程待发行（design states「编辑中」「冲突」）。loading = 被截断的条目先拉全文；
   * conflict = 保存时扩展回 queue_conflict（这条刚在别处改过）：编辑稿保留，给「用我的 / 用新的」。note = 行内红字。
   */
  editing?: { id: string; text: string; phase: "loading" | "ready" | "saving"; conflict?: boolean; note?: string | null } | null
  onEditChange?: (text: string) => void
  onEditSave?: () => void
  onEditCancel?: () => void
  onEditResolve?: (choice: "mine" | "theirs") => void
  /**
   * P6.3（design §4.3）：编辑行的"保存 / 取消"由宿主放进 PiSheet 的 footer（PiQueueEditFooter：键盘开着时钉在键盘上沿），
   * 这里不再画行内的那一排。手机 sheet 用；桌面浮层不传
   */
  editFooter?: boolean
}

export type PiQueueAction = "send-now" | "edit" | "cancel"

/**
 * 手机排队 sheet 编辑一条待发消息时的 footer（P6.3，design §4.3「footer（保存 / 取消等）钉在 sheet 底部、紧贴键盘上沿」）：
 * 和改名弹窗同一排法（取消描边、保存黑底，各占一半）。拉全文和保存中时"保存"不可点，保存中"取消"也不可点。
 */
export function PiQueueEditFooter({
  phase,
  onSave,
  onCancel,
}: {
  phase: "loading" | "ready" | "saving"
  onSave?: () => void
  onCancel?: () => void
}) {
  const saving = phase === "saving"
  return (
    <>
      <PiButton kind="outline" variant="phone" className="flex-1" disabled={saving} data-cw-id="pi-queue-edit-cancel" onClick={onCancel}>
        取消
      </PiButton>
      <PiButton variant="phone" className="flex-1" disabled={phase !== "ready"} data-cw-id="pi-queue-edit-save" onClick={onSave}>
        {saving ? "保存中…" : "保存"}
      </PiButton>
    </>
  )
}

/** outbox 段的一行（P5.6 OutboxEntry 的子集） */
export interface PiQueueOutboxItem {
  cid: string
  text: string
  status: "queued" | "replaying" | "failed"
  at?: number
  error?: string
  /** 发出后没等到结果：可能已经送达 */
  unknown?: boolean
}

/** outbox 回放失败、结果未知时的说明（P5 c 线定的文案） */
export const OUTBOX_UNKNOWN_TEXT = "可能已送达，先看会话"

/** 来源文案：web → 网页；其余照原值（推断：relay 只下发 source 字符串） */
function sourceLabel(source: string): string {
  return source === "web" ? "网页" : source
}

function TextButton({
  variant,
  children,
  strong,
  disabled,
  label,
  onClick,
}: {
  variant: CVariant
  children: ReactNode
  strong?: boolean
  disabled?: boolean
  label?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center rounded-[4px] px-0.5 hover:underline",
        strong ? "font-(--cw-weight-medium) text-(--cw-text)" : "text-(--cw-text-2)",
        disabled && "text-(--cw-text-4) hover:no-underline",
        variant === "phone" && cn(TOUCH_44, "px-1"),
      )}
    >
      {children}
    </button>
  )
}

/** outbox 行的文字按钮：等着的"取消"、正在发的"取消"置灰、失败的"重试 · 取消" */
function OutboxActions({ variant, item, on }: { variant: CVariant; item: PiQueueOutboxItem; on?: (action: "cancel" | "retry") => void }) {
  const dot = <span aria-hidden className="text-(--cw-text-4)">·</span>
  const replaying = item.status === "replaying"
  return (
    <span className={cn("inline-flex shrink-0 items-center", variant === "phone" ? "gap-3" : "gap-1.5")}>
      {item.status === "failed" && (
        <>
          <TextButton variant={variant} strong label={`重试：${item.text}`} onClick={on && (() => on("retry"))}>
            重试
          </TextButton>
          {dot}
        </>
      )}
      <TextButton variant={variant} disabled={replaying} label={`取消：${item.text}`} onClick={on && !replaying ? () => on("cancel") : undefined}>
        取消
      </TextButton>
    </span>
  )
}

function Actions({ variant, on }: { variant: CVariant; on?: (action: PiQueueAction) => void }) {
  const dot = <span aria-hidden className="text-(--cw-text-4)">·</span>
  return (
    <span className={cn("inline-flex shrink-0 items-center", variant === "phone" ? "gap-3" : "gap-1.5")}>
      <TextButton variant={variant} strong onClick={on && (() => on("send-now"))}>
        立即发送
      </TextButton>
      {dot}
      <TextButton variant={variant} onClick={on && (() => on("edit"))}>
        编辑
      </TextButton>
      {dot}
      <TextButton variant={variant} onClick={on && (() => on("cancel"))}>
        取消
      </TextButton>
    </span>
  )
}

/**
 * 排队面板（F08 F09；排队消息编辑 / 取消属未核实项，版式推断）：
 * 段一"网页发的"（remote_queue_state：pending 行 = 正文一行截断 + 灰字"投递方式 · 来源 · 时间" + 文字按钮；injected 只剩灰字"已插入"），
 * 段二"终端里排的 · 只读"（queue_update），脚注"要改或撤回，请回到电脑终端"。
 * 桌面是 tray 上方的浮层（宽 360）；手机是半高 PiSheet 的内容，文字按钮点击区 44、换到第二行右对齐。
 */
export function PiQueuePanel({
  variant,
  remote,
  host,
  now,
  bare,
  static: staticProp,
  onAction,
  outbox,
  onOutboxAction,
  editing,
  onEditChange,
  onEditSave,
  onEditCancel,
  onEditResolve,
  editFooter,
  className,
  ...rest
}: PiQueuePanelProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const t = rowText(variant)
  const actionsOf = (id: string) => (isStatic || !onAction ? undefined : (action: PiQueueAction) => onAction(id, action))
  const outboxItems = outbox?.items ?? []
  const pending = remote.items.filter((i) => i.status === "pending").length + host.steering.length + host.followUp.length + outboxItems.length
  const outboxRow = (item: PiQueueOutboxItem, index: number) => {
    const failed = item.status === "failed"
    const on = isStatic || !onOutboxAction ? undefined : (action: "cancel" | "retry") => onOutboxAction(item.cid, action)
    const sub = failed
      ? item.unknown
        ? OUTBOX_UNKNOWN_TEXT
        : item.error
          ? `发送失败 · ${item.error}`
          : "发送失败"
      : item.status === "replaying"
        ? "正在发送…"
        : item.at != null
          ? `${agoText(item.at, now)} · 连上后按顺序发送`
          : "连上后按顺序发送"
    return (
      // 行的 key 不用 cid：重试会换新 cid（等同重新发一条），用 cid 当 key 行会重建、焦点丢掉；按在队里的位置
      <div key={`outbox-${index}`} data-slot="pi-queue-outbox-row" data-status={item.status} className="flex min-w-0 flex-col gap-0.5 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("min-w-0 flex-1 truncate text-(--cw-text)", t.main)}>{item.text}</span>
          {!phone && <OutboxActions variant={variant} item={item} on={on} />}
        </div>
        <span className={cn(t.sub, failed ? C_ERROR : C_SECONDARY)}>{sub}</span>
        {phone && (
          <div className={cn("flex justify-end pt-1", t.sub)}>
            <OutboxActions variant={variant} item={item} on={on} />
          </div>
        )}
      </div>
    )
  }
  const remoteRow = (item: PiRemoteQueueItem) => {
    if (item.status === "injected") {
      return (
        <div key={item.id} className={cn("flex min-w-0 items-center gap-2 py-2", t.sub)}>
          <span className={cn("min-w-0 truncate", C_SECONDARY)}>{item.text}</span>
          <span className={cn("ml-auto shrink-0", C_SECONDARY)}>已插入</span>
        </div>
      )
    }
    const meta = `${DELIVERY_LABEL[item.segment]} · ${sourceLabel(item.source)} · ${agoText(item.at, now)}`
    if (!isStatic && editing?.id === item.id) {
      const busy = editing.phase !== "ready"
      const dot = <span aria-hidden className="text-(--cw-text-4)">·</span>
      return (
        <div key={item.id} data-slot="pi-queue-editing" className="flex min-w-0 flex-col gap-1.5 py-2">
          {editing.phase === "loading" ? (
            <span role="status" className={cn(t.sub, C_SECONDARY)}>
              正在拉取全文…
            </span>
          ) : (
            <textarea
              data-cw-id="pi-queue-edit"
              aria-label="编辑排队的消息"
              rows={phone ? 3 : 2}
              value={editing.text}
              disabled={editing.phase === "saving"}
              onChange={(event) => onEditChange?.(event.currentTarget.value)}
              className={cn(
                "w-full resize-none rounded-[8px] border border-solid border-(--cw-border) bg-(--cw-surface) px-2.5 py-1.5 text-(--cw-text) outline-none focus-visible:border-(--cw-pi-field-focus-border)",
                phone ? "text-[16px] leading-[22px]" : t.main,
              )}
            />
          )}
          {editing.note && (
            <span role="alert" className={cn("inline-flex flex-wrap items-center gap-1.5", t.sub, C_ERROR)}>
              {editing.note}
              {editing.conflict && onEditResolve && (
                <>
                  {dot}
                  <TextButton variant={variant} strong onClick={() => onEditResolve("mine")}>
                    用我的
                  </TextButton>
                  {dot}
                  <TextButton variant={variant} onClick={() => onEditResolve("theirs")}>
                    用新的
                  </TextButton>
                </>
              )}
            </span>
          )}
          {!editFooter && (
            <div className={cn("flex justify-end", phone ? "gap-3" : "gap-1.5", t.sub)}>
              <TextButton variant={variant} strong disabled={busy} onClick={busy ? undefined : onEditSave}>
                {editing.phase === "saving" ? "保存中…" : "保存"}
              </TextButton>
              {dot}
              <TextButton variant={variant} disabled={editing.phase === "saving"} onClick={editing.phase === "saving" ? undefined : onEditCancel}>
                取消
              </TextButton>
            </div>
          )}
        </div>
      )
    }
    // UI·perf 中-6：failed 是终态（扩展已经不会再注入它），不渲染「立即发送 / 编辑 / 取消」这一排——
    // 那排按钮点下去只会回一句"这条已经在发了，改不了"。失败行只留正文和原因。
    const actionable = item.status === "pending"
    return (
      <div key={item.id} className="flex min-w-0 flex-col gap-0.5 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("min-w-0 flex-1 truncate text-(--cw-text)", t.main)}>{item.text}</span>
          {!phone && actionable && <Actions variant={variant} on={actionsOf(item.id)} />}
        </div>
        <span className={cn(t.sub, item.status === "failed" ? C_ERROR : C_SECONDARY)}>
          {item.status === "failed" ? `发送失败 · ${item.error ?? "重试"}` : meta}
        </span>
        {phone && actionable && (
          <div className={cn("flex justify-end pt-1", t.sub)}>
            <Actions variant={variant} on={actionsOf(item.id)} />
          </div>
        )}
      </div>
    )
  }
  const hostRows = [
    ...host.steering.map((m, i) => ({ key: `s${i}`, text: hostMessageText(m), meta: "插入当前回合" })),
    ...host.followUp.map((m, i) => ({ key: `f${i}`, text: hostMessageText(m), meta: "回合结束后发送" })),
  ]
  const body = (
    <>
      {!bare && (
        <div className={cn("flex items-center justify-between pb-1", t.main)}>
          <span className="font-(--cw-weight-semibold) text-(--cw-text)">排队</span>
          <span className={cn(t.sub, C_SECONDARY)}>{pending} 条在等</span>
        </div>
      )}
      {outboxItems.length > 0 && (
        <>
          <div className={cn("pt-2", t.sub, C_SECONDARY)}>{outbox?.title}</div>
          <div className="flex flex-col divide-y divide-(--cw-divider-soft)">{outboxItems.map(outboxRow)}</div>
        </>
      )}
      {/* 空段不出（queueSectionsOf）；不是第一段时段头上加分隔线（和"终端里排的"同一写法） */}
      {remote.items.length > 0 && (
        <>
          <div className={cn(outboxItems.length > 0 ? "mt-2 border-t border-solid border-(--cw-divider) pt-3" : "pt-2", t.sub, C_SECONDARY)}>网页发的</div>
          <div className="flex flex-col divide-y divide-(--cw-divider-soft)">{remote.items.map(remoteRow)}</div>
        </>
      )}
      {hostRows.length > 0 && (
        <>
          <div
            className={cn(
              outboxItems.length > 0 || remote.items.length > 0 ? "mt-2 border-t border-solid border-(--cw-divider) pt-3" : "pt-2",
              t.sub,
              C_SECONDARY,
            )}
          >
            终端里排的 · 只读
          </div>
          <div className="flex flex-col">
            {hostRows.map((r) => (
              <div key={r.key} className="flex min-w-0 flex-col gap-0.5 py-2">
                <span className={cn("min-w-0 truncate text-(--cw-text)", t.main)}>{r.text}</span>
                <span className={cn(t.sub, C_SECONDARY)}>{r.meta}</span>
              </div>
            ))}
          </div>
          <div className={cn("border-t border-solid border-(--cw-divider-soft) pt-2", t.sub, C_SECONDARY)}>要改或撤回，请回到电脑终端</div>
        </>
      )}
    </>
  )
  if (bare) {
    return (
      <div data-slot="pi-queue-panel" data-cw-id="pi-queue-panel" className={cn("flex flex-col", className)} {...rest}>
        {body}
      </div>
    )
  }
  return (
    <MenuSurface
      data-slot="pi-queue-panel"
      data-cw-id="pi-queue-panel"
      elevation="popover"
      aria-label="排队"
      // P4 可交互：tray 上方的非模态面板，读屏当作一个区域（静态态照冻结版是 MenuSurface 的 role=menu）
      {...(isStatic ? {} : { role: "region" })}
      className={cn("w-[360px] px-4 pt-3 pb-3 select-text", className)}
      {...rest}
    >
      {body}
    </MenuSurface>
  )
}
