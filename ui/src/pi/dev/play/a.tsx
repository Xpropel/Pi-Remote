/*
 * a 线的可交互件（#/play，R2/p4-lanes.md §4、§6 a 线）：左栏 / 手机列表（会话菜单、标题搜索、"更多 N"）、顶栏（悬停卡、手机点标题 / …）、
 * a 区的手机 sheet（会话信息、会话菜单、改名、删除、设备与配对）与桌面弹窗（改名、删除确认、设备与配对）。
 * 只用画廊数据，不接 relay（P5 换成真实容器）。PlayApp.tsx 只认下面这几个导出。
 *
 * a 线自己的状态（搜索词、展开的组、改名 / 删除、菜单作用的那一行）放在本文件的小 store 里：PlayApp 把 a 的几个槽位
 * （左栏、顶栏、sheet、弹窗）分开渲染，它们要共用这一份。外壳状态只用 ui.sheet / ui.dialog 记"开着哪个"（id 见下）。
 */
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { Ellipsis } from "@/components/kit/icons"
import {
  ASearchField,
  ATextButton,
  PiDevicePairing,
  PiSearchResults,
  PiSessionInfoCard,
  PiSessionMenu,
  type PiSearchSection,
  type PiSessionMenuAction,
  type PiSessionMenuSession,
} from "@/components/pi/shell"
import {
  PiAccountFooter,
  PiButton,
  PiDialog,
  PiIconButton,
  PiSheet,
  PiSidebar,
  PiTopBar,
  piBaseName,
  type PiAttentionItem,
  type PiReturnFocus,
  type PiSessionRowData,
} from "@/components/pi/shared"
import { A_PAIR, A_SEARCH_QUERY } from "@/pi/dev/fixtures/gallery/a"
import {
  MOCK_ATTENTION,
  MOCK_BRANCH,
  MOCK_DEVICES,
  MOCK_LINK,
  MOCK_MODEL,
  MOCK_NOW,
  MOCK_SESSIONS,
  MOCK_THINKING_LEVEL,
  MOCK_USAGE,
  mockDevice,
  piAttentionOnOpen,
  piLinkSummary,
  piOtherAttentionCount,
  piSessionGroups,
  piSessionRow,
  type PiMockSession,
} from "@/pi/dev/fixtures/gallery/shared"
import { C_SHEET_DISPLAY_OPTIONS, PlayDisplayOptionsMenu } from "./c"
import type { PlayActions, PlaySlotProps, PlayUi } from "./state"

/* ======================= sheet / 弹窗 id（ui.sheet：手机；ui.dialog：桌面） ======================= */

/** 手机点标题：会话信息（design B06） */
export const A_SHEET_SESSION_INFO = "a:session-info"
/** 手机长按行 / 对话页顶栏 …：会话菜单（design J07） */
export const A_SESSION_MENU = "a:session-menu"
/** 改名（G11）：桌面 PiDialog，手机全高 sheet */
export const A_RENAME = "a:rename"
/** 删除确认（G13）：危险 PiDialog，焦点进"取消" */
export const A_DELETE = "a:delete"
/** 设备与配对（C05）：桌面 PiDialog 560，手机全高 sheet。别的线（设置页"配对新设备…"）用 act.openDialog / openSheet 打开它 */
export const A_PAIRING = "a:pairing"

/* ======================= a 线的小 store ======================= */

interface AState {
  /** 按哪个起始状态初始化的（ui.screen） */
  screen: string | null
  /** 标题搜索的查询词；null = 没在搜 */
  query: string | null
  /** 已展开"更多 N"的组 key */
  expanded: string[]
  /** 改过名的会话 */
  titles: Record<string, string>
  /** 删掉的会话 */
  deleted: string[]
  /** 菜单 / 改名 / 删除作用的会话，以及关闭后焦点回哪（选择器：行、手机顶栏 …、手机标题） */
  target: { id: string; returnTo: string } | null
}

const EMPTY: AState = { screen: null, query: null, expanded: [], titles: {}, deleted: [], target: null }
let aState: AState = EMPTY
const aListeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  aListeners.add(listener)
  return () => {
    aListeners.delete(listener)
  }
}
const snapshot = () => aState

function setA(patch: Partial<AState> | ((cur: AState) => Partial<AState>)) {
  aState = { ...aState, ...(typeof patch === "function" ? patch(aState) : patch) }
  for (const listener of aListeners) listener()
}

/** 行在列表里的选择器（key = PiSidebar 的 data-pi-row-key：需要处理组里是 "attention:<id>"） */
const rowSel = (key: string) => `[data-pi-sidebar] [data-pi-row-key="${key}"]`
const SEARCH_ROW = '[data-pi-sidebar] [data-pi-nav="search"]'
const SEARCH_INPUT = "[data-pi-search-field] input"
const PHONE_SEARCH_BTN = '[data-pi-topbar="phone-list"] button[aria-label="搜索会话"]'
const PHONE_MORE = '[data-pi-topbar="phone-chat"] [data-pi-session-more]'
const PHONE_TITLE = '[data-pi-topbar="phone-chat"] [data-pi-focus-fallback]'

/** a 线自己的起始数据（外壳的那部分在 presets-a.ts）：搜索屏带着查询词，会话菜单屏的目标是 r-s4 */
function initialA(screen: string): AState {
  return {
    ...EMPTY,
    screen,
    query: screen === "session-search" ? A_SEARCH_QUERY : null,
    target: screen === "session-menu" ? { id: "r-s4", returnTo: rowSel("r-s4") } : null,
  }
}

function useA(screen: string): AState {
  const a = useSyncExternalStore(subscribe, snapshot, snapshot)
  // 挂载后按起始状态初始化一次（几个槽位谁先跑谁做，其余看到 screen 已对上就跳过）。
  // 同一页里 ui.screen 不变（usePlayUi 只在挂载时取）；ui-interact 每条用例开新页
  useEffect(() => {
    if (aState.screen !== screen) setA(initialA(screen))
  }, [screen])
  return a
}

const pick = (selector: string) => document.querySelector<HTMLElement>(selector)
/** 弹窗 / sheet 关闭后焦点回 store 里记的元素；它不在了（行被删）由 PiOverlay 兜底回顶栏标题 */
const returnToTarget: PiReturnFocus = () => (aState.target ? pick(aState.target.returnTo) : null)
/** 下一帧把焦点放到 selector（等 React 换完 DOM） */
const focusSoon = (selector: string) => requestAnimationFrame(() => pick(selector)?.focus())

/* ======================= 数据（画廊 mock + 改名 / 删除） ======================= */

function sessionsOf(a: AState): PiMockSession[] {
  return MOCK_SESSIONS.filter((x) => !a.deleted.includes(x.id)).map((x) => (a.titles[x.id] ? { ...x, title: a.titles[x.id] } : x))
}

function attentionOf(a: AState): PiAttentionItem[] {
  return MOCK_ATTENTION.filter((x) => !a.deleted.includes(x.roomId)).map((x) => (a.titles[x.roomId] ? { ...x, title: a.titles[x.roomId] } : x))
}

function sessionOf(id: string): PiMockSession | undefined {
  return MOCK_SESSIONS.find((x) => x.id === id)
}

function titleOf(id: string, a: AState): string {
  return a.titles[id] ?? sessionOf(id)?.title ?? id
}

/** 会话菜单要的字段；当前会话不可删（design G13），pi 正忙时会话操作禁用 */
function menuSessionOf(id: string, a: AState, ui: PlayUi): PiSessionMenuSession | null {
  const s = sessionOf(id)
  if (!s || a.deleted.includes(id)) return null
  return {
    title: titleOf(id, a),
    messageCount: s.messageCount,
    sessionId: s.sessionId,
    openable: s.openable,
    current: ui.view === "session" && ui.roomId === id,
    busy: s.busy,
  }
}

function head(roomId: string, a: AState) {
  const s = sessionOf(roomId)
  const device = mockDevice(s?.deviceId)
  return { session: s, device, title: titleOf(roomId, a), platform: device?.platform }
}

function infoCard(roomId: string, variant: "desktop" | "phone", a: AState) {
  const { session, device, title } = head(roomId, a)
  return (
    <PiSessionInfoCard
      variant={variant}
      title={title}
      device={device ?? MOCK_DEVICES[0]}
      branch={MOCK_BRANCH}
      cwd={session?.cwd ?? ""}
      model={`${MOCK_MODEL.name} · ${MOCK_THINKING_LEVEL}`}
      usage={MOCK_USAGE}
      sessionId={session?.sessionId ?? roomId}
    />
  )
}

/** 标题搜索（本地过滤标题 / 首条消息，顺序同列表：在线在前、再按最近活动）。正文搜索（search_session_bodies）归 P5 */
function titleMatches(query: string, a: AState): PiSessionRowData[] {
  const q = query.trim()
  if (!q) return []
  const needle = q.toLowerCase()
  const attention = attentionOf(a)
  return sessionsOf(a)
    .filter((x) => x.title.toLowerCase().includes(needle) || (x.firstMessage ?? "").toLowerCase().includes(needle))
    .sort((p, r) => Number(r.online) - Number(p.online) || r.updatedAt - p.updatedAt)
    .map((x) => ({ ...piSessionRow(x, MOCK_NOW, attention), highlight: q }))
}

/* ======================= 动作 ======================= */

function enterSearch() {
  setA((cur) => ({ query: cur.query ?? "" }))
  // 已经在搜：点"搜索"行 / 搜索钮只把焦点送回输入框（刚进来时 autoFocus 管）
  focusSoon(SEARCH_INPUT)
}

function exitSearch(focusTo: string | null) {
  setA({ query: null })
  if (focusTo) focusSoon(focusTo)
}

function toggleMore(key: string) {
  setA((cur) => ({ expanded: cur.expanded.includes(key) ? cur.expanded.filter((k) => k !== key) : [...cur.expanded, key] }))
}

function openPhoneMenu(id: string, returnTo: string, act: PlayActions) {
  setA({ target: { id, returnTo } })
  act.openSheet(A_SESSION_MENU)
}

/**
 * 会话菜单选中一项。桌面菜单由 Radix 自己关（焦点回行 / …）；手机先关会话菜单 sheet 再开下一个。
 * 改名 / 删除开 a 区的弹窗（手机是 sheet），关闭后焦点回 returnTo（行没了就回顶栏标题）。
 */
function onMenuAction(action: PiSessionMenuAction, id: string, returnTo: string, variant: "desktop" | "phone", act: PlayActions) {
  const phone = variant === "phone"
  setA({ target: { id, returnTo } })
  if (phone) act.closeSheet()
  switch (action) {
    case "open":
      act.openSession(id)
      return
    case "rename":
      if (phone) act.openSheet(A_RENAME)
      else act.openDialog(A_RENAME)
      return
    case "delete":
      if (phone) act.openSheet(A_DELETE)
      else act.openDialog(A_DELETE)
      return
    case "copy-id":
      // 没有剪贴板权限（file://、无头浏览器）时什么都不做
      void navigator.clipboard?.writeText(sessionOf(id)?.sessionId ?? id).catch(() => undefined)
      return
    default:
      // 分叉 / 克隆 / 导出 / 新标签页 / 会话树 / 压缩：弹窗与命令不在 a 线（P5 接 relay），这里只关菜单
      return
  }
}

/* ======================= 槽位：左栏 / 手机列表 ======================= */

function SearchBody({ a, act, variant, selectedId }: { a: AState; act: PlayActions; variant: "desktop" | "phone"; selectedId?: string }) {
  const phone = variant === "phone"
  const query = a.query ?? ""
  const rows = titleMatches(query, a)
  const sections: PiSearchSection[] = rows.length ? [{ key: "title", label: `标题匹配 ${rows.length}`, rows }] : []
  const open = (row: PiSessionRowData) => {
    exitSearch(null)
    act.openSession(row.id)
  }
  return (
    <>
      {!phone && (
        <ASearchField
          variant="desktop"
          value={query}
          autoFocus
          onValueChange={(value) => setA({ query: value })}
          onClear={() => setA({ query: "" })}
          onEscape={() => exitSearch(SEARCH_ROW)}
          className="mt-1.5 mr-0.5 ml-0.5"
        />
      )}
      {sections.length > 0 ? (
        <PiSearchResults variant={variant} sections={sections} selectedId={selectedId} onOpenRow={open} />
      ) : query.trim() ? (
        // 无结果（design session-search states）
        <div data-pi-search-empty="" className={cn("flex flex-col items-start gap-1", phone ? "px-2 pt-4" : "px-1.5 pt-3")}>
          <p className={cn("m-0 text-(--cw-pi-text-secondary)", phone ? "text-[15px] leading-5" : "text-(length:--cw-text-sm) leading-(--cw-leading-sm)")}>
            没有匹配的会话
          </p>
          <ATextButton
            tone="link"
            touch={phone}
            className="-ml-1.5"
            onClick={() => {
              setA({ query: "" })
              // 这一块随之消失：焦点送回输入框接着输
              focusSoon(SEARCH_INPUT)
            }}
          >
            清空搜索
          </ATextButton>
        </div>
      ) : null}
    </>
  )
}

/** 桌面左栏（expanded / rail，跟 ⌘B）/ 手机列表页正文 */
export function PlaySidebar({ ui, act, variant }: PlaySlotProps) {
  const a = useA(ui.screen)
  const phone = variant === "phone"
  const selectedId = ui.view === "session" ? ui.roomId : undefined
  const all = attentionOf(a)
  const attention = phone ? all : piAttentionOnOpen(selectedId, all)
  const searching = a.query != null
  return (
    <PiSidebar
      variant={phone ? "phone" : ui.sidebar}
      groups={piSessionGroups({ sessions: sessionsOf(a), attention, expanded: a.expanded })}
      attention={attention}
      selectedId={selectedId}
      navSelected={ui.view === "new" ? "new" : searching && !phone ? "search" : null}
      body={searching ? <SearchBody a={a} act={act} variant={variant} selectedId={selectedId} /> : undefined}
      footerPressed={ui.view === "settings" ? "settings" : undefined}
      link={piLinkSummary(MOCK_LINK)}
      now={MOCK_NOW}
      devices={MOCK_DEVICES}
      onNewSession={act.newSession}
      onSearch={() => {
        // rail 上点搜索：先展开左栏
        if (!phone && ui.sidebar === "rail") act.toggleSidebar()
        enterSearch()
      }}
      onToggleSidebar={act.toggleSidebar}
      onOpenSettings={act.openSettings}
      // 账户区滑杆 → 显示选项（内容归 c 线；手机在 PlayPhoneFooter 开 sheet）
      optionsMenu={phone ? undefined : <PlayDisplayOptionsMenu ui={ui} act={act} variant="desktop" />}
      onOpenSession={(row) => {
        // "设备未连接"条目不是会话
        if (row.platform == null) act.openSession(row.id)
      }}
      rowMenu={
        phone
          ? undefined
          : (row, key) => {
              const session = row.platform == null ? menuSessionOf(row.id, a, ui) : null
              if (!session) return null
              return <PiSessionMenu variant="desktop" session={session} onSelect={(action) => onMenuAction(action, row.id, rowSel(key), "desktop", act)} />
            }
      }
      onRowLongPress={
        phone
          ? (row, key) => {
              if (row.platform == null && menuSessionOf(row.id, a, ui)) openPhoneMenu(row.id, rowSel(key), act)
            }
          : undefined
      }
      onToggleMore={toggleMore}
    />
  )
}

/** 手机列表页的账户栏（搜索时没有，同 session-search 390） */
export function PlayPhoneFooter({ ui, act }: PlaySlotProps) {
  const a = useA(ui.screen)
  if (a.query != null) return null
  return (
    <PiAccountFooter
      link={piLinkSummary(MOCK_LINK)}
      variant="phone"
      pressed={ui.view === "settings" ? "settings" : ui.sheet === C_SHEET_DISPLAY_OPTIONS ? "options" : undefined}
      onOpenOptions={() => act.openSheet(C_SHEET_DISPLAY_OPTIONS)}
      onOpenSettings={act.openSettings}
    />
  )
}

/* ======================= 槽位：顶栏 ======================= */

/** 顶栏：桌面 = 标题 + 悬停卡（Radix HoverCard）+ 分屏钮（= ⌘.）；手机列表（搜索钮 → 搜索框 + 取消）/ 对话页（‹、点标题、…） */
export function PlayTopBar({ ui, act, variant }: PlaySlotProps) {
  const a = useA(ui.screen)
  // session-info 起始状态：悬停卡一打开就开着（之后照常跟悬停）
  const [card, setCard] = useState(ui.screen === "session-info")
  const h = head(ui.roomId, a)
  if (variant === "desktop") {
    return (
      <PiTopBar
        variant="desktop"
        title={h.title}
        platform={h.platform}
        hoverCard={infoCard(ui.roomId, "desktop", a)}
        hoverCardOpen={card}
        onHoverCardOpenChange={setCard}
        paneOpen={ui.pane != null}
        onTogglePane={act.togglePane}
      />
    )
  }
  if (ui.phonePage === "list") {
    if (a.query != null) {
      return (
        <PiTopBar
          variant="phone-list"
          search={
            <>
              <ASearchField
                variant="phone"
                value={a.query}
                autoFocus
                onValueChange={(value) => setA({ query: value })}
                onClear={() => setA({ query: "" })}
                onEscape={() => exitSearch(PHONE_SEARCH_BTN)}
              />
              <ATextButton touch className="text-[16px] text-(--cw-text)" onClick={() => exitSearch(PHONE_SEARCH_BTN)}>
                取消
              </ATextButton>
            </>
          }
        />
      )
    }
    return <PiTopBar variant="phone-list" onNewSession={act.newSession} onSearch={enterSearch} />
  }
  return (
    <PiTopBar
      variant="phone-chat"
      title={h.title}
      platform={h.platform}
      backCount={piOtherAttentionCount(ui.roomId, attentionOf(a), h.device?.id)}
      onBack={() => act.setPhonePage("list")}
      onTitleClick={() => act.openSheet(A_SHEET_SESSION_INFO)}
      // 顶栏 …：当前会话的会话菜单 sheet（design B04 / J07；"复制工作目录"一项未出图，P5 接）
      actions={<PiIconButton label="会话菜单" icon={<Ellipsis />} data-pi-session-more="" onClick={() => openPhoneMenu(ui.roomId, PHONE_MORE, act)} />}
    />
  )
}

/* ======================= 改名 / 删除 / 配对（桌面弹窗、手机 sheet 共用） ======================= */

const FIELD =
  "h-(--cw-pi-field-h) w-full min-w-0 rounded-(--cw-radius-input) border border-solid border-(--cw-border-strong) bg-(--cw-surface) px-2.5 text-(--cw-text) outline-none"

function viewportOf(variant: "desktop" | "phone") {
  return variant
}

/** 改名（G11）：输入 + 黑色"保存"，去空白后非空才能保存；Enter = 保存。焦点进输入框，关闭后回行 */
function RenameDialog({ variant, title, onSave, onClose }: { variant: "desktop" | "phone"; title: string; onSave: (title: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(title)
  const phone = variant === "phone"
  const next = value.trim()
  const save = () => {
    if (next) onSave(next)
  }
  return (
    <PiDialog
      title="重命名会话"
      viewport={viewportOf(variant)}
      width={360}
      returnFocus={returnToTarget}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <>
          <PiButton kind="outline" variant={variant} className={phone ? "flex-1" : undefined} onClick={onClose}>
            取消
          </PiButton>
          <PiButton variant={variant} className={phone ? "flex-1" : undefined} disabled={!next} data-cw-id="pi-rename-save" onClick={save}>
            保存
          </PiButton>
        </>
      }
    >
      <input
        data-cw-id="pi-rename-input"
        aria-label="会话名称"
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          event.preventDefault()
          save()
        }}
        onFocus={(event) => event.currentTarget.select()}
        className={cn(FIELD, phone ? "text-[16px]" : "text-(length:--cw-text-md)")}
      />
    </PiDialog>
  )
}

/** 删除确认（G13）：危险弹窗，焦点进"取消"；删掉后行不在了，焦点回顶栏标题 */
function DeleteDialog({ variant, id, a, onDelete, onClose }: { variant: "desktop" | "phone"; id: string; a: AState; onDelete: () => void; onClose: () => void }) {
  const phone = variant === "phone"
  const device = mockDevice(sessionOf(id)?.deviceId)
  const deviceName = device?.name ?? "这台设备"
  return (
    <PiDialog
      title="删除会话"
      danger
      viewport={viewportOf(variant)}
      width={360}
      returnFocus={returnToTarget}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <>
          <PiButton kind="outline" variant={variant} className={phone ? "flex-1" : undefined} data-pi-autofocus="" onClick={onClose}>
            取消
          </PiButton>
          <PiButton variant={variant} className={phone ? "flex-1" : undefined} data-cw-id="pi-delete-confirm" onClick={onDelete}>
            删除
          </PiButton>
        </>
      }
    >
      <p className={cn("m-0 text-(--cw-text-2)", phone ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-[19px]")}>
        {/* P9 B：画廊按新 relay（session.purge）+ 设备有 trash 的写法；旧 relay / 无 trash 的两种在 PiDeleteDialog 里 */}
        「{titleOf(id, a)}」会移到 {deviceName} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。
      </p>
    </PiDialog>
  )
}

/** 设备与配对（C05）放进可交互 PiDialog：焦点进"完成"（主按钮），命令页签可切换 */
function PairingDialog({ variant, onClose }: { variant: "desktop" | "phone"; onClose: () => void }) {
  const [platform, setPlatform] = useState<"unix" | "windows">("unix")
  const phone = variant === "phone"
  return (
    <PiDialog
      title="设备与配对"
      viewport={viewportOf(variant)}
      width={560}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      footer={
        <PiButton variant={variant} className={phone ? "w-full" : undefined} onClick={onClose}>
          完成
        </PiButton>
      }
    >
      <PiDevicePairing
        variant={variant}
        devices={MOCK_DEVICES}
        pair={A_PAIR}
        now={MOCK_NOW}
        commandPlatform={platform}
        onCommandPlatformChange={setPlatform}
      />
    </PiDialog>
  )
}

function renameTarget(title: string) {
  const id = aState.target?.id
  if (id) setA((cur) => ({ titles: { ...cur.titles, [id]: title } }))
}

function deleteTarget() {
  const id = aState.target?.id
  if (id) setA((cur) => ({ deleted: cur.deleted.includes(id) ? cur.deleted : [...cur.deleted, id] }))
}

/* ======================= 槽位：手机 sheet / 桌面弹窗 ======================= */

/** a 区的手机 sheet：会话信息（点标题）、会话菜单（长按 / 顶栏 …）、改名、删除确认、设备与配对 */
export function PlayASheets({ ui, act }: PlaySlotProps) {
  const a = useA(ui.screen)
  const target = a.target
  if (ui.sheet === A_SHEET_SESSION_INFO) {
    return (
      <PiSheet
        title="会话信息"
        onOpenChange={(open) => {
          if (!open) act.closeSheet()
        }}
        footer={
          <>
            <PiButton
              kind="outline"
              variant="phone"
              className="flex-1"
              onClick={() => {
                setA({ target: { id: ui.roomId, returnTo: PHONE_TITLE } })
                act.openSheet(A_RENAME)
              }}
            >
              重命名
            </PiButton>
            <PiButton variant="phone" className="flex-1" onClick={act.closeSheet}>
              用量明细
            </PiButton>
          </>
        }
      >
        {infoCard(ui.roomId, "phone", a)}
      </PiSheet>
    )
  }
  if (ui.sheet === A_SESSION_MENU && target) {
    const session = menuSessionOf(target.id, a, ui)
    const s = sessionOf(target.id)
    if (!session || !s) return null
    return (
      <PiSheet
        title={session.title}
        subtitle={`${mockDevice(s.deviceId)?.name ?? ""}/${piBaseName(s.cwd)} · ${session.messageCount} 条`}
        returnFocus={returnToTarget}
        onOpenChange={(open) => {
          if (!open) act.closeSheet()
        }}
      >
        <PiSessionMenu variant="phone" session={session} onSelect={(action) => onMenuAction(action, target.id, target.returnTo, "phone", act)} />
      </PiSheet>
    )
  }
  if (ui.sheet === A_RENAME && target) {
    return (
      <RenameDialog
        variant="phone"
        title={titleOf(target.id, a)}
        onSave={(title) => {
          renameTarget(title)
          act.closeSheet()
        }}
        onClose={act.closeSheet}
      />
    )
  }
  if (ui.sheet === A_DELETE && target) {
    return (
      <DeleteDialog
        variant="phone"
        id={target.id}
        a={a}
        onDelete={() => {
          deleteTarget()
          act.closeSheet()
        }}
        onClose={act.closeSheet}
      />
    )
  }
  if (ui.sheet === A_PAIRING) return <PairingDialog variant="phone" onClose={act.closeSheet} />
  return null
}

/** a 区的桌面弹窗：改名、删除确认、设备与配对（portal 到 body，--cw-pi-z-modal）；关着时什么都不渲染 */
export function PlayADialogs({ ui, act }: PlaySlotProps) {
  const a = useA(ui.screen)
  const target = a.target
  if (ui.dialog === A_RENAME && target) {
    return (
      <RenameDialog
        variant="desktop"
        title={titleOf(target.id, a)}
        onSave={(title) => {
          renameTarget(title)
          act.closeDialog()
        }}
        onClose={act.closeDialog}
      />
    )
  }
  if (ui.dialog === A_DELETE && target) {
    return (
      <DeleteDialog
        variant="desktop"
        id={target.id}
        a={a}
        onDelete={() => {
          deleteTarget()
          act.closeDialog()
        }}
        onClose={act.closeDialog}
      />
    )
  }
  if (ui.dialog === A_PAIRING) return <PairingDialog variant="desktop" onClose={act.closeDialog} />
  return null
}
