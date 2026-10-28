import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { AgentStatusMarker, GhostIconButton, InlineLink } from "@/components/kit"
import { usePiMotion } from "@/pi/hooks/useReducedMotion"
import { PiSpinner } from "./PiSpinner"
import { Check, CircleAlert, CircleCheck, Info, TriangleAlert, X } from "@/components/kit/icons"

/* ======================= 连接状态行 ======================= */

export interface PiStatusLineProps {
  /**
   * waiting = 断了、等下一次重连（倒计时）；reconnecting = 正在重连；offline = 断开满 30 秒（"已断开"）；
   * restored = 刚恢复（"已重新连接"，产品里 1 秒后淡出）
   */
  state: "waiting" | "reconnecting" | "offline" | "restored"
  /** waiting：距下一次重连的秒数 */
  seconds?: number
  /** 第几次重连（只进无障碍标签） */
  attempt?: number
  /** 第一次就连不上（LinkView.first）：文案改成"连不上服务器，N 秒后重试" */
  first?: boolean
  /**
   * P4.5：到时该消失了（"已重新连接"停留时间到）。正常动效下淡出（容器在淡出后卸掉它）；
   * 减少动效时直接不渲染（design §4.7「"已重新连接"等淡出改成到时直接消失」）
   */
  leaving?: boolean
  /** 点"立即重连" */
  onReconnect?: () => void
  className?: string
}

/**
 * 顶栏下的连接状态行（design §5、A03 / A04 / K02）：只在异常时出现，正常态不画任何标记。
 * 高 --cw-pi-status-line-h（桌面 32、手机 36），底 --cw-pi-status-line-bg，字 --cw-pi-text-secondary；"立即重连"点击区 44（手机）。推断。
 * 读屏（design §4.7，P4.5）：整行是 role="status"，但播报的只是一段视觉隐藏的文字，它只在 state / first 变化时更新——
 * 倒计时秒数不进 live region，"4 秒后重连"只在进入 waiting 时读一次；屏幕上的秒数照常每秒变（对读屏隐藏）。
 */
export function PiStatusLine({ state, seconds = 0, attempt, first = false, leaving = false, onReconnect, className }: PiStatusLineProps) {
  const { fadeOut } = usePiMotion()
  let lead: ReactNode
  let text: string
  let action: string | null = "立即重连"
  switch (state) {
    case "waiting":
      lead = <AgentStatusMarker variant="hollow-circle" />
      text = first ? `连不上服务器，${seconds} 秒后重试` : `与服务器断开，${seconds} 秒后重连`
      break
    case "reconnecting":
      lead = <PiSpinner size={12} tone="muted" label="正在重连" />
      text = "正在重连…"
      action = null
      break
    case "offline":
      lead = <AgentStatusMarker variant="hollow-circle" />
      text = "已断开"
      break
    case "restored":
      lead = <Check aria-hidden size={14} strokeWidth={2} className="text-(--cw-blue)" />
      text = "已重新连接"
      action = null
      break
  }
  // 播报文字只在进入新状态时取一次（React 文档的"根据上一次渲染调整 state"写法），倒计时变化不更新它
  const announceKey = `${state}:${first ? 1 : 0}`
  const [announced, setAnnounced] = useState({ key: announceKey, text })
  if (announced.key !== announceKey) setAnnounced({ key: announceKey, text })
  if (leaving && !fadeOut) return null
  return (
    <div
      role="status"
      data-pi-status-line={state}
      data-leaving={leaving ? "" : undefined}
      className={cn(
        // 视觉审查第 1 轮（A6）：底色 = chip 灰（#E6E6E6），secondary 在上面只有 4.3:1 → 正文用 --cw-text-2（5.7）；链接 --cw-link 已在 pi-theme 压深（4.9）
        "flex h-(--cw-pi-status-line-h) shrink-0 items-center justify-center gap-2 bg-(--cw-pi-status-line-bg) px-4 text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text-2)",
        leaving && "opacity-0 transition-opacity duration-300",
        className,
      )}
    >
      {/* 绝对定位的视觉隐藏文字不参与 flex 排版，图不变 */}
      <span className="sr-only">{attempt ? `${announced.text}（第 ${attempt} 次重连）` : announced.text}</span>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
        {lead}
      </span>
      <span aria-hidden className="min-w-0 truncate">
        {text}
      </span>
      {action && (
        // 点击区 44 高（-my-3 py-3）比状态行（手机 36）高，抬到 raised 层让它不被顶栏 / 流区盖住（design §4.4）
        <InlineLink
          className="relative z-(--cw-pi-z-raised) -my-3 inline-flex shrink-0 items-center py-3 font-medium"
          href="#reconnect"
          onClick={onReconnect}
        >
          {action}
        </InlineLink>
      )}
    </div>
  )
}

/* ======================= 通知卡 ======================= */

export interface PiNoticeAction {
  label: string
  primary?: boolean
}

export interface PiNoticeCardProps {
  level: "info" | "success" | "warning" | "error"
  title: string
  body?: string
  actions?: PiNoticeAction[]
  /** 后面还排着几条通知（右上灰字 "+N"） */
  count?: number
  /** 同 key 合并的次数（标题后灰字 "×N"） */
  merged?: number
  /** desktop = 宽 420、文字按钮高 28（默认）；phone = 整宽，文字按钮与 × 的点击区 44（design §4.4） */
  variant?: "desktop" | "phone"
  /** 整宽（父容器给宽度）；不传时 phone 整宽、desktop 420 */
  fullWidth?: boolean
  className?: string
  /** 可交互（P5）：点了第 index 个文字按钮；不传 = 按钮不挂回调（画廊屏，DOM 不变） */
  onAction?: (index: number) => void
  /** 可交互（P5）：点了 ×；不传 = 不挂回调 */
  onDismiss?: () => void
}

const NOTICE_ICON = {
  info: <Info aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-text-2)" />,
  success: <CircleCheck aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-blue)" />,
  warning: <TriangleAlert aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-text)" />,
  error: <CircleAlert aria-hidden size={16} strokeWidth={1.75} className="text-(--cw-pi-error)" />,
} as const

/**
 * 通知卡（design F10）：白卡 + 浮层阴影；图标 + 标题 + 正文 + 文字按钮 + ×，右上 "+N"。
 * 颜色只给状态：warning 黑三角、error 红圈、success 蓝勾、info 灰 i。推断（Cursor 帧里没有通知卡）。
 */
export function PiNoticeCard({
  level,
  title,
  body,
  actions = [],
  count,
  merged,
  variant = "desktop",
  fullWidth,
  className,
  onAction,
  onDismiss,
}: PiNoticeCardProps) {
  const phone = variant === "phone"
  const wide = fullWidth ?? phone
  return (
    <div
      // design §4.7：只有 error 用 alert（assertive），info / success / warning 用 status（polite）
      role={level === "error" ? "alert" : "status"}
      data-pi-notice={level}
      data-variant={variant}
      className={cn(
        "relative flex gap-3 rounded-(--cw-radius-card) bg-(--cw-surface) text-left shadow-(--cw-shadow-popover)",
        // 手机：44 高的文字按钮自带上下留白，所以有按钮时底边距收到 4
        phone && actions.length > 0 ? "pt-3 pr-3 pb-1 pl-3.5" : "py-3 pr-3 pl-3.5",
        wide ? "w-full" : "w-[420px] max-w-full",
        className,
      )}
    >
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{NOTICE_ICON[level]}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={cn("flex items-baseline gap-1.5", phone ? "pr-[76px]" : "pr-14")}>
          <span className="text-(length:--cw-text-base) leading-[20px] font-semibold text-(--cw-text)">{title}</span>
          {merged ? <span className="text-(length:--cw-text-sm) text-(--cw-pi-text-secondary)">×{merged}</span> : null}
        </div>
        {body && <p className="mt-0.5 mb-0 text-(length:--cw-text-md) leading-[19px] text-(--cw-text-2)">{body}</p>}
        {actions.length > 0 && (
          <div className={cn("flex items-center", phone ? "mt-0.5 -ml-2 gap-0.5" : "mt-2 -ml-1.5 gap-1")}>
            {actions.map((a, index) => (
              <button
                key={a.label}
                type="button"
                onClick={onAction ? () => onAction(index) : undefined}
                className={cn(
                  "inline-flex items-center rounded-(--cw-radius-button) text-(length:--cw-text-md) outline-none select-none hover:bg-(--cw-text)/5",
                  phone ? "h-11 px-2" : "h-7 px-1.5",
                  a.primary ? "font-medium text-(--cw-text)" : "text-(--cw-pi-text-secondary)",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={cn("absolute flex items-center gap-1", phone ? "top-0 right-0" : "top-2 right-2")}>
        {count ? (
          <span data-pi-notice-count="" className="text-(length:--cw-text-sm) leading-5 text-(--cw-pi-text-secondary) tabular-nums">
            +{count}
          </span>
        ) : null}
        <GhostIconButton
          size="sm"
          label="关闭通知"
          icon={<X />}
          onClick={onDismiss}
          className={phone ? "size-11 rounded-full [&>svg]:size-4" : undefined}
        />
      </div>
    </div>
  )
}

/* ======================= 居中状态块 ======================= */

export interface PiCenteredStateProps {
  icon?: ReactNode
  spinner?: boolean
  title: ReactNode
  body?: ReactNode
  actions?: ReactNode
  /** 动作行的 class（手机整宽竖排时传 "w-full"） */
  actionsClassName?: string
  className?: string
}

/** 居中的空 / 加载 / 错误块（design A06、J08、清单·错误边界） */
export function PiCenteredState({ icon, spinner, title, body, actions, actionsClassName, className }: PiCenteredStateProps) {
  return (
    <div data-pi-centered="" className={cn("flex flex-col items-center px-6 text-center", className)}>
      {spinner ? <PiSpinner size={18} tone="muted" label="正在加载" className="mb-3" /> : null}
      {icon != null ? <div className="mb-4 flex items-center justify-center">{icon}</div> : null}
      <div className="text-(length:--cw-text-lg) leading-[22px] font-semibold text-(--cw-text)">{title}</div>
      {body != null ? (
        <div className="mt-1.5 max-w-[440px] text-(length:--cw-text-md) leading-[20px] text-(--cw-pi-text-secondary)">{body}</div>
      ) : null}
      {actions != null ? (
        <div className={cn("mt-5 flex flex-wrap items-center justify-center gap-2", actionsClassName)}>{actions}</div>
      ) : null}
    </div>
  )
}

/* ======================= 跨区占位 ======================= */

export interface PiSlotProps {
  label: string
  height?: number | string
  className?: string
}

/** 别区导出件还没到时的中性占位（design §6.6）：虚线框 + "待 b 区交付：PiTranscript"。终版截图里不能出现 */
export function PiSlot({ label, height, className }: PiSlotProps) {
  return (
    <div
      data-pi-slot={label}
      className={cn(
        "flex items-center justify-center rounded-(--cw-radius-card) border border-dashed border-(--cw-border-strong) text-(length:--cw-text-sm) text-(--cw-text-3)",
        className,
      )}
      style={{ height: height ?? 96 }}
    >
      {label}
    </div>
  )
}
