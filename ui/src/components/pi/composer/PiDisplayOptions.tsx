import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "@/components/kit"
import { Layers, Settings } from "@/components/kit/icons"
import { PiDeviceMenu, PiPlatformIcon, piDeviceStatusText, type PiDevice } from "@/components/pi/shared"
import { usePiMenuSurface, usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { DENSITY_OPTIONS, THEME_OPTIONS } from "./options"
import type { CPrefs } from "./types"
import { C_SECONDARY, SEGMENT_ITEM, SEGMENT_ITEM_PHONE, SEGMENT_ON, SEGMENT_TRACK, segmentTrackH, type CVariant } from "./styles"

export interface PiSegmentsProps {
  variant: CVariant
  label: string
  options: { value: string; label: string }[]
  value: string
  className?: string
  /** P4：点一段 */
  onValueChange?: (value: string) => void
}

/** 分段选择（主题、字号、工具显示；推断：Cursor 帧里没有分段控件） */
export function PiSegments({ variant, label, options, value, className, onValueChange }: PiSegmentsProps) {
  const phone = variant === "phone"
  return (
    <div role="radiogroup" aria-label={label} className={cn(SEGMENT_TRACK, segmentTrackH(variant), className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={cn(SEGMENT_ITEM, phone ? SEGMENT_ITEM_PHONE : "text-(length:--cw-text-sm)", o.value === value && SEGMENT_ON)}
          onClick={onValueChange ? () => onValueChange(o.value) : undefined}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}


export interface PiDisplayOptionsProps {
  variant: CVariant
  /** 当前偏好（设备筛选、分组、主题、工具显示） */
  prefs: CPrefs
  /** 设备筛选的候选（PiDeviceMenu） */
  devices: PiDevice[]
  /** 每台设备的会话数 */
  counts: Record<string, number>
  /** 设备行"窗口剩余 / N 分钟前"的时间基准 */
  now: number
  /** 作为 PiSheet 内容（手机）：去掉卡片外观 */
  bare?: boolean
  className?: string
  /** P4：true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** P4：改一项偏好（设备筛选、分组、主题、工具显示） */
  onPrefsChange?: (patch: Partial<CPrefs>) => void
  /** P4："全部设置…"（= ⌘,） */
  onOpenSettings?: () => void
}

/** 桌面锚定菜单里的设备筛选行（Radix Item，↑↓ 可达）：行样式同 PiDeviceMenu（图标 + 名称 + 灰字状态 + 行尾会话数，当前项 ✓） */
function DeviceFilterRows({ devices, counts, value, now, onSelect }: { devices: PiDevice[]; counts: Record<string, number>; value: string; now: number; onSelect: (value: string) => void }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const count = "text-(length:--cw-text-sm) text-(--cw-pi-text-secondary) tabular-nums"
  return (
    <>
      <MenuItem icon={<Layers />} checked={value === "all"} trailing={<span className={count}>{total}</span>} onSelect={() => onSelect("all")}>
        全部设备
      </MenuItem>
      {devices.map((device) => (
        <MenuItem
          key={device.id}
          data-pi-device={device.id}
          icon={<PiPlatformIcon platform={device.platform} size={16} className="text-(--cw-icon-fg)" />}
          subtitle={<span className="text-(--cw-pi-text-secondary)">{piDeviceStatusText(device, now)}</span>}
          checked={value === device.id}
          trailing={<span className={count}>{counts[device.id] ?? 0} 个会话</span>}
          className={cn(!device.online && "[&_[data-slot=menu-item-label]]:text-(--cw-text-2)")}
          onSelect={() => onSelect(device.id)}
        >
          {device.name}
        </MenuItem>
      ))}
    </>
  )
}

/**
 * 显示选项（K01 C03 H06；待用户确认 6）：账户区滑杆图标打开。设备筛选（PiDeviceMenu 的行样式，含"全部设备"）
 * —— 分组方式 —— 主题（分段）—— 工具显示（分段）—— 全部设置… ⌘,。打开后的内容整套推断。
 * 桌面宽 260，从滑杆上方弹出、左缘与左栏对齐；手机是 PiSheet"显示选项"的内容，行 48。
 * P4 可交互：桌面放进锚定菜单（PiMenu：设备 / 分组 / 全部设置… 是 Radix Item，↑↓ 可达、选中后关菜单；分段钮可点）；
 * 手机 sheet 里同一组项可点（选中后由调用方决定关不关 sheet）。
 */
export function PiDisplayOptions({ variant, prefs, devices, counts, now, bare, className, static: staticProp, onPrefsChange, onOpenSettings }: PiDisplayOptionsProps) {
  const isStatic = usePiStatic(staticProp)
  const surface = usePiMenuSurface()
  const phone = variant === "phone"
  const sheet = phone || bare
  const radix = !isStatic && !sheet && surface.kind !== "static"
  const change = isStatic ? undefined : onPrefsChange
  const setDevice = (value: string) => change?.({ deviceFilter: value })
  return (
    <MenuSurface
      {...(radix ? surface : undefined)}
      data-slot="pi-display-options"
      data-cw-id="pi-display-options"
      aria-label="显示选项"
      elevation="popover"
      className={cn(sheet ? "w-full bg-transparent p-0 shadow-none" : "w-[260px]", className)}
    >
      <MenuLabel className={C_SECONDARY}>设备</MenuLabel>
      {radix ? (
        <DeviceFilterRows devices={devices} counts={counts} value={prefs.deviceFilter} now={now} onSelect={setDevice} />
      ) : (
        <PiDeviceMenu devices={devices} counts={counts} value={prefs.deviceFilter} allowAll asSheet now={now} onSelect={change ? setDevice : undefined} />
      )}
      <MenuSeparator />
      <MenuLabel className={C_SECONDARY}>分组</MenuLabel>
      <MenuItem checked={prefs.grouping === "device"} onSelect={change && (() => change({ grouping: "device" }))}>
        设备与目录
      </MenuItem>
      <MenuItem checked={prefs.grouping === "flat"} onSelect={change && (() => change({ grouping: "flat" }))}>
        不分组（按最近活动）
      </MenuItem>
      <MenuSeparator />
      <MenuLabel className={C_SECONDARY}>主题</MenuLabel>
      <div className="px-2 pb-2">
        <PiSegments
          variant={variant}
          label="主题"
          options={THEME_OPTIONS}
          value={prefs.theme}
          onValueChange={change && ((v) => change({ theme: v as CPrefs["theme"] }))}
        />
      </div>
      <MenuLabel className={C_SECONDARY}>工具显示</MenuLabel>
      <div className="px-2 pb-2">
        <PiSegments
          variant={variant}
          label="工具显示"
          options={DENSITY_OPTIONS}
          value={prefs.density}
          onValueChange={change && ((v) => change({ density: v as CPrefs["density"] }))}
        />
      </div>
      <MenuSeparator />
      <MenuItem icon={<Settings />} shortcut={phone ? undefined : "⌘,"} chevron={phone} onSelect={isStatic ? undefined : onOpenSettings}>
        全部设置…
      </MenuItem>
    </MenuSurface>
  )
}
