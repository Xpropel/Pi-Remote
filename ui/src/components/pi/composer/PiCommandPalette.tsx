import { useId, useState, type KeyboardEvent, type ReactNode } from "react"
import { Dialog } from "radix-ui"
import { KeycapGroup } from "@/components/kit/controls/KeycapGroup"
import {
  AgentPlaneIcon,
  ChartColumn,
  FoldVertical,
  ListTree,
  PanelLeft,
  PanelRight,
  RotateCcw,
  ScanSearch,
  Search,
  Settings,
  X,
} from "@/components/kit/icons"
import { PiOverlay, PiRowMarker, PiSheet, usePiStatic, type PiOverlayControl, type PiReturnFocus } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { paletteCommandDisabled, paletteKeysOf, paletteMatches } from "@/pi/model/composerInput"
import { piPlatformOf, type PiPlatform } from "@/pi/model/shortcuts"
import type { PaletteCommand, PaletteSession } from "./types"
import { C_SECONDARY, type CVariant } from "./styles"
import { useListNav } from "./useListNav"

const ICON: Record<PaletteCommand["icon"], ReactNode> = {
  new: <AgentPlaneIcon />,
  sidebar: <PanelLeft />,
  pane: <PanelRight />,
  compact: <FoldVertical />,
  regenerate: <RotateCcw />,
  tree: <ListTree />,
  usage: <ChartColumn />,
  inspect: <ScanSearch />,
  settings: <Settings />,
}

/** 命令面板执行的一行：命令（PaletteCommand.key）或会话（PaletteSession.id） */
export type PiPaletteRun = { kind: "command"; key: string } | { kind: "session"; id: string }

export interface PiCommandPaletteProps extends PiOverlayControl {
  variant: CVariant
  /** 命令组（新建会话、切换侧栏…；键帽只写浏览器里真能触发的） */
  commands: PaletteCommand[]
  /** 会话组：最近的会话（标题、行首标记、"设备名/目录名"） */
  sessions: PaletteSession[]
  /** 选中行（默认第一行"新建会话"；静态态用） */
  activeKey?: string
  /** 离线：命令行禁用并写原因（states） */
  offline?: boolean
  /** P5：离线时"命令"组标题下的一行灰字原因（不给 = 不写） */
  offlineReason?: string
  /** P5：没有查询时会话组只列前 N 个（design：最近 4 个）；有查询时在全部 sessions 里搜。不给 = 全列 */
  recentLimit?: number
  /** P4 可交互：执行一行（Enter / 点）。执行后关不关由调用方定（通常 onOpenChange(false) 再执行） */
  onRun?: (row: PiPaletteRun) => void
  /** P4 可交互：关闭后焦点回哪（默认 = 打开前的焦点元素，design §4.7 焦点表"命令面板"） */
  returnFocus?: PiReturnFocus
}

interface RowProps {
  id?: string
  variant: CVariant
  icon: ReactNode
  label: ReactNode
  /** 第二行灰字（手机会话行的组名：放行尾会把标题挤得太短） */
  subtitle?: ReactNode
  trailing?: ReactNode
  active?: boolean
  disabled?: boolean
  /** P4 可交互：指针移过 = 选中行跟着走；按下不抢搜索框的焦点；点 = 执行 */
  onPointerMove?: () => void
  onClick?: () => void
}

function Row({ id, variant, icon, label, subtitle, trailing, active, disabled, onPointerMove, onClick }: RowProps) {
  const phone = variant === "phone"
  const interactive = onClick != null
  return (
    <div
      id={id}
      role="option"
      aria-selected={active || undefined}
      aria-disabled={disabled || undefined}
      data-active={active ? "" : undefined}
      className={cn(
        "flex min-w-0 shrink-0 items-center select-none",
        phone
          ? cn("mx-1 gap-3 rounded-[10px] px-3 text-[15px]", subtitle != null ? "min-h-[56px] py-1.5" : "h-12")
          : "mx-2.5 h-8 gap-2.5 rounded-[7px] pr-2 pl-[7px] text-(length:--cw-text-md)",
        active ? "bg-(--cw-palette-row-selected)" : interactive ? undefined : "hover:bg-(--cw-row-hover)",
        disabled ? "text-(--cw-text-4)" : "text-(--cw-text)",
      )}
      onMouseDown={interactive ? (event) => event.preventDefault() : undefined}
      onPointerMove={onPointerMove}
      onClick={interactive && !disabled ? onClick : undefined}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-(--cw-text-2) [&>svg]:stroke-[1.5]",
          phone ? "size-5 [&>svg]:size-[18px]" : "size-4 [&>svg]:size-[15px]",
        )}
      >
        {icon}
      </span>
      {subtitle != null ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate leading-5">{label}</span>
          <span className={cn("min-w-0 truncate text-[13px] leading-[18px]", C_SECONDARY)}>{subtitle}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{label}</span>
      )}
      {trailing != null && <span className="ml-3 flex shrink-0 items-center">{trailing}</span>}
    </div>
  )
}

function GroupTitle({ variant, children }: { variant: CVariant; children: ReactNode }) {
  return (
    <div
      role="presentation"
      className={cn(
        // 组名要读：手机 --cw-pi-text-secondary 在 sheet 白底 5.2:1；桌面面板底更深（secondary 只有 4.47:1），用 --cw-text-2
        "flex shrink-0 items-center select-none",
        variant === "phone" ? C_SECONDARY : "text-(--cw-text-2)",
        variant === "phone" ? "h-8 px-4 text-[13px]" : "h-6 px-[19px] text-(length:--cw-text-sm)",
      )}
    >
      {children}
    </div>
  )
}

/** 行尾键帽（只写浏览器里真能触发的键，单一来源 PI_SHORTCUT_KEYS；静态画廊按 mac 画，和冻结版一致） */
function keysOf(c: PaletteCommand, platform: PiPlatform): string[] | undefined {
  return paletteKeysOf(c.key, platform) ?? c.keys
}

/** 列表本体（桌面卡与手机 sheet 共用；静态态） */
/** 离线原因：命令组标题下一行灰字 */
function OfflineReason({ variant, children }: { variant: CVariant; children: ReactNode }) {
  return (
    <div role="note" className={cn("flex shrink-0 items-center", variant === "phone" ? "min-h-8 px-4 text-[13px]" : "min-h-6 px-[19px] text-(length:--cw-text-sm)", C_SECONDARY)}>
      {children}
    </div>
  )
}

function PaletteList({ variant, commands, sessions: allSessions, activeKey, offline, offlineReason, recentLimit }: PiCommandPaletteProps) {
  const phone = variant === "phone"
  const active = activeKey ?? commands[0]?.key
  const sessions = recentLimit != null ? allSessions.slice(0, recentLimit) : allSessions
  // §4.7：↑↓ 选中行用 aria-activedescendant 标出（可交互时写在搜索框上，这里静态态由 listbox 承载）
  const base = useId()
  const rowId = (key: string) => `${base}-palette-${key}`
  return (
    <div role="listbox" aria-label="命令与会话" aria-activedescendant={active ? rowId(active) : undefined} tabIndex={-1} className="flex flex-col">
      <GroupTitle variant={variant}>命令</GroupTitle>
      {offline && offlineReason && <OfflineReason variant={variant}>{offlineReason}</OfflineReason>}
      {commands.map((c) => {
        const keys = keysOf(c, "mac")
        return (
          <Row
            key={c.key}
            id={rowId(c.key)}
            variant={variant}
            icon={ICON[c.icon]}
            label={c.label}
            active={c.key === active}
            disabled={paletteCommandDisabled(c.key, !!offline)}
            trailing={!phone && keys ? <KeycapGroup keys={keys} /> : undefined}
          />
        )
      })}
      <div className={phone ? "mt-2" : "mt-[9px]"}>
        <GroupTitle variant={variant}>会话</GroupTitle>
        {sessions.map((s) => (
          <Row
            key={s.id}
            id={rowId(s.id)}
            variant={variant}
            icon={<PiRowMarker kind={s.marker} />}
            label={s.title}
            active={s.id === active}
            subtitle={phone ? s.group : undefined}
            trailing={
              // 面板底 --cw-palette-bg 上 secondary 只有 4.47，桌面用 --cw-text-2（§4.6 D-03，R2-C-01）
              phone ? undefined : <span className="truncate text-(length:--cw-text-sm) text-(--cw-text-2)">{s.group}</span>
            }
          />
        ))}
      </div>
    </div>
  )
}

/**
 * 命令面板（G01 G07 B14）：⌘K 打开。搜索行（左侧灰 pill"命令 ×"）→"命令"组（行尾键帽，只写浏览器里真能触发的键）
 * →"会话"组（最近 4 个，行首状态标记 + 行尾灰字组名）→ 底部快捷键说明。
 * 桌面：全屏压暗，卡宽 680、距顶 120、圆角 16、--cw-palette-bg（版式参照 ch1/ActionsPalette，Pi 要"命令 / 会话"两组，自组）。
 * 手机：全高 PiSheet，搜索框在顶，行 48，不显示键帽和快捷键行（手机没有这些键）。
 * P4 可交互（design §4.7 焦点表"命令面板"）：桌面是 PiOverlay（焦点进搜索框、圈在面板里、Esc 只关面板、关闭回打开前的焦点），
 * ↑↓ 用搜索框的 aria-activedescendant 标出选中行（跳过禁用行）、Enter 执行；手机是全高 PiSheet，"取消"关闭。
 */
export function PiCommandPalette(props: PiCommandPaletteProps) {
  const isStatic = usePiStatic(props.static)
  const { variant, open } = props
  if (!isStatic) return <PaletteInteractive {...props} />
  if (open === false) return null
  if (variant === "phone") {
    return (
      <PiSheet static size="full" label="命令面板" bodyClassName="px-2 pb-2">
        <div className="mx-2 mb-2 flex h-11 shrink-0 items-center gap-2 rounded-[10px] bg-(--cw-chip-bg) px-3 text-[16px] text-(--cw-text-4)">
          <Search aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">搜索命令和会话…</span>
          <span className="text-[15px] text-(--cw-text-2)">取消</span>
        </div>
        <PaletteList {...props} />
      </PiSheet>
    )
  }
  return (
    <div data-slot="pi-command-palette" className="absolute inset-0 z-(--cw-pi-z-modal)">
      <div aria-hidden className="absolute inset-0 bg-(--cw-overlay)" />
      <div role="dialog" aria-modal="true" aria-label="命令面板" className={PALETTE_CARD}>
        <div className="flex h-12 items-center border-b border-solid border-(--cw-border) pr-4 pl-3">
          <ScopeChip />
          <span className="min-w-0 flex-1 truncate text-[17px] leading-none text-(--cw-text-4)">搜索命令和会话…</span>
        </div>
        <div className="pt-2 pb-2">
          <PaletteList {...props} />
        </div>
        <PaletteFooter />
      </div>
    </div>
  )
}

const PALETTE_CARD =
  "absolute top-[120px] left-1/2 w-(--cw-palette-w) -translate-x-1/2 overflow-hidden rounded-(--cw-radius-palette) bg-(--cw-palette-bg) shadow-(--cw-shadow-palette)"

function ScopeChip() {
  return (
    <span className="mr-2.5 inline-flex h-[23px] shrink-0 items-center gap-1.5 rounded-full bg-(--cw-chip-bg) pr-[7px] pl-[9px] text-(length:--cw-text-sm) leading-none text-(--cw-text-2) select-none">
      命令
      <X aria-hidden strokeWidth={1.75} className="size-3" />
    </span>
  )
}

function PaletteFooter() {
  return (
    <div className={cn("flex h-8 items-center border-t border-solid border-(--cw-border) px-[19px] text-(length:--cw-text-sm) text-(--cw-text-2)")}>
      ↑↓ 选择 · ↵ 执行 · esc 关闭
    </div>
  )
}

/** 可交互的面板：搜索过滤、↑↓ / Enter，桌面 PiOverlay、手机全高 PiSheet */
function PaletteInteractive({ variant, commands, sessions, offline, offlineReason, recentLimit, open, onOpenChange, onRun, returnFocus }: PiCommandPaletteProps) {
  const phone = variant === "phone"
  const base = useId()
  const listId = `${base}-list`
  const rowId = (key: string) => `${base}-palette-${key}`
  const [query, setQuery] = useState("")
  const [platform] = useState(() => piPlatformOf(typeof navigator === "undefined" ? null : navigator))
  const shownCommands = commands.filter((c) => paletteMatches(query, c.label))
  // 没有查询：最近 recentLimit 个；有查询：在全部会话里搜
  const shownSessions = query.trim() || recentLimit == null ? sessions.filter((s) => paletteMatches(query, s.title, s.group)) : sessions.slice(0, recentLimit)
  const rows: { id: string; run: PiPaletteRun; disabled: boolean }[] = [
    ...shownCommands.map((c) => ({ id: rowId(c.key), run: { kind: "command" as const, key: c.key }, disabled: paletteCommandDisabled(c.key, !!offline) })),
    ...shownSessions.map((s) => ({ id: rowId(s.id), run: { kind: "session" as const, id: s.id }, disabled: false })),
  ]
  const nav = useListNav(rows.map((r) => !r.disabled))
  const activeRow = rows[nav.active]
  const run = (index: number) => {
    const row = rows[index]
    if (!row || row.disabled) return
    onRun?.(row.run)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (nav.onKeyDown(event)) return
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      run(nav.active)
    }
  }
  const rowEvents = (index: number) => ({
    onPointerMove: () => {
      if (index !== nav.active) nav.setActive(index)
    },
    onClick: () => run(index),
  })
  const input = (
    <input
      type="text"
      role="combobox"
      aria-label="搜索命令和会话"
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={activeRow?.id}
      placeholder="搜索命令和会话…"
      autoComplete="off"
      spellCheck={false}
      value={query}
      onChange={(event) => {
        setQuery(event.currentTarget.value)
        nav.setActive(0)
      }}
      onKeyDown={onKeyDown}
      className={cn(
        // 撑满搜索行的高（手机 44、桌面 48）：点击区 ≥ 44（§4.4）
        "min-w-0 flex-1 self-stretch border-0 bg-transparent p-0 text-(--cw-text) outline-none placeholder:text-(--cw-text-4)",
        phone ? "text-[16px]" : "text-[17px] leading-none",
      )}
    />
  )
  const list = (
    <div role="listbox" id={listId} aria-label="命令与会话" className="flex flex-col">
      {rows.length === 0 && (
        <div className={cn("px-4 py-2", phone ? "text-[15px]" : "text-(length:--cw-text-md)", C_SECONDARY)}>没有匹配的命令或会话</div>
      )}
      {shownCommands.length > 0 && <GroupTitle variant={variant}>命令</GroupTitle>}
      {shownCommands.length > 0 && offline && offlineReason && <OfflineReason variant={variant}>{offlineReason}</OfflineReason>}
      {shownCommands.map((c, i) => {
        const keys = keysOf(c, platform)
        return (
          <Row
            key={c.key}
            id={rowId(c.key)}
            variant={variant}
            icon={ICON[c.icon]}
            label={c.label}
            active={i === nav.active}
            disabled={paletteCommandDisabled(c.key, !!offline)}
            trailing={!phone && keys ? <KeycapGroup keys={keys} /> : undefined}
            {...rowEvents(i)}
          />
        )
      })}
      {shownSessions.length > 0 && (
        <div className={shownCommands.length > 0 ? (phone ? "mt-2" : "mt-[9px]") : undefined}>
          <GroupTitle variant={variant}>会话</GroupTitle>
          {shownSessions.map((s, j) => {
            const i = shownCommands.length + j
            return (
              <Row
                key={s.id}
                id={rowId(s.id)}
                variant={variant}
                icon={<PiRowMarker kind={s.marker} />}
                label={s.title}
                active={i === nav.active}
                subtitle={phone ? s.group : undefined}
                trailing={phone ? undefined : <span className="truncate text-(length:--cw-text-sm) text-(--cw-text-2)">{s.group}</span>}
                {...rowEvents(i)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
  if (phone) {
    return (
      <PiSheet open={open} onOpenChange={onOpenChange} returnFocus={returnFocus} size="full" label="命令面板" bodyClassName="px-2 pb-2">
        <div className="mx-2 mb-2 flex h-11 shrink-0 items-center gap-2 rounded-[10px] bg-(--cw-chip-bg) px-3">
          <Search aria-hidden strokeWidth={1.5} className="size-[18px] shrink-0 text-(--cw-text-4)" />
          {input}
          <Dialog.Close asChild>
            <button type="button" className="relative text-[15px] text-(--cw-text-2) after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']">
              取消
            </button>
          </Dialog.Close>
        </div>
        {list}
      </PiSheet>
    )
  }
  return (
    <PiOverlay
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      label="命令面板"
      focus="dialog"
      layerData={{ "data-slot": "pi-command-palette" }}
      className={PALETTE_CARD}
    >
      <div className="flex h-12 items-center border-b border-solid border-(--cw-border) pr-4 pl-3 focus-within:border-(--cw-pi-field-focus-border)">
        <ScopeChip />
        {input}
      </div>
      <div className="max-h-[480px] overflow-y-auto pt-2 pb-2 [scrollbar-width:none]">{list}</div>
      <PaletteFooter />
    </PiOverlay>
  )
}
