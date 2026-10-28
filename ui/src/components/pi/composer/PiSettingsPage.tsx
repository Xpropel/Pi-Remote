import { useEffect, useRef, useState, type ReactNode } from "react"
import { CategoryNav as MarketplaceNav } from "@/components/kit/sidebar/CategoryNav"
import { Switch, TextSelector } from "@/components/kit"
import { Check, ChevronRight, Play } from "@/components/kit/icons"
import { PiCopyField, PiPlatformIcon, piDeviceStatusText, type PiDevice } from "@/components/pi/shared"
import { UsageActivityPage, type UsageActivityRelayLike } from "@/pi/usage"
import { MobileNavSetting, type PiMobileNavMode } from "@/pi/mobile"
import { usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import { PI_UI_VARIANT_LIST } from "@/pi/variants/types"
import { DELIVERY_LABEL, DENSITY_OPTIONS, FONT_OPTIONS, THEME_OPTIONS } from "./options"
import type { CPrefs } from "./types"
import { PiCMenu } from "./PiCMenu"
import { PiDeliveryOptions } from "./PiComposerStatusRow"
import { PiSegments } from "./PiDisplayOptions"
import { C_ERROR, C_SECONDARY, TOUCH_44, type CVariant } from "./styles"

/** P10：使用活动页跟随应用主题——镜像 <html data-pi-theme>，并在挂载后立即同步一次（避免挂载顺序竞态） */
function usePiUsageTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (typeof document !== "undefined" && document.documentElement.getAttribute("data-pi-theme") === "light" ? "light" : "dark")
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const sync = () => setTheme(read())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pi-theme"] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** 设置分类（H01）：外观 / 对话 / 通知与声音 / 设备 / 连接与帮助 / 关于 */
export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "外观" },
  { id: "conversation", label: "对话" },
  { id: "notify", label: "通知与声音" },
  { id: "devices", label: "设备" },
  { id: "mobile", label: "移动端" },
  { id: "usage", label: "使用活动" },
  { id: "connection", label: "连接与帮助" },
  { id: "about", label: "关于" },
] as const

/** 导航分组显式 id（spec §7.2：个人组 6 项，使用活动在组末；不按数组 slice，后续加 section 不会错位） */
const PERSONAL_NAV_IDS = ["appearance", "conversation", "notify", "devices", "mobile", "usage", "connection"] as const
const SUPPORT_NAV_IDS = ["about"] as const
const SECTION_LABEL: Record<string, string> = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label]))

/** 设置页里的动作（P4 可交互：整行可点的导航 / 动作行、试听按钮） */
export type PiSettingsAction = "pair" | "reconnect" | "help" | "logout" | "sound-done" | "sound-fail" | `device:${string}`

/** 当前密度的一句说明（§1.5 的三档） */
const DENSITY_HINT: Record<string, string> = {
  compact: "读取和查看合并成一行，终端卡只留头行",
  balanced: "读取一行灰字，命令是终端卡，改动是 diff 卡",
  detailed: "读取行可展开看内容，终端卡露出最后 10 行",
}

/**
 * N10（design §4.4"开关 51×31 → 整行可点"）：开关的点击区撑满整行（行本来就是 <label>，点字也会切换；这里让命中区也是开关本身）。
 * 开关（relative）的 ::after 垂直居中、高 = 行的最小高（手机 52、桌面 44；开关在行里垂直居中，所以不会伸进相邻的行），
 * 向右到行的右内距、向左伸到行外由卡片（overflow-hidden）裁掉。读屏和键盘仍然只有开关这一个控件，视觉不变。
 * 不能给行加 relative：圆角裁切的卡片里，定位的行会换一种文字栅格化，L1 有 1–3k 像素的字形差（P4 c 线实测）。
 */
function switchFillRow(variant: CVariant): string {
  return cn(
    "cursor-pointer after:absolute after:top-1/2 after:-right-4 after:-left-[600px] after:-translate-y-1/2 after:content-['']",
    variant === "phone" ? "after:h-[52px]" : "after:h-11",
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-surface)">
      {children}
    </div>
  )
}

function Group({ variant, id, title, children, note }: { variant: CVariant; id: string; title: string; children: ReactNode; note?: ReactNode }) {
  const phone = variant === "phone"
  return (
    <section data-settings-section={id} aria-label={title} className={phone ? "mt-6 first:mt-3" : "mt-7 first:mt-0"}>
      <h2 className={cn("m-0 mb-2 px-1 font-normal", phone ? "text-[13px] leading-[18px]" : "text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>
        {title}
      </h2>
      <Card>{children}</Card>
      {note != null && (
        <p className={cn("m-0 mt-2 px-1", phone ? "text-[13px] leading-[18px]" : "text-(length:--cw-text-sm) leading-[17px]", C_SECONDARY)}>{note}</p>
      )}
    </section>
  )
}

function Row({
  variant,
  label,
  hint,
  control,
  stacked,
  danger,
  toggle,
  onClick,
  radio,
}: {
  variant: CVariant
  label: ReactNode
  hint?: ReactNode
  control?: ReactNode
  /** 控件换到下一行（手机上的分段控件） */
  stacked?: boolean
  danger?: boolean
  /** 开关行：整行是 <label>，开关的点击区撑满整行（N10，§4.4"开关整行可点"） */
  toggle?: boolean
  /** P4 可交互：整行是一个按钮（导航行、动作行、单选行） */
  onClick?: () => void
  /** P4 可交互：单选行（role="radio"，aria-checked） */
  radio?: { checked: boolean }
}) {
  const phone = variant === "phone"
  const Tag = onClick ? "button" : toggle ? "label" : "div"
  return (
    <Tag
      {...(onClick
        ? { type: "button" as const, onClick, role: radio ? "radio" : undefined, "aria-checked": radio ? radio.checked : undefined }
        : {})}
      className={cn(
        "flex min-w-0 gap-3 border-b border-solid border-(--cw-divider-soft) px-4 last:border-b-0",
        stacked ? "flex-col items-stretch py-3" : "items-center",
        !stacked && (phone ? "min-h-[52px] py-2" : "min-h-11 py-2"),
        toggle && "cursor-pointer select-none",
        onClick && "w-full text-left hover:bg-(--cw-row-hover)",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn(phone ? "text-[15px] leading-5" : "text-(length:--cw-text-md) leading-(--cw-leading-tight)", danger ? C_ERROR : "text-(--cw-text)")}>
          {label}
        </span>
        {hint != null && (
          <span className={cn(phone ? "text-[13px] leading-[18px]" : "text-(length:--cw-text-sm) leading-[17px]", "mt-0.5", C_SECONDARY)}>{hint}</span>
        )}
      </span>
      {control != null && <span className={cn("flex shrink-0 items-center", stacked && "w-full")}>{control}</span>}
    </Tag>
  )
}

/** 单选行（H03：当前项行尾 ✓，选中只靠素勾）；可交互时整行是 role="radio" 的按钮 */
function RadioRow({ variant, label, checked, onSelect }: { variant: CVariant; label: string; checked?: boolean; onSelect?: () => void }) {
  return (
    <Row
      variant={variant}
      label={label}
      control={checked ? <Check aria-hidden strokeWidth={1.75} className="size-4 text-(--cw-icon-fg)" /> : null}
      onClick={onSelect}
      radio={onSelect ? { checked: !!checked } : undefined}
    />
  )
}

function TextButton({ variant, children, icon, onClick }: { variant: CVariant; children: ReactNode; icon?: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-(--cw-radius-button) border border-solid border-(--cw-border) bg-(--cw-surface) px-3 text-(--cw-text) hover:bg-(--cw-row-hover)",
        variant === "phone" ? "h-11 flex-1 justify-center text-[15px]" : "h-7 text-(length:--cw-text-sm)",
      )}
    >
      {icon}
      {children}
    </button>
  )
}

/** 设置正文（六个分组，桌面与手机共用；手机分类导航变成页面里的分组） */
/** 设置页的数据：偏好、设备（「设备」一节）、服务器地址（「连接与帮助」）、相对时间基准 */
export interface PiSettingsData {
  prefs: CPrefs
  devices: PiDevice[]
  relayHost: string
  now: number
  /** P4：true = 静态态；不传时取 PiStaticContext */
  static?: boolean
  /** P4 可交互：改一项偏好（分段、开关、单选、忙时投递） */
  onPrefsChange?: (patch: Partial<CPrefs>) => void
  /** P4 可交互：导航 / 动作行、试听按钮 */
  onAction?: (action: PiSettingsAction) => void
  /* ---------- P5 的可选字段（容器给真实数据；画廊屏不传，保持冻结版的样子） ---------- */
  /** relay 的协议版本（serverProto）；不传 = 画廊屏的 v4，null = "—" */
  proto?: number | null
  /** "版本"一行的值；不传 = 画廊屏的示例，null = 没有来源，整行不出（§1.9） */
  version?: string | null
  /** "关于"一节的脚注；不传 = 画廊屏的写法 */
  aboutNote?: string
  /** 退出登录已经点过一次（A02：第一次点变「再点一次退出」，第二次才退出） */
  logoutArmed?: boolean
  /** P10：使用活动页的设备 id（relay.selectedDeviceId；缺省由共享页自行取默认） */
  deviceId?: string
  /** P10：relay 句柄（usage 真实数据 getUsage/server.caps/authed；缺省用共享页内置数据源） */
  usageRelay?: UsageActivityRelayLike
  /** P11：移动端交互 UI 偏好（全局 prefs.mobileNav；仅移动断点生效） */
  mobileNav?: PiMobileNavMode
  onMobileNavChange?: (mode: PiMobileNavMode) => void
}
export function PiSettingsSections({
  variant,
  prefs,
  devices,
  relayHost,
  now,
  static: staticProp,
  onPrefsChange,
  onAction,
  proto,
  version,
  aboutNote,
  logoutArmed,
  deviceId,
  usageRelay,
  mobileNav,
  onMobileNavChange,
}: { variant: CVariant } & PiSettingsData) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const usageTheme = usePiUsageTheme()
  const segW = phone ? "w-full" : "w-[228px]"
  const change = isStatic ? undefined : onPrefsChange
  const act = isStatic || !onAction ? undefined : (action: PiSettingsAction) => () => onAction(action)
  const toggle = (key: "dialogRemote" | "sound") =>
    change ? { checked: prefs[key], onCheckedChange: (v: boolean) => change({ [key]: v }) } : { defaultChecked: prefs[key] }
  const busySelector = (
    <TextSelector
      tone="primary"
      size={phone ? "lg" : "md"}
      label={DELIVERY_LABEL[prefs.busyDelivery]}
      aria-label={change ? `pi 忙的时候发消息：${DELIVERY_LABEL[prefs.busyDelivery]}，切换` : undefined}
      className={cn(phone && TOUCH_44)}
    />
  )
  return (
    <div data-slot="pi-settings-sections" className="flex flex-col">
      <Group variant={variant} id="appearance" title="外观">
        {/*
          P1 架构线（PI-UI-REFS）：三张「界面」卡片 = 三套 UI 的切换入口（brief §架构契约 2）。
          选中即时生效（只写 prefs.ui：PiApp 换展示树，relay / room / 草稿不重建，不重连）。
          data-testid 固定为 pi-ui-variant-<id>（PI_UI_VARIANT_META.testId），验证线的 playwright 直接点它。
          静态态（画廊）没有 onPrefsChange，卡片只展示当前选中项、不可点。
        */}
        <Row
          variant={variant}
          label="界面"
          hint="三套设计各自独立；选中立即切换，不重连、不丢当前会话和草稿"
          stacked
          control={
            <div data-slot="pi-ui-variants" role="radiogroup" aria-label="界面" className="grid w-full grid-cols-3 gap-2">
              {PI_UI_VARIANT_LIST.map((item) => {
                const active = prefs.ui === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-testid={item.testId}
                    data-ui-variant={item.id}
                    onClick={change ? () => change({ ui: item.id }) : undefined}
                    className={cn(
                      "flex min-w-0 flex-col gap-1 rounded-(--cw-radius-button) border border-solid px-3 py-2 text-left",
                      active ? "border-(--cw-blue) bg-(--cw-chip-bg)" : "border-(--cw-border) bg-(--cw-surface)",
                      change ? "cursor-pointer hover:bg-(--cw-row-hover)" : "cursor-default",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-(length:--cw-text-md) text-(--cw-text)">{item.label}</span>
                      {active ? <Check aria-hidden strokeWidth={1.75} className="size-4 text-(--cw-blue)" /> : null}
                    </span>
                    <span className={cn("text-(length:--cw-text-sm) leading-[17px]", C_SECONDARY)}>{item.description}</span>
                  </button>
                )
              })}
            </div>
          }
        />
        <Row
          variant={variant}
          label="主题"
          hint={phone ? undefined : "跟随系统时，浅色 / 深色随电脑或手机的设置切换"}
          stacked={phone}
          control={
            <PiSegments
              variant={variant}
              label="主题"
              options={THEME_OPTIONS}
              value={prefs.theme}
              className={segW}
              onValueChange={change && ((v) => change({ theme: v as CPrefs["theme"] }))}
            />
          }
        />
        <Row
          variant={variant}
          label="字号"
          stacked={phone}
          control={
            <PiSegments
              variant={variant}
              label="字号"
              options={FONT_OPTIONS}
              value={prefs.fontSize}
              className={segW}
              onValueChange={change && ((v) => change({ fontSize: v as CPrefs["fontSize"] }))}
            />
          }
        />
        <Row
          variant={variant}
          label="工具显示"
          hint={DENSITY_HINT[prefs.density]}
          stacked={phone}
          control={
            <PiSegments
              variant={variant}
              label="工具显示"
              options={DENSITY_OPTIONS}
              value={prefs.density}
              className={segW}
              onValueChange={change && ((v) => change({ density: v as CPrefs["density"] }))}
            />
          }
        />
      </Group>
      <Group variant={variant} id="conversation" title="对话">
        <Row
          variant={variant}
          label="pi 忙的时候发消息"
          hint="默认的投递方式；输入框下面也能临时改"
          control={
            change ? (
              <PiCMenu trigger={busySelector} side="bottom" align="end" sideOffset={6}>
                <PiDeliveryOptions variant={variant} value={prefs.busyDelivery} onValueChange={(v) => change({ busyDelivery: v })} />
              </PiCMenu>
            ) : (
              busySelector
            )
          }
        />
        <Row variant={variant} label="排队消息点「立即发送」时" hint="网页排的消息" />
        <RadioRow
          variant={variant}
          label="打断当前操作"
          checked={prefs.sendNow === "interrupt"}
          onSelect={change && (() => change({ sendNow: "interrupt" }))}
        />
        <RadioRow
          variant={variant}
          label="等当前工具结束"
          checked={prefs.sendNow === "after_tool"}
          onSelect={change && (() => change({ sendNow: "after_tool" }))}
        />
        <Row
          variant={variant}
          label="在网页上回答电脑上的确认框"
          hint="关掉后，确认框只能在电脑终端里回答"
          toggle
          control={
            <Switch
              tone="blue"
              size={phone ? "lg" : "sm"}
              {...toggle("dialogRemote")}
              aria-label="在网页上回答电脑上的确认框"
              className={switchFillRow(variant)}
            />
          }
        />
      </Group>
      <Group
        variant={variant}
        id="notify"
        title="通知与声音"
        note="页面不在前台时的系统通知由 relay 配置，这里不能开关。"
      >
        <Row
          variant={variant}
          label="完成提示音"
          hint="回合结束或出错时响一声；页面在前台时不响"
          toggle
          control={<Switch tone="blue" size={phone ? "lg" : "sm"} {...toggle("sound")} aria-label="完成提示音" className={switchFillRow(variant)} />}
        />
        <div className={cn("flex gap-2 px-4 py-2.5", phone && "py-3")}>
          <TextButton variant={variant} icon={<Play aria-hidden strokeWidth={1.5} className="size-3.5" />} onClick={act?.("sound-done")}>
            试听完成音
          </TextButton>
          <TextButton variant={variant} icon={<Play aria-hidden strokeWidth={1.5} className="size-3.5" />} onClick={act?.("sound-fail")}>
            试听失败音
          </TextButton>
        </div>
      </Group>
      <Group variant={variant} id="devices" title="设备">
        {devices.map((d) => (
          <Row
            key={d.id}
            variant={variant}
            label={
              <span className="inline-flex items-center gap-2">
                <PiPlatformIcon platform={d.platform} size={phone ? 18 : 16} className="text-(--cw-icon-fg)" />
                {d.name}
              </span>
            }
            hint={`${piDeviceStatusText(d, now)} · ${d.projects.length} 个允许目录`}
            control={<ChevronRight aria-hidden strokeWidth={1.5} className="size-4 text-(--cw-icon-fg)" />}
            onClick={act?.(`device:${d.id}`)}
          />
        ))}
        <Row
          variant={variant}
          label="配对新设备…"
          control={<ChevronRight aria-hidden strokeWidth={1.5} className="size-4 text-(--cw-icon-fg)" />}
          onClick={act?.("pair")}
        />
      </Group>
      {!isStatic ? (
        <Group variant={variant} id="mobile" title="移动端">
          <div className={phone ? "px-3 py-2" : "px-4 py-3"}>
            <MobileNavSetting value={mobileNav ?? "list"} onChange={(mode) => onMobileNavChange?.(mode)} disabled={!onMobileNavChange} />
          </div>
        </Group>
      ) : null}
      {!isStatic ? (
        <section
          data-settings-section="usage"
          data-pi-usage-host="cursor"
          data-pi-usage-surface="P10-USAGE-12-CW"
          aria-label="使用活动"
          className={phone ? "mt-6" : "mt-7"}
        >
          <UsageActivityPage deviceId={deviceId} relay={usageRelay} theme={usageTheme} />
        </section>
      ) : null}
      <Group variant={variant} id="connection" title="连接与帮助">
        <div className="px-4 py-3">
          <PiCopyField label="服务器" value={relayHost} />
        </div>
        <Row
          variant={variant}
          label="协议"
          control={<span className={cn("tabular-nums", C_SECONDARY)}>{proto === undefined ? "v4" : proto == null ? "—" : `v${proto}`}</span>}
        />
        <Row variant={variant} label="立即重连" hint="连接正常时也可以手动重连一次" onClick={act?.("reconnect")} />
        <Row
          variant={variant}
          label="接入说明与快捷键"
          control={<ChevronRight aria-hidden strokeWidth={1.5} className="size-4 text-(--cw-icon-fg)" />}
          onClick={act?.("help")}
        />
      </Group>
      <Group variant={variant} id="about" title="关于" note={aboutNote ?? "这些设置会同步到你登录的其他浏览器。"}>
        {version !== null && (
          <Row variant={variant} label="版本" control={<span className={cn("tabular-nums", C_SECONDARY)}>{version ?? "网页端 0.9.0"}</span>} />
        )}
        <Row
          variant={variant}
          label={logoutArmed ? "再点一次退出" : "退出登录"}
          hint={logoutArmed ? "3 秒内再点一次就会退出" : "清掉这个浏览器里保存的 token"}
          danger
          onClick={act?.("logout")}
        />
      </Group>
    </div>
  )
}

/**
 * 设置页（H01–H05 H08 H09 B07 B08 A02 I03 K13）。桌面：左栏不变，主区整块换成设置：
 * 中列分类导航（ch5/MarketplaceNav，宽 200）+ 右侧白卡分组（宽 560）。手机：推入页，分类导航变成页面里的分组。
 * 外观三项用分段控件（与显示选项一致，推断）；"立即发送"行为用单选行 ✓（H03）。
 * 开关行整行可点（N10，两种态都是）；P4 可交互时导航 / 动作 / 单选行整行是按钮，分段、开关、忙时投递改偏好（onPrefsChange）。
 */
export function PiSettingsPage({ variant, ...data }: { variant: CVariant } & PiSettingsData) {
  const isStatic = usePiStatic(data.static)
  const [activeSection, setActiveSection] = useState("appearance")
  const pageRef = useRef<HTMLDivElement>(null)
  if (variant === "phone") {
    return (
      <div data-slot="pi-settings-page" data-pi-usage-host="cursor" className="px-4 pb-6">
        <PiSettingsSections variant={variant} {...data} />
      </div>
    )
  }
  return (
    <div ref={pageRef} data-slot="pi-settings-page" data-pi-usage-host="cursor" className="absolute inset-0 overflow-y-auto [scrollbar-width:none]">
      <div className="mx-auto flex w-[800px] items-start gap-10 pt-11 pb-12">
        <MarketplaceNav
          title="设置"
          // 导航标题要读（§4.6，R2-C-m1 同类）：kit 默认 --cw-text-3 在 bg #F7F7F7 上只有 3.59，换 secondary（4.98；深色两者同值 #8E8E93）
          titleClassName={C_SECONDARY}
          groups={[
            {
              items: PERSONAL_NAV_IDS.filter((id) => !(isStatic && (id === "usage" || id === "mobile"))).map((id) => ({ id, label: SECTION_LABEL[id] })),
            },
            { items: SUPPORT_NAV_IDS.map((id) => ({ id, label: SECTION_LABEL[id] })) },
          ]}
          selectedId={activeSection}
          onSelect={(id) => {
            setActiveSection(id)
            pageRef.current?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)?.scrollIntoView({ block: "start" })
          }}
          data-cw-id="pi-settings-nav"
          className="sticky top-11 w-[200px] shrink-0"
        />
        <div className="w-[560px] min-w-0 pt-[3px]">
          <PiSettingsSections variant={variant} {...data} />
        </div>
      </div>
    </div>
  )
}
