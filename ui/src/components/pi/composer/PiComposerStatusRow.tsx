import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { MenuItem, MenuSurface, TextSelector } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { GitBranch } from "@/components/kit/icons"
import { PiContextRing, PiCopyField } from "@/components/pi/shared"
import { usePiMenuSurface, usePiStatic, type PiOverlayControl } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { turnEndAnnouncement } from "@/pi/model/composerInput"
import { DELIVERY_LABEL } from "./options"
import { PiCMenu } from "./PiCMenu"
import { C_ERROR, C_SECONDARY, menuRowH, rowText, TOUCH_44_DOWN, type CVariant } from "./styles"

/** 框下状态行的数据（design §6.4 PiStatusRowData，跨区契约：只许加可选字段） */
export interface PiStatusRowData {
  /** 设备名："MacBook Pro" */
  device?: string
  /** git 分支（get_git_branch，有才显示；null = 没有） */
  branch?: string | null
  /** 忙时投递方式选择器（只在运行中出现，E04） */
  delivery?: "steer" | "follow_up" | null
  /** 行尾小 Spinner（运行中） */
  running?: boolean
  /** 上下文占用：≥70% 才在行尾出预警环（E13，待用户确认 8） */
  context?: { percent: number; trusted: boolean } | null
  /** 一段说明文字："ThinkPad 未连接 · 在电脑上运行 attach"、"未载入"、"太长了，最多 100000 字" */
  note?: string
  tone?: "default" | "warn" | "error"
  /**
   * v1.3（R2-M-11，design §4.7）：原因段是不是 live region，缺省 true。false = 只作视觉、不设 role="status"
   * （PiStatusLine 显示时连接状态由它播报，这里不重复）。样式不变。
   */
  live?: boolean
  /** 可复制的命令（attach 命令等）：状态行下面另起一行 PiCopyField */
  copy?: string
  /** v1.2（K08）扩展 statuses：最多 2 段、每段最多 24 字，状态行右侧灰字；手机上有 note 时不显示 */
  extra?: string[]
  /** P4（design §4.7）：上一个回合以出错结束。回合结束播报区据此读"这一轮出错了"（否则"回合已完成"） */
  turnError?: boolean
}

/** 上下文预警环的阈值（E13：现有 contextUsage.ts 的口径，≥70% 才常显） */
export const CONTEXT_WARN_PERCENT = 70

/** K08 扩展 statuses 的上限：最多 2 段、每段最多 24 字（超出截断加"…"） */
export const STATUS_EXTRA_MAX = 2
export const STATUS_EXTRA_CHARS = 24
export function statusExtraOf(extra: string[] | undefined): string[] {
  return (extra ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, STATUS_EXTRA_MAX)
    .map((s) => {
      const chars = Array.from(s)
      return chars.length > STATUS_EXTRA_CHARS ? `${chars.slice(0, STATUS_EXTRA_CHARS - 1).join("")}…` : s
    })
}

export interface PiComposerStatusRowProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  status: PiStatusRowData
  /** 行尾附加内容 */
  trailing?: ReactNode
  /** P4：true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** P4：改投递方式（投递选择器的菜单） */
  onDeliveryChange?: (value: "steer" | "follow_up") => void
  /** P4：投递菜单受控的打开状态（手机由容器开 sheet：只回调这里） */
  deliveryOpen?: boolean
  onDeliveryOpenChange?: (open: boolean) => void
}

/**
 * composer 框下的状态行（design §1.6、§5）：左投递方式选择器 → 设备 · 分支 → 说明；右端预警环 / Spinner。
 * 桌面高 28、手机高 32。投递选择器 = PiDeliveryMenu 的触发器（文字 + ∨，不画框）。
 * 有 copy 时下面另起一行 PiCopyField（shared）。
 * 参照 ch4/ComposerStatusRow 的排法（图标 + 灰字、段间 12），文案与段落是 Pi 自己的。
 * 实时区域（§4.7）：原因段按 status.live 设 role="status"；回合结束的播报区是 PiTurnAnnouncer（dock 常驻挂一个）。
 */
export function PiComposerStatusRow({
  variant,
  status,
  trailing,
  static: staticProp,
  onDeliveryChange,
  deliveryOpen,
  onDeliveryOpenChange,
  className,
  ...rest
}: PiComposerStatusRowProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const text = phone ? "text-[13px]" : "text-(length:--cw-text-sm)"
  const { delivery, running, note, tone = "default", context, copy, live = true } = status
  // §1.6 D-02：手机有原因时只写原因，不写设备 / 分支；桌面写"原因 · 设备 · 分支"
  const device = phone && note ? undefined : status.device
  const branch = phone && note ? undefined : status.branch
  // K08：扩展 statuses 最多 2 段、每段最多 24 字；手机上有原因时不显示
  const extra = phone && note ? [] : statusExtraOf(status.extra)
  const ring =
    context != null && context.trusted && context.percent >= CONTEXT_WARN_PERCENT ? (
      <PiContextRing percent={context.percent} trusted showLabel size={phone ? 16 : 14} className={C_SECONDARY} />
    ) : null
  const row = (
    <div
      data-slot="pi-composer-status-row"
      data-tone={tone}
      className={cn("flex min-w-0 items-center gap-3 px-1", phone ? "h-8" : "h-7", text, copy == null && className)}
      {...(copy == null ? rest : {})}
    >
      {delivery && (
        <PiDeliveryMenu
          variant={variant}
          value={delivery}
          static={isStatic}
          open={isStatic ? undefined : deliveryOpen}
          onOpenChange={onDeliveryOpenChange}
          onValueChange={onDeliveryChange}
        />
      )}
      {note && (
        <span
          role={live ? "status" : undefined}
          data-slot="pi-composer-status-note"
          className={cn(
            "inline-flex min-w-0 items-center gap-1",
            tone === "error" ? C_ERROR : tone === "warn" ? "text-(--cw-text-2)" : C_SECONDARY,
          )}
        >
          <span className="min-w-0 truncate">{note}</span>
        </span>
      )}
      {(device || branch) && (
        <span className={cn("inline-flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap", C_SECONDARY)}>
          {note && <span aria-hidden>·</span>}
          {device && <span className="min-w-0 truncate">{device}</span>}
          {device && branch && <span aria-hidden>·</span>}
          {branch && (
            <span className="inline-flex shrink-0 items-center gap-1">
              <GitBranch aria-hidden strokeWidth={1.5} className="size-3" />
              {branch}
            </span>
          )}
        </span>
      )}
      {extra.length > 0 && (
        // 排在右侧；宽度不够时 extra 先截断（设备 · 分支在左侧优先），单段 span 才能 truncate
        <span
          data-slot="pi-composer-status-extra"
          className={cn("ml-auto min-w-0 shrink-[4] truncate whitespace-nowrap", C_SECONDARY)}
        >
          {extra.join(" · ")}
        </span>
      )}
      <span className={cn("inline-flex shrink-0 items-center gap-2", extra.length === 0 && "ml-auto")}>
        {trailing}
        {ring}
        {running && <PiSpinner size={phone ? 14 : 12} label="运行中" />}
      </span>
    </div>
  )
  if (copy == null) return row
  return (
    <div data-slot="pi-composer-status" className={cn("flex min-w-0 flex-col gap-1", className)} {...rest}>
      {row}
      <PiCopyField value={copy} />
    </div>
  )
}

/**
 * 回合结束的播报区（design §4.7，P4）：一个常驻、视觉隐藏的 polite 区，和原因段分开、不受 status.live 影响。
 * running 从 true 变成 false 时读一次"回合已完成"（error 时"这一轮出错了"）；下一个回合开始时清空，同一句下次也会再读。
 * 流式正文、运行行、倒计时都不进这里。静态画廊不挂（冻结版没有回合结束事件）。
 */
export function PiTurnAnnouncer({ running, error = false }: { running: boolean; error?: boolean }) {
  const [text, setText] = useState("")
  const prev = useRef<boolean | null>(null)
  useEffect(() => {
    const next = turnEndAnnouncement(prev.current, running, error)
    prev.current = running
    if (next !== null) setText(next)
  }, [running, error])
  return (
    <span role="status" aria-live="polite" data-slot="pi-composer-turn-live" className="sr-only">
      {text}
    </span>
  )
}

export interface PiDeliveryMenuProps extends Omit<ComponentProps<"button">, "value">, PiOverlayControl {
  variant: CVariant
  value: "steer" | "follow_up"
  /** P4：选中一项（插入当前回合 / 等这轮结束） */
  onValueChange?: (value: "steer" | "follow_up") => void
}

/**
 * 投递方式选择器（E04）：运行中时状态行左端的"插入当前回合 ∨ / 等这轮结束 ∨"。
 * 打开后的两项菜单（插入当前回合 / 等这轮结束）没有出图（states）；位置借 Cursor 框下环境选择器（§8）。
 * 静态态：只画选择器（open = 画成打开态）。可交互：桌面是锚定菜单（PiCMenu + PiDeliveryOptions）；
 * 手机由容器开 sheet（点选择器只回调 onOpenChange(true)，sheet 里放 PiDeliveryOptions bare）。
 */
export function PiDeliveryMenu({ variant, value, open, onOpenChange, static: staticProp, onValueChange, className, onClick, ...rest }: PiDeliveryMenuProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const selector = (
    <TextSelector
      data-cw-id="pi-delivery"
      tone="secondary"
      size={phone ? "md" : "sm"}
      label={DELIVERY_LABEL[value]}
      aria-label={`投递方式：${DELIVERY_LABEL[value]}，切换`}
      aria-haspopup={!isStatic && phone ? "dialog" : "menu"}
      open={isStatic ? open : phone ? open : undefined}
      // 手机：点击区只向下外扩（P6.3，design §4.4 M-11：上沿离 composer 胶囊 ≥ 8，不压它的点击区）
      className={cn("shrink-0", C_SECONDARY, phone && TOUCH_44_DOWN, className)}
      onClick={!isStatic && phone ? () => onOpenChange?.(!open) : onClick}
      {...rest}
    />
  )
  if (isStatic || phone) return selector
  return (
    <PiCMenu trigger={selector} open={open} onOpenChange={onOpenChange} side="top" align="start" sideOffset={6}>
      <PiDeliveryOptions variant={variant} value={value} onValueChange={onValueChange} />
    </PiCMenu>
  )
}

/**
 * 投递菜单的两项（P4）：放在 PiMenu 里是 Radix 下拉菜单（↑↓ 焦点在行间移动、Enter 选中、选中后关）；
 * bare（手机 sheet 的内容）时是两行可点的单选行，选中后由调用方关 sheet。
 */
export function PiDeliveryOptions({
  variant,
  value,
  onValueChange,
  bare,
}: {
  variant: CVariant
  value: "steer" | "follow_up"
  onValueChange?: (value: "steer" | "follow_up") => void
  bare?: boolean
}) {
  const surface = usePiMenuSurface()
  const options = ["steer", "follow_up"] as const
  if (bare) {
    const t = rowText(variant)
    return (
      <div data-slot="pi-delivery-menu" role="menu" aria-label="投递方式" className="flex flex-col">
        {options.map((v) => (
          <button
            key={v}
            type="button"
            role="menuitemradio"
            aria-checked={v === value}
            onClick={() => onValueChange?.(v)}
            className={cn(
              "flex w-full items-center justify-between rounded-[var(--cw-menu-item-radius,6px)] px-3 text-left text-(--cw-text) hover:bg-(--cw-row-hover)",
              menuRowH(variant),
              t.main,
            )}
          >
            {DELIVERY_LABEL[v]}
            {v === value && <span className={cn(t.sub, C_SECONDARY)}>当前</span>}
          </button>
        ))}
      </div>
    )
  }
  return (
    <MenuSurface {...surface} data-slot="pi-delivery-menu" aria-label="投递方式" className="w-[200px]">
      {options.map((v) => (
        <MenuItem key={v} role="menuitemradio" aria-checked={v === value} checked={v === value} onSelect={() => onValueChange?.(v)}>
          {DELIVERY_LABEL[v]}
        </MenuItem>
      ))}
    </MenuSurface>
  )
}
