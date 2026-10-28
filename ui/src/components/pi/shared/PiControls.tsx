import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { MenuItem, MenuLabel, MenuSearch, MenuSeparator, MenuSurface } from "@/components/kit"
import { Check, Copy, Layers } from "@/components/kit/icons"
import { paletteMatches } from "@/pi/model/composerInput"
import { piAgo, piDuration, piPercent, piTokens } from "./format"
import { PiPlatformIcon } from "./PiMark"
import { usePiMenuSurface } from "./layers"
import type { PiDevice } from "./types"

/* ======================= 复制框 ======================= */

export interface PiCopyFieldProps {
  value: string
  /** 框上方的灰字标签 */
  label?: ReactNode
  /** md = 高 --cw-pi-field-h（桌面 32、手机 44，默认）；sm = 24 高的紧凑框（放进 28 高的框下状态行） */
  size?: "md" | "sm"
  className?: string
}

/**
 * 等宽一行 + "复制"（design §6.3）：复制后图标换 ✓、文字换"已复制"，1.2 秒后恢复。
 * 高 --cw-pi-field-h（桌面 32、手机 44），"复制"点击区与框同高。
 */
export function PiCopyField({ value, label, size = "md", className }: PiCopyFieldProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () => {
    void navigator.clipboard?.writeText(value).catch(() => undefined)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div data-pi-copy-field="" className={cn("flex min-w-0 flex-col gap-1", className)}>
      {label != null && <span className="text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">{label}</span>}
      <div
        className={cn(
          "flex min-w-0 items-center border border-solid border-(--cw-border) bg-(--cw-surface)",
          size === "sm" ? "h-6 rounded-(--cw-radius-button) pl-2" : "h-(--cw-pi-field-h) rounded-(--cw-radius-input) pl-2.5",
        )}
      >
        <code
          className={cn(
            "min-w-0 flex-1 truncate font-mono leading-(--cw-leading-tight) text-(--cw-text)",
            size === "sm" ? "text-[11.5px]" : "text-(length:--cw-text-code)",
          )}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "已复制" : `复制 ${value}`}
          className={cn(
            "ml-1 inline-flex h-full shrink-0 items-center gap-1 border-l border-solid border-(--cw-border) text-(length:--cw-text-sm) text-(--cw-text-2) outline-none select-none hover:bg-(--cw-text)/5",
            size === "sm"
              ? "rounded-r-(--cw-radius-button) px-1.5"
              : // 点击区盖住框的上下 1px 描边，= 框高 --cw-pi-field-h（手机 44，design §4.4；视觉不变）
                "relative rounded-r-(--cw-radius-input) px-2.5 after:absolute after:inset-x-0 after:-inset-y-px after:content-['']",
          )}
        >
          {copied ? (
            <Check aria-hidden size={14} strokeWidth={2} className="text-(--cw-blue)" />
          ) : (
            <Copy aria-hidden size={14} strokeWidth={1.5} />
          )}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  )
}

/* ======================= 上下文圆环 ======================= */

export interface PiContextRingProps {
  /** 上下文占用百分数（30.9）；null = 不知道 */
  percent: number | null
  /** 窗口可信（contextUsage.contextWindow 可靠）；不可信时只写 token 数，不画圆环 */
  trusted: boolean
  /** 不可信时显示的 token 数 */
  tokens?: number | null
  /** 外径，默认 14 */
  size?: number
  /** 圆环后跟 "30.9%" */
  showLabel?: boolean
  className?: string
}

/**
 * 上下文圆环（design E13）：浅灰轨道 + 弧，从 12 点顺时针；<70 灰、70–89 深、≥90 红（推断）。
 * 几何参照 ch2/ContextRing（自绘，不 import：原件只有一档颜色）。
 */
export function PiContextRing({ percent, trusted, tokens, size = 14, showLabel = false, className }: PiContextRingProps) {
  if (!trusted || percent == null) {
    return (
      <span data-pi-context-ring="untrusted" className={cn("tabular-nums", className)}>
        {tokens != null ? `${piTokens(tokens)} tokens` : "—"}
      </span>
    )
  }
  const sw = 1.75
  const r = (size - sw) / 2
  const c = size / 2
  const circ = 2 * Math.PI * r
  const frac = Math.min(1, Math.max(0, percent / 100))
  const tone = percent >= 90 ? "var(--cw-pi-error)" : percent >= 70 ? "var(--cw-text)" : "var(--cw-text-3)"
  return (
    <span data-pi-context-ring={percent >= 90 ? "high" : percent >= 70 ? "warn" : "ok"} className={cn("inline-flex items-center gap-1.5", className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`上下文 ${piPercent(percent)}%`} className="block shrink-0">
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--cw-border)" strokeWidth={sw} />
        {frac > 0 && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeDasharray={`${frac * circ} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
      {showLabel && <span className="tabular-nums">{piPercent(percent)}%</span>}
    </span>
  )
}

/* ======================= 设备菜单 ======================= */

/** 设备行第二行灰字：在线 · 窗口剩余 5h 12m / 未连接 · 1 天前在线 */
export function piDeviceStatusText(device: PiDevice, now: number): string {
  if (device.online) {
    return device.windowExpiresAt ? `在线 · 窗口剩余 ${piDuration(device.windowExpiresAt - now)}` : "在线"
  }
  const ago = piAgo(device.lastAttachAt, now)
  return ago ? `未连接 · ${ago}在线` : "未连接"
}

export interface PiDeviceMenuProps {
  devices: PiDevice[]
  /** 每台设备的会话数（行尾灰字） */
  counts: Record<string, number>
  /** 当前项（设备 id，或 "all"） */
  value?: string
  /** 第一项"全部设备" */
  allowAll?: boolean
  /** 菜单小标题（"运行在"、"设备"） */
  title?: string
  /** 手机 sheet 里的形态：去掉卡片外观，行高跟手机 token（48） */
  asSheet?: boolean
  /** 分隔线下的附加项（"配对新设备…"） */
  footer?: ReactNode
  /** 相对时间基准 */
  now: number
  /** P4：选中一行（设备 id，或 "all"）。放在 PiMenu 里时选中后菜单自己关 */
  onSelect?: (value: string) => void
  className?: string
}

/**
 * 设备列表菜单（design C02 / C03）：图标 + 名称 + 灰字状态 + 行尾会话数，当前项 ✓（不置顶）；超过 6 台出现搜索。
 * compose from kit: MenuSurface（static）、MenuLabel、MenuItem、MenuSeparator、MenuSearch；参照 ch4/RunOnMenu L2。
 * P6：搜索框按设备名过滤（同 PiFolderPicker，paletteMatches；"全部设备"按这几个字一起过滤）；手机 sheet 里 16px、高 44
 * （design §4.2 第 8 条防 iOS 聚焦放大、§4.4）。
 */
export function PiDeviceMenu({ devices, counts, value, allowAll = false, title, asSheet = false, footer, now, onSelect, className }: PiDeviceMenuProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  // P4：放在 PiMenu 里时是 Radix 下拉菜单的内容；其余（静态态、sheet 里的同一组项）是 static
  // asSheet（嵌在别的菜单 / sheet 里的同一组项）不再套一层 Radix Content
  const surface = usePiMenuSurface()
  const searchable = devices.length > 6
  const [query, setQuery] = useState("")
  const q = searchable ? query : ""
  const shown = devices.filter((device) => paletteMatches(q, device.name))
  const showAll = allowAll && paletteMatches(q, "全部设备")
  return (
    <MenuSurface
      {...(asSheet ? undefined : surface)}
      data-pi-device-menu=""
      className={cn(asSheet ? "w-full bg-transparent p-0 shadow-none" : "w-[300px]", className)}
    >
      {searchable && (
        <MenuSearch
          placeholder="搜索设备…"
          aria-label="搜索设备"
          value={query}
          onValueChange={setQuery}
          className={cn(asSheet && "h-11 text-[16px]")}
        />
      )}
      {title && <MenuLabel>{title}</MenuLabel>}
      {showAll && (
        <MenuItem
          icon={<Layers />}
          checked={value === "all"}
          trailing={<span className="text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) tabular-nums">{total}</span>}
          onSelect={onSelect && (() => onSelect("all"))}
        >
          全部设备
        </MenuItem>
      )}
      {searchable && !showAll && shown.length === 0 && (
        <div className={cn("px-2 py-1.5 text-(--cw-pi-text-secondary)", asSheet ? "text-[13px]" : "text-(length:--cw-text-sm)")}>没有匹配的设备</div>
      )}
      {shown.map((device) => (
        <MenuItem
          key={device.id}
          data-pi-device={device.id}
          icon={<PiPlatformIcon platform={device.platform} size={16} className="text-(--cw-icon-fg)" />}
          subtitle={<span className="text-(--cw-pi-text-secondary)">{piDeviceStatusText(device, now)}</span>}
          checked={value === device.id}
          trailing={
            <span className="text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) tabular-nums">{counts[device.id] ?? 0} 个会话</span>
          }
          className={cn(!device.online && "[&_[data-slot=menu-item-label]]:text-(--cw-text-2)")}
          onSelect={onSelect && (() => onSelect(device.id))}
        >
          {device.name}
        </MenuItem>
      ))}
      {footer != null && (
        <>
          <MenuSeparator />
          {footer}
        </>
      )}
    </MenuSurface>
  )
}
