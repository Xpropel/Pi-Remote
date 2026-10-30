/**
 * 设置页 v2 · 共享原子组件。
 *
 * 所有视觉类名以 `settings-` 开头，颜色只消费 tokens.css 的 `--st-*`。
 * 状态口径（设计册第 2 节）：
 *   ● existing / ○ local：正常可操作；local 的持久化由 useSettings() 的 act 负责。
 *   ◐ bridge：只读形态 + 「需扩展桥」徽标，写入控件禁用。
 *   ◌ reserved：不可用形态 + 「设计预留」徽标。
 * 这里不读 relay、不读 storage，也不决定业务文案。
 */
import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import {
  Activity,
  Bell,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Info,
  Keyboard,
  LockKeyhole,
  Monitor,
  Palette,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react"
import {
  SETTINGS_PAGE_META,
  SETTINGS_STATUS_BADGE,
  settingsItemInert,
  type SettingsIconName,
  type SettingsItemStatus,
  type SettingsPageId,
} from "./types.ts"
import { nextEnabledOptionIndex, radioArrowStep } from "./radioNav.ts"

const ICONS: Record<SettingsIconName, LucideIcon> = {
  SlidersHorizontal,
  Cpu,
  ShieldCheck,
  Puzzle,
  Palette,
  Monitor,
  Bell,
  Keyboard,
  LockKeyhole,
  Activity,
  Info,
}

export function SettingsIcon({ name, size = 15 }: { name: SettingsIconName; size?: number }) {
  const Icon = ICONS[name]
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" className="settings-icon" />
}

/**
 * 单选组的方向键：←/↑ 上一项、→/↓ 下一项（循环、跳过 disabled），选中与焦点一起移动。
 * Space 不拦，仍走 button 的原生点击；inert 组直接不响应。
 */
function handleRadioArrow<T extends string>(
  event: ReactKeyboardEvent<HTMLElement>,
  options: readonly { value: T; disabled?: boolean }[],
  value: T | null,
  blocked: boolean,
  onChange?: (value: T) => void,
): void {
  const step = radioArrowStep(event.key)
  if (!step || blocked) return
  const current = options.findIndex((option) => option.value === value)
  const next = nextEnabledOptionIndex(options, current, step)
  if (next < 0) return
  event.preventDefault()
  const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  buttons[next]?.focus()
  if (!options[next]?.disabled) onChange?.(options[next].value)
}

/* ------------------------------------------------------------------ */
/* 结构                                                                */
/* ------------------------------------------------------------------ */

export function SettingsPageTitle({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <header className="settings-page-head">
      <h1 className="settings-page-title">{title}</h1>
      {note ? <p className="settings-page-note">{note}</p> : null}
    </header>
  )
}

export function SettingsGroup({
  label,
  description,
  first = false,
  children,
}: {
  label?: string
  description?: ReactNode
  first?: boolean
  children: ReactNode
}) {
  return (
    <section className={first ? "settings-group settings-group--first" : "settings-group"}>
      {label ? <h2 className="settings-group-label">{label}</h2> : null}
      <div className="settings-card">{children}</div>
      {description ? <p className="settings-group-description">{description}</p> : null}
    </section>
  )
}

export function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="settings-note">{children}</p>
}

/** 返回按钮（左栏「返回会话」）；href 语义由宿主决定，这里只发 onClick。 */
export function SettingsBackButton({ label = "返回会话", onClick }: { label?: string; onClick: () => void }) {
  return (
    <button type="button" className="settings-back" onClick={onClick}>
      <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" className="settings-back-icon" />
      <span>{label}</span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 状态徽标                                                            */
/* ------------------------------------------------------------------ */

export function SettingsStatusBadge({ status }: { status?: SettingsItemStatus }) {
  if (!status) return null
  const label = SETTINGS_STATUS_BADGE[status]
  if (!label) return null
  return (
    <span className={`settings-badge settings-badge--${status}`} data-settings-badge={status}>
      {label}
    </span>
  )
}

function RowTitle({ title, status }: { title: ReactNode; status?: SettingsItemStatus }) {
  return (
    <span className="settings-row-title">
      <span className="settings-row-title-text">{title}</span>
      <SettingsStatusBadge status={status} />
    </span>
  )
}

function RowCopy({ title, description, status }: { title: ReactNode; description?: ReactNode; status?: SettingsItemStatus }) {
  return (
    <span className="settings-row-grow">
      <RowTitle title={title} status={status} />
      {description ? <span className="settings-row-description">{description}</span> : null}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 行                                                                  */
/* ------------------------------------------------------------------ */

export interface SettingsRowProps {
  title: ReactNode
  description?: ReactNode
  status?: SettingsItemStatus
  disabled?: boolean
  children?: ReactNode
  className?: string
}

/** 标准行：左标题 / 说明，右控件。◐ / ◌ 行自动算 inert 并加徽标。 */
export function SettingsRow({ title, description, status, disabled, children, className }: SettingsRowProps) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className={className ? `settings-row ${className}` : "settings-row"}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <RowCopy title={title} description={description} status={status} />
      {children ? (
        <span className="settings-row-controls" inert={inert || undefined}>
          {children}
        </span>
      ) : null}
    </div>
  )
}

/** 只读信息行：供 ◐（默认需扩展桥）与 ● 的展示态直接使用。 */
export function SettingsReadOnlyRow({
  title,
  description,
  value,
  status = "bridge",
}: {
  title: ReactNode
  description?: ReactNode
  value: ReactNode
  status?: SettingsItemStatus
}) {
  return (
    <SettingsRow title={title} description={description} status={status}>
      <span className="settings-value">{value}</span>
    </SettingsRow>
  )
}

/** 整行动作（chevron）：用于「重新配对」「连接诊断」等入口。 */
export function SettingsActionRow({
  title,
  description,
  status,
  disabled,
  onClick,
  value,
}: {
  title: ReactNode
  description?: ReactNode
  status?: SettingsItemStatus
  disabled?: boolean
  onClick?: () => void
  value?: ReactNode
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <button
      type="button"
      className="settings-row settings-row--action"
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
      disabled={inert}
      onClick={() => {
        if (!inert) onClick?.()
      }}
    >
      <RowCopy title={title} description={description} status={status} />
      <span className="settings-row-controls">
        {value ? <span className="settings-value">{value}</span> : null}
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="settings-chevron" />
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 表单控件                                                            */
/* ------------------------------------------------------------------ */

export function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange?: (checked: boolean) => void
  /** 可访问名称；视觉名称在行标题里。 */
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={checked ? "settings-switch is-on" : "settings-switch"}
      onClick={() => {
        if (!disabled) onChange?.(!checked)
      }}
    >
      <span className="settings-switch-thumb" aria-hidden="true" />
    </button>
  )
}

export interface SettingsOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export function SettingsRadioGroup<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
  status,
}: {
  label: string
  description?: ReactNode
  value: T | null
  options: readonly SettingsOption<T>[]
  onChange?: (value: T) => void
  disabled?: boolean
  status?: SettingsItemStatus
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className="settings-row settings-row--stack"
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <RowCopy title={label} description={description} status={status} />
      <div
        className="settings-radio-group"
        role="radiogroup"
        aria-label={label}
        inert={inert || undefined}
        onKeyDown={(event) => handleRadioArrow(event, options, value, inert, onChange)}
      >
        {options.map((option) => {
          const on = option.value === value
          const off = inert || option.disabled
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={off}
              className={on ? "settings-radio is-on" : "settings-radio"}
              onClick={() => {
                if (!off) onChange?.(option.value)
              }}
            >
              <span className="settings-radio-ring" aria-hidden="true" />
              <span className="settings-radio-label">{option.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function SettingsInlineRadio<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
  status,
}: {
  label: string
  description?: ReactNode
  value: T | null
  options: readonly SettingsOption<T>[]
  onChange?: (value: T) => void
  disabled?: boolean
  status?: SettingsItemStatus
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <SettingsRow title={label} description={description} status={status} disabled={disabled}>
      <span
        className="settings-inline-options"
        role="radiogroup"
        aria-label={label}
        onKeyDown={(event) => handleRadioArrow(event, options, value, inert, onChange)}
      >
        {options.map((option) => {
          const on = option.value === value
          const off = inert || option.disabled
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={off}
              className={on ? "settings-inline-option is-on" : "settings-inline-option"}
              onClick={() => {
                if (!off) onChange?.(option.value)
              }}
            >
              <span className="settings-inline-ring" aria-hidden="true" />
              <span>{option.label}</span>
            </button>
          )
        })}
      </span>
    </SettingsRow>
  )
}

export function SettingsSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  /** 控件可访问名称；视觉分组标题常由 SettingsGroup 提供。 */
  label: string
  value: T
  options: readonly (SettingsOption<T> & { icon?: SettingsIconName })[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      className="settings-segmented"
      role="radiogroup"
      aria-label={label}
      data-settings-segmented=""
      onKeyDown={(event) => handleRadioArrow(event, options, value, disabled === true, onChange)}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={typeof option.label === "string" ? option.label : undefined}
            disabled={disabled || option.disabled}
            className={on ? "settings-segment is-on" : "settings-segment"}
            onClick={() => {
              if (!disabled && !option.disabled && !on) onChange(option.value)
            }}
          >
            {option.icon ? <SettingsIcon name={option.icon} size={13.5} /> : null}
            <span>{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function SettingsSelect<T extends string>({
  label,
  description,
  value,
  options,
  groups,
  onChange,
  disabled,
  status,
}: {
  label: string
  description?: ReactNode
  value: T
  options: readonly SettingsOption<T>[]
  /** Optional grouped options, rendered as <optgroup> after the flat ones
   *  (F7: the default-model select groups hundreds of models by provider). */
  groups?: readonly { label: string; options: readonly SettingsOption<T>[] }[]
  onChange?: (value: T) => void
  disabled?: boolean
  status?: SettingsItemStatus
}) {
  const inert = settingsItemInert(status, disabled)
  const renderOption = (option: SettingsOption<T>) => (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  )
  return (
    <SettingsRow title={label} description={description} status={status} disabled={disabled}>
      <span className="settings-select-wrap">
        <select
          className="settings-select"
          aria-label={label}
          value={value}
          disabled={inert}
          onChange={(event) => {
            if (!inert) onChange?.(event.target.value as T)
          }}
        >
          {options.map(renderOption)}
          {groups?.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map(renderOption)}
            </optgroup>
          ))}
        </select>
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" className="settings-select-chevron" />
      </span>
    </SettingsRow>
  )
}

export function SettingsSlider({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  status,
  lowLabel,
  highLabel,
}: {
  label: string
  description?: ReactNode
  value: number
  min: number
  max: number
  step?: number
  onChange?: (value: number) => void
  disabled?: boolean
  status?: SettingsItemStatus
  lowLabel?: string
  highLabel?: string
}) {
  const inert = settingsItemInert(status, disabled)
  const safeMin = Math.min(min, max)
  const safeMax = Math.max(min, max)
  const clamped = Math.min(safeMax, Math.max(safeMin, value))
  const percent = safeMax === safeMin ? 0 : ((clamped - safeMin) / (safeMax - safeMin)) * 100
  const style = { "--settings-slider-fill": `${percent}%` } as CSSProperties
  return (
    <div
      className="settings-row settings-row--stack"
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <RowCopy title={label} description={description} status={status} />
      <div className="settings-slider-row">
        {lowLabel ? <span className="settings-slider-end">{lowLabel}</span> : null}
        <input
          type="range"
          className="settings-slider"
          style={style}
          aria-label={label}
          min={safeMin}
          max={safeMax}
          step={step}
          value={clamped}
          disabled={inert}
          onChange={(event) => {
            if (!inert) onChange?.(Number(event.target.value))
          }}
        />
        {highLabel ? <span className="settings-slider-end">{highLabel}</span> : null}
        <output className="settings-slider-value">{clamped}</output>
      </div>
    </div>
  )
}

export interface SettingsColorOption {
  value: string
  label: string
  /** 调用方传 token 或设计册指定色值；本组件不改色。 */
  color: string
}

export function SettingsColorDots({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
  status,
}: {
  label?: string
  description?: ReactNode
  value: string | null
  options: readonly SettingsColorOption[]
  onChange?: (value: string) => void
  disabled?: boolean
  status?: SettingsItemStatus
}) {
  const inert = settingsItemInert(status, disabled)
  const control = (
    <span
      className="settings-color-dots"
      role="radiogroup"
      aria-label={label ?? "颜色"}
      onKeyDown={(event) => handleRadioArrow(event, options, value, inert, onChange)}
    >
      {options.map((option) => {
        const on = option.value === value
        const style = { "--settings-dot-color": option.color } as CSSProperties
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={typeof option.label === "string" ? option.label : undefined}
            title={option.label}
            disabled={inert}
            style={style}
            className={on ? "settings-color-dot is-on" : "settings-color-dot"}
            onClick={() => {
              if (!inert) onChange?.(option.value)
            }}
          />
        )
      })}
      {value ? <span className="settings-color-current">{options.find((option) => option.value === value)?.label ?? ""}</span> : null}
    </span>
  )
  if (!label) return control
  return (
    <SettingsRow title={label} description={description} disabled={disabled} status={status}>
      {control}
    </SettingsRow>
  )
}

/* ------------------------------------------------------------------ */
/* 键帽 / 快捷键录制                                                    */
/* ------------------------------------------------------------------ */

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS"])

function keycapOf(key: string): string {
  switch (key) {
    case " ":
      return "Space"
    case "Escape":
      return "Esc"
    case "ArrowUp":
      return "↑"
    case "ArrowDown":
      return "↓"
    case "ArrowLeft":
      return "←"
    case "ArrowRight":
      return "→"
    case "Backspace":
      return "⌫"
    case "Delete":
      return "⌦"
    case "CapsLock":
      return "Caps Lock"
    default:
      return key.length === 1 ? key.toUpperCase() : key
  }
}

function chordOf(event: React.KeyboardEvent<HTMLButtonElement>): string[] {
  if (MODIFIER_KEYS.has(event.key)) return []
  const keys: string[] = []
  if (event.metaKey) keys.push("⌘")
  if (event.ctrlKey) keys.push("Ctrl")
  if (event.altKey) keys.push("⌥")
  if (event.shiftKey) keys.push("⇧")
  const key = keycapOf(event.key)
  if (key) keys.push(key)
  return keys.slice(0, 4)
}

export function SettingsKeycaps({ keys }: { keys: readonly string[] }) {
  return (
    <span className="settings-keycaps">
      {keys.map((key, index) => (
        <kbd className="settings-keycap" key={`${key}-${index}`}>
          {key}
        </kbd>
      ))}
    </span>
  )
}

/**
 * 点一下开始录制，再按组合键替换；Esc 也按字面记录（不再取消），
 * 取消录制点自身 / 失焦即可。事件不冒泡给设置页或宿主快捷键层。
 */
export function SettingsShortcutCapture({
  label,
  keys,
  onChange,
  disabled,
}: {
  label: string
  keys: readonly string[]
  onChange?: (keys: string[]) => void
  disabled?: boolean
}) {
  const [recording, setRecording] = useState(false)
  return (
    <button
      type="button"
      className={recording ? "settings-keycap-capture is-recording" : "settings-keycap-capture"}
      aria-label={recording ? "按下新的快捷键组合" : `${label}，点击改键`}
      aria-pressed={recording}
      disabled={disabled}
      onClick={() => {
        if (!disabled) setRecording((value) => !value)
      }}
      onBlur={() => setRecording(false)}
      onKeyDown={(event) => {
        if (!recording) return
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          setRecording(false)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const chord = chordOf(event)
        if (chord.length === 0) return
        onChange?.(chord)
        setRecording(false)
      }}
    >
      {recording ? <span className="settings-keycap-recording">按下新键…</span> : <SettingsKeycaps keys={keys} />}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 元信息                                                              */
/* ------------------------------------------------------------------ */

export function SettingsStatusDot({ tone }: { tone: "online" | "offline" | "waiting" | "error" }) {
  return <span className={`settings-dot settings-dot--${tone}`} aria-hidden="true" />
}

export function SettingsPlaceholder({ page }: { page: SettingsPageId }) {
  const meta = SETTINGS_PAGE_META[page]
  return (
    <div className="settings-page settings-placeholder" data-settings-placeholder={page}>
      <SettingsPageTitle title={meta.label} />
      <SettingsGroup label="施工状态" first>
        <SettingsRow title="本页骨架已就位" description="内容按设计稿在后续阶段实现，已预留组件、状态与持久化接口。" />
      </SettingsGroup>
    </div>
  )
}
