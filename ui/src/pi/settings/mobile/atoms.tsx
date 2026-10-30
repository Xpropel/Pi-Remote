/**
 * 手机端设置 · 触控原子。
 *
 * 与桌面共享状态口径（◐ 只读 +「需扩展桥」/ ◌ 不可用 +「设计预留」）与部分原子
 * （SettingsStatusBadge / SettingsStatusDot / SettingsKeycaps / SettingsShortcutCapture），
 * 但布局按手机重做：单列全宽、行高 ≥44、开关/分段/选项行都是触控尺寸。
 *
 * 类名统一 `sm-` 前缀；颜色只消费 --st-*，不写死颜色。
 */
import type { ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"
import { settingsItemInert, type SettingsItemStatus } from "../types.ts"
import { SettingsStatusBadge, SettingsStatusDot } from "../ui.tsx"

/* ------------------------------------------------------------------ */
/* 结构                                                                */
/* ------------------------------------------------------------------ */

export function MobilePageBody({ children, page }: { children: ReactNode; page: string }) {
  return (
    <div className="sm-page" data-sm-page={page}>
      {children}
    </div>
  )
}

/** 分组：标题在卡片外，卡片本身是圆角 14 的单列容器。 */
export function MobileGroup({
  label,
  description,
  footnote,
  badge,
  children,
  stacked = false,
}: {
  label?: string
  description?: ReactNode
  footnote?: ReactNode
  /** 整组同一状态（如整组只读/预留）时，在分组标题旁标一次，避免每行重复。 */
  badge?: SettingsItemStatus
  children: ReactNode
  /** true 时不包卡片，子项自己就是卡片（例如界面风格三卡 / 首页分组）。 */
  stacked?: boolean
}) {
  return (
    <section className="sm-group">
      {label ? (
        <h2 className="sm-group-label">
          <span>{label}</span>
          <SettingsStatusBadge status={badge} />
        </h2>
      ) : null}
      {description ? <p className="sm-group-description">{description}</p> : null}
      {stacked ? <div className="sm-group-stack">{children}</div> : <div className="sm-card">{children}</div>}
      {footnote ? <p className="sm-group-footnote">{footnote}</p> : null}
    </section>
  )
}

/** 单独一张卡（与分组卡片同款外观，用于首页 / 统计卡 / 提示框）。 */
export function MobileCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `sm-card ${className}` : "sm-card"}>{children}</div>
}

export function MobileNote({ children }: { children: ReactNode }) {
  return <p className="sm-note">{children}</p>
}

/** 带边框的说明框（快捷键页顶部 / 审批口径框）。 */
export function MobileBanner({ children }: { children: ReactNode }) {
  return <div className="sm-banner">{children}</div>
}

/* ------------------------------------------------------------------ */
/* 行                                                                  */
/* ------------------------------------------------------------------ */

function RowTitle({ title, status }: { title: ReactNode; status?: SettingsItemStatus }) {
  return (
    <span className="sm-row-title">
      <span className="sm-row-title-text">{title}</span>
      <SettingsStatusBadge status={status} />
    </span>
  )
}

function RowCopy({ title, description, status }: { title: ReactNode; description?: ReactNode; status?: SettingsItemStatus }) {
  return (
    <span className="sm-row-copy">
      <RowTitle title={title} status={status} />
      {description ? <span className="sm-row-description">{description}</span> : null}
    </span>
  )
}

export interface MobileRowProps {
  title: ReactNode
  description?: ReactNode
  status?: SettingsItemStatus
  disabled?: boolean
  children?: ReactNode
  className?: string
}

/** 标准行：左标题/说明，右控件；◐ / ◌ 自动 inert 并加徽标。 */
export function MobileRow({ title, description, status, disabled, children, className }: MobileRowProps) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className={className ? `sm-row ${className}` : "sm-row"}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <RowCopy title={title} description={description} status={status} />
      {children ? (
        <span className="sm-row-control" inert={inert || undefined}>
          {children}
        </span>
      ) : null}
    </div>
  )
}

/** 只读信息行（● 展示态 / ◐ 只读值）。 */
export function MobileReadOnlyRow({
  title,
  description,
  value,
  status,
}: {
  title: ReactNode
  description?: ReactNode
  value: ReactNode
  status?: SettingsItemStatus
}) {
  return (
    <MobileRow title={title} description={description} status={status}>
      <span className="sm-value">{value}</span>
    </MobileRow>
  )
}

/** 整行动作（chevron）。 */
export function MobileActionRow({
  title,
  description,
  status,
  disabled,
  onClick,
  value,
  leading,
  danger,
}: {
  title: ReactNode
  description?: ReactNode
  status?: SettingsItemStatus
  disabled?: boolean
  onClick?: () => void
  value?: ReactNode
  leading?: ReactNode
  danger?: boolean
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <button
      type="button"
      className={danger ? "sm-row sm-row--action sm-row--danger" : "sm-row sm-row--action"}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
      disabled={inert}
      onClick={() => {
        if (!inert) onClick?.()
      }}
    >
      {leading ? <span className="sm-row-leading">{leading}</span> : null}
      <RowCopy title={title} description={description} status={status} />
      <span className="sm-row-control">
        {value ? <span className="sm-value">{value}</span> : null}
        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="sm-chevron" />
      </span>
    </button>
  )
}

/** 整行可点的开关行（开关本身也保留 role=switch 语义）。 */
export function MobileSwitchRow({
  title,
  description,
  checked,
  onChange,
  status,
  disabled,
  switchLabel,
}: {
  title: ReactNode
  description?: ReactNode
  checked: boolean
  onChange?: (checked: boolean) => void
  status?: SettingsItemStatus
  disabled?: boolean
  switchLabel?: string
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <MobileRow title={title} description={description} status={status} disabled={disabled}>
      <MobileSwitch
        checked={checked}
        disabled={inert}
        label={switchLabel ?? (typeof title === "string" ? title : "开关")}
        onChange={inert ? undefined : onChange}
      />
    </MobileRow>
  )
}

/* ------------------------------------------------------------------ */
/* 控件                                                                */
/* ------------------------------------------------------------------ */

export function MobileSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange?: (checked: boolean) => void
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
      className={checked ? "sm-switch is-on" : "sm-switch"}
      onClick={() => {
        if (!disabled) onChange?.(!checked)
      }}
    >
      <span className="sm-switch-track" aria-hidden="true">
        <span className="sm-switch-thumb" />
      </span>
    </button>
  )
}

export interface MobileOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

/** 全宽分段控件（明暗 / 字号 / 密度 / 发送键 / 归档窗口…）。 */
export function MobileSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  compact = false,
}: {
  label: string
  value: T
  options: readonly MobileOption<T>[]
  onChange?: (value: T) => void
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <div className={compact ? "sm-segmented sm-segmented--compact" : "sm-segmented"} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const on = option.value === value
        const off = disabled || option.disabled
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={typeof option.label === "string" ? option.label : undefined}
            disabled={off}
            className={on ? "sm-segment is-on" : "sm-segment"}
            onClick={() => {
              if (!off && !on) onChange?.(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** 字段行：标题 + 说明在卡片内上半，分段控件占满下半（设计稿「发送消息 / 字号」）。 */
export function MobileField<T extends string>({
  title,
  description,
  status,
  disabled,
  value,
  options,
  onChange,
  stacked,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  status?: SettingsItemStatus
  disabled?: boolean
  value?: T
  options?: readonly MobileOption<T>[]
  onChange?: (value: T) => void
  /** 控件与标题上下排（默认 true）；false 用于标题与控件同行的短字段。 */
  stacked?: boolean
  children?: ReactNode
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className={stacked === false ? "sm-field sm-field--inline" : "sm-field"}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
    >
      <RowCopy title={title} description={description} status={status} />
      <div className="sm-field-control" inert={inert || undefined}>
        {children ??
          (value !== undefined && options ? (
            <MobileSegmented label={typeof title === "string" ? title : "选项"} value={value} options={options} onChange={onChange} />
          ) : null)}
      </div>
    </div>
  )
}

/** 选项列表（单列整行可点；勾选或圆点标记）。 */
export function MobileOptionList<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  status,
  marker = "check",
}: {
  label: string
  value: T | null
  options: readonly { value: T; title: ReactNode; description?: ReactNode; disabled?: boolean }[]
  onChange?: (value: T) => void
  disabled?: boolean
  status?: SettingsItemStatus
  marker?: "check" | "radio"
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <div
      className={marker === "radio" ? "sm-options sm-options--radio" : "sm-options"}
      role="radiogroup"
      aria-label={label}
      data-settings-status={status}
      data-settings-inert={inert ? "true" : undefined}
      aria-disabled={inert || undefined}
      inert={inert || undefined}
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
            className={on ? "sm-option is-on" : "sm-option"}
            onClick={() => {
              if (!off && !on) onChange?.(option.value)
            }}
          >
            <span className="sm-option-copy">
              <span className="sm-option-title">{option.title}</span>
              {option.description ? <span className="sm-option-description">{option.description}</span> : null}
            </span>
            {marker === "radio" ? (
              <span className="sm-option-radio" aria-hidden="true">
                <span />
              </span>
            ) : on ? (
              <Check size={18} strokeWidth={2.2} aria-hidden="true" className="sm-option-check" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** 下拉选择（选项少的字段，保持设计稿的「值 + ›」形态）。 */
export function MobileSelect<T extends string>({
  label,
  value,
  options,
  groups,
  onChange,
  disabled,
  status,
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  /** Optional grouped options, rendered as <optgroup> after the flat ones
   *  (F7: the default-model select groups models by provider). */
  groups?: readonly { label: string; options: readonly { value: T; label: string }[] }[]
  onChange?: (value: T) => void
  disabled?: boolean
  status?: SettingsItemStatus
}) {
  const inert = settingsItemInert(status, disabled)
  return (
    <MobileRow title={label} status={status}>
      <span className="sm-select-wrap">
        <select
          className="sm-select"
          aria-label={label}
          value={value}
          disabled={inert}
          onChange={(event) => {
            if (!inert) onChange?.(event.target.value as T)
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {groups?.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" className="sm-chevron" />
      </span>
    </MobileRow>
  )
}

/* ------------------------------------------------------------------ */
/* 小件                                                                */
/* ------------------------------------------------------------------ */

export function MobileTag({ children }: { children: ReactNode }) {
  return <span className="sm-tag">{children}</span>
}

export function MobileValue({ children }: { children: ReactNode }) {
  return <span className="sm-value">{children}</span>
}

export function MobileStatusLine({ tone, children }: { tone: "online" | "offline" | "waiting" | "error"; children: ReactNode }) {
  return (
    <span className="sm-status-line">
      <SettingsStatusDot tone={tone} />
      {children}
    </span>
  )
}

/** 使用活动 / 统计卡（两列）。 */
export function MobileStatCard({
  label,
  value,
  unit,
  aside,
  delta,
}: {
  label: string
  value: ReactNode
  unit?: ReactNode
  aside?: ReactNode
  delta?: { text: string; dir: "up" | "down" | "flat" }
}) {
  return (
    <div className="sm-stat">
      <div className="sm-stat-head">
        <span className="sm-stat-label">{label}</span>
        {delta?.text ? <span className={`sm-delta sm-delta--${delta.dir}`}>{delta.text}</span> : aside}
      </div>
      <div className="sm-stat-value">
        <span className="sm-stat-number">{value}</span>
        {unit ? <span className="sm-stat-unit">{unit}</span> : null}
      </div>
    </div>
  )
}

/** 空态：诚实说明，不填示例数字。 */
export function MobileEmpty({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="sm-empty" role="status">
      <div className="sm-empty-title">{title}</div>
      {body ? <div className="sm-empty-body">{body}</div> : null}
    </div>
  )
}

/** 危险动作（移除设备 / 清除缓存）：红字但不预置确认。 */
export function MobileDangerAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="sm-danger-action" onClick={onClick}>
      {children}
    </button>
  )
}
