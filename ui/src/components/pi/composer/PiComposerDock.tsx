import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react"
import { usePiDockLayout } from "@/components/pi/shared/frame"
import { usePiLayer, usePiStatic } from "@/components/pi/shared/layers"
import { cn } from "@/lib/utils"
import type { CImage, SlashGroup, SlashRow } from "./types"
import { PiComposerStatusRow, PiTurnAnnouncer, type PiStatusRowData } from "./PiComposerStatusRow"
import { PiFollowUpComposer, type PiComposerState, type PiFollowUpComposerProps } from "./PiFollowUpComposer"
import { PiTray, type PiTrayItem } from "./PiTray"
import type { CVariant } from "./styles"

/**
 * 跨区导出件 PiComposerDock（c 出，a、b 用）。props 是契约（design §6.4）：只许加可选字段。
 */
export interface PiComposerDockProps extends Omit<ComponentProps<"div">, "children"> {
  variant: CVariant
  state: PiComposerState
  draft?: string
  images?: CImage[]
  mentions?: string[]
  model: { name: string; thinking: string }
  tray?: PiTrayItem[]
  /** tray 最右的"回到底部"钮（用户上滑后） */
  scrollDown?: boolean
  /** 回到底部钮旁的新消息数（可选，推断） */
  newCount?: number
  status?: PiStatusRowData
  /** 两层形态（聚焦 / 多行）；键盘开着时总是两层 */
  layered?: boolean
  /** 手机键盘开着：两层形态，tray 与框下状态行收起（§4.2 第 3 条） */
  keyboardOpen?: boolean
  /** 审批卡（b 的 PiApprovalCard）：在 tray 上方 */
  approval?: ReactNode
  /** 浮在 composer 上沿的菜单（/、@、+、模型）：绝对定位，不占 dock 高度 */
  menu?: ReactNode
  /** 浮在 tray 上方的面板（排队 / 任务面板，宽 360）：绝对定位，不占 dock 高度；tray 不显示时贴在 composer 上沿 */
  panel?: ReactNode
  placeholder?: string
  /** 文字末尾的静态光标 */
  caret?: boolean
  /** 状态行右端的附加内容（PiCopyField 等） */
  statusTrailing?: ReactNode
  /** 模型选择器 / + 呈打开态（可交互时 = 受控的打开状态，配 onModelOpenChange / onPlusOpenChange） */
  modelOpen?: boolean
  plusOpen?: boolean
  /**
   * v1.2（D-08）：有可答审批卡时由容器传入 "approval"。输入只读、+ / / / @ 不响应；
   * 黑圆钮在 S1 / S2 / S4 / S5 渲染成 send-muted，S3 / S4 的停止保留；手机隐藏模型选择器；占位"输入已禁用"。
   * state 照旧取 deriveComposer，dock 不改写它。
   */
  blockedBy?: "approval" | null
  /* ---------- P4 可交互（静态态不读；都传给 PiFollowUpComposer / PiTray / PiComposerStatusRow） ---------- */
  /** true = 静态态（画廊截图）；不传时取 PiStaticContext（画廊舞台 = true） */
  static?: boolean
  onDraftChange?: (draft: string) => void
  onSend?: () => void
  onStop?: () => void
  /** 桌面 + 菜单 / 模型菜单的内容（键盘收起的手机由容器开 sheet，只回调 on…OpenChange） */
  plusMenu?: ReactNode
  onPlusOpenChange?: (open: boolean) => void
  modelMenu?: ReactNode
  onModelOpenChange?: (open: boolean) => void
  slashGroups?: SlashGroup[]
  onSlashCommand?: (row: SlashRow) => void
  mentionPool?: readonly string[]
  onMentionsChange?: (paths: string[]) => void
  onRemoveImage?: (index: number) => void
  /** P5：桌面 ↑ / ↓ 提示词历史（K04），原样交给 PiFollowUpComposer.onHistoryKey；手机不回调 */
  onHistoryKey?: PiFollowUpComposerProps["onHistoryKey"]
  /** 点 tray 的 pill */
  onTrayItem?: (kind: PiTrayItem["kind"]) => void
  /** 点"回到底部" */
  onScrollDown?: () => void
  /** 框下状态行的投递选择器 */
  onDeliveryChange?: (value: "steer" | "follow_up") => void
  deliveryOpen?: boolean
  onDeliveryOpenChange?: (open: boolean) => void
  /**
   * 桌面 tray 面板（panel）开着时：Esc（外壳 Esc 分层第 1 层）关它并把焦点送回选中的 pill，点面板和 tray 以外的地方也关它。
   * 不给 = 面板只是画出来（静态态的用法）。
   */
  onPanelClose?: () => void
}

/**
 * tray 上方的面板（P4 可交互）：登记为 menu 层（Esc 第 1 层关它，⌘ 组合在它开着时不触发）；
 * Esc 关掉后焦点回选中的 pill（design §4.7"关闭后焦点回触发元素"）；点面板和 tray 以外的地方 = 关闭（焦点不动）。
 */
function TrayPanelHost({ dock, onClose, children }: { dock: RefObject<HTMLDivElement | null>; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  usePiLayer(true, "menu", () => {
    close.current()
    dock.current?.querySelector<HTMLElement>('[data-slot="pi-tray"] [data-active]')?.focus({ preventScroll: true })
  })
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || ref.current?.contains(target) || target.closest('[data-slot="pi-tray"]')) return
      close.current()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [])
  return (
    <div ref={ref} data-slot="pi-tray-panel-anchor" className="absolute bottom-full left-0 z-(--cw-pi-z-popover) mb-2">
      {children}
    </div>
  )
}

/**
 * [data-pi-dock] 外框比 dock 本身高出的部分（外框的上下内边距：手机对话页上 8，键盘开着再加下 8）。
 * dock 的 max-height = dockMax − 这一段，[data-pi-dock] 整体就不超过 phoneDockLayout 的上限。
 */
function useDockChrome(ref: RefObject<HTMLDivElement | null>, active: boolean, observe: boolean, keyboardOpen: boolean | undefined): number {
  const [chrome, setChrome] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    const outer = el?.closest<HTMLElement>("[data-pi-dock]")
    if (!active || !el || !outer) return
    const measure = () => {
      const next = Math.max(0, Math.round(outer.getBoundingClientRect().height - el.getBoundingClientRect().height))
      setChrome((prev) => (prev === next ? prev : next))
    }
    measure()
    // 静态态（截图）只量一次，不挂监听
    if (!observe) return
    const ro = new ResizeObserver(measure)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [ref, active, observe, keyboardOpen])
  return chrome
}

/**
 * 对话页底部的 dock（design §3.1）：自上而下 审批卡 → tray → composer → 框下状态行。
 * 宽度跟随父容器（桌面 = 对话列宽，最宽 768）；外边距、安全区与键盘让位由 PiDesktopShell / PiPhonePage 管。
 * 间距：桌面 审批卡 / tray 与框 8，框与状态行 4；手机同。键盘开着时只剩 composer（及审批卡）。
 * P4 可交互：composer 是真输入框（PiFollowUpComposer），tray pill 可点、面板 Esc / 点外面关；回合结束的播报区（PiTurnAnnouncer）常驻在这里。
 * P6.3（design §4.2 规则 3–4）：手机 dock 的高度上限只读 usePiDockLayout()（PiPhonePage 按视口帧算的 phoneDockLayout）：
 * [data-pi-dock] 整体 ≤ dockMax（收起 50%、键盘开着 60%），超出时只收审批区（卡内滚动），tray、composer、状态行不压；
 * 审批卡自己的上限（键盘开着 40%）由 ApprovalContainer 读同一份。静态态同样收（#/live 对图和产品一致；画廊屏都在上限以内）。
 */
export function PiComposerDock({
  variant,
  state,
  draft,
  images,
  mentions,
  model,
  tray = [],
  scrollDown,
  newCount,
  status,
  layered,
  keyboardOpen,
  approval,
  menu,
  panel,
  placeholder,
  caret,
  statusTrailing,
  modelOpen,
  plusOpen,
  blockedBy,
  static: staticProp,
  onDraftChange,
  onSend,
  onStop,
  plusMenu,
  onPlusOpenChange,
  modelMenu,
  onModelOpenChange,
  slashGroups,
  onSlashCommand,
  mentionPool,
  onMentionsChange,
  onRemoveImage,
  onHistoryKey,
  onTrayItem,
  onScrollDown,
  onDeliveryChange,
  deliveryOpen,
  onDeliveryOpenChange,
  onPanelClose,
  className,
  style,
  ...rest
}: PiComposerDockProps) {
  const isStatic = usePiStatic(staticProp)
  const dockRef = useRef<HTMLDivElement>(null)
  const dockLayout = usePiDockLayout()
  const limited = dockLayout != null
  const dockChrome = useDockChrome(dockRef, limited, !isStatic, keyboardOpen)
  const maxHeight = limited ? Math.max(0, dockLayout.dockMax - dockChrome) : undefined
  const showTray = !keyboardOpen && (tray.length > 0 || scrollDown)
  const showStatus = !keyboardOpen && status != null
  // 审批禁用时 + / / / @ 菜单不响应：不渲染这些菜单；模型菜单（modelOpen）在桌面照常可开，手机上选择器已隐藏
  const blocked = blockedBy === "approval"
  // 键盘开着时状态行收起，原因挪到两层上层首行（§1.6 D-02）
  const topNote = keyboardOpen ? status?.note : undefined
  const panelNode =
    panel == null ? null : !isStatic && onPanelClose ? (
      <TrayPanelHost dock={dockRef} onClose={onPanelClose}>
        {panel}
      </TrayPanelHost>
    ) : (
      <div data-slot="pi-tray-panel-anchor" className="absolute bottom-full left-0 z-(--cw-pi-z-popover) mb-2">
        {panel}
      </div>
    )
  return (
    <div
      ref={dockRef}
      data-slot="pi-composer-dock"
      data-state={state}
      data-pi-dock-limit={maxHeight}
      className={cn("flex min-w-0 flex-col", className)}
      style={maxHeight != null ? { ...style, maxHeight } : style}
      {...rest}
    >
      {/* P5：容器总是把 ApprovalContainer 放进来（没有卡时它什么都不画）：空的时候 empty:hidden，不留 8px 间距 */}
      {/* P6.3：手机限高时审批区可以收（min-h-0，卡是 overflow-hidden 的 flex 列，卡内滚动），其余各块不收 */}
      {approval != null && <div className={cn("mb-2 min-w-0 empty:hidden", limited && "flex min-h-0 flex-col")}>{approval}</div>}
      {showTray && (
        <div className={cn("relative mb-2 min-w-0", limited && "shrink-0")}>
          {panelNode}
          <PiTray
            variant={variant}
            items={tray}
            scrollDown={scrollDown}
            newCount={newCount}
            static={isStatic}
            onItemClick={onTrayItem}
            onScrollDown={onScrollDown}
          />
        </div>
      )}
      <div className={cn("relative min-w-0", limited && "shrink-0")}>
        {!showTray && panelNode}
        {menu != null && (!blocked || modelOpen) && (
          <div data-slot="pi-composer-menu-anchor" className="absolute inset-x-0 bottom-full z-(--cw-pi-z-popover) mb-2">
            {menu}
          </div>
        )}
        <PiFollowUpComposer
          variant={variant}
          state={state}
          draft={draft}
          images={images}
          mentions={mentions}
          model={model}
          layered={layered || keyboardOpen}
          placeholder={placeholder}
          caret={caret}
          modelOpen={modelOpen}
          plusOpen={plusOpen}
          blockedBy={blockedBy}
          topNote={topNote}
          static={isStatic}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onStop={onStop}
          plusMenu={plusMenu}
          onPlusOpenChange={onPlusOpenChange}
          modelMenu={modelMenu}
          onModelOpenChange={onModelOpenChange}
          menusAsSheet={variant === "phone" && !keyboardOpen}
          slashGroups={slashGroups}
          onSlashCommand={onSlashCommand}
          mentionPool={mentionPool}
          onMentionsChange={onMentionsChange}
          onRemoveImage={onRemoveImage}
          onHistoryKey={onHistoryKey}
        />
      </div>
      {showStatus && (
        <PiComposerStatusRow
          variant={variant}
          status={status}
          trailing={statusTrailing}
          className={cn("mt-1", limited && "shrink-0")}
          static={isStatic}
          onDeliveryChange={onDeliveryChange}
          deliveryOpen={deliveryOpen}
          onDeliveryOpenChange={onDeliveryOpenChange}
        />
      )}
      {!isStatic && <PiTurnAnnouncer running={!!status?.running} error={!!status?.turnError} />}
    </div>
  )
}
