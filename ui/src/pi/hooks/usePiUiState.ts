import { useEffect, useMemo, useRef, useState } from "react"
import type { PiBlockedBy } from "@/pi/model/composerButton"
import { DEFAULT_PI_PREFS, LEGACY_STYLE_KEY, migratePiPrefs, PI_PREFS_KEY, setPiPref, storedThemeOf, type PiPrefs, type PiThemePref } from "@/pi/model/prefs"
import type { PiUiVariant } from "@/pi/variants/types"

/*
 * 新界面的本机界面状态（plan §7.0、P5.3；取代 shell/shellStore.ts，后者 P7 删）。
 * PiApp 里调一次（桌面 / 手机切换时状态不丢），经 PiContainerProps 的 ui / act 交给所有容器。
 * 存 localStorage 的只有：侧栏 expanded / rail、右 pane 的视图、"更多 N"展开的组（键 pi_remote_pi_ui），
 * 以及显示选项等偏好（model/prefs.ts 的 PI_PREFS_KEY，第一次读时从旧键迁移）。其余是会话内状态，刷新即清。
 * 别的标签页改了偏好（storage 事件）：只接主题（P6.4，清单 D2），接过来的主题不写回存储（见 usePiUiState 里的 adoptedTheme）。
 * 开发画廊的 #/live 用 seed 摆起始状态、persist: false（不读不写存储，L2 对图稳定）。
 * 契约由 p5-base 定（R2/p5-lanes.md §2）：各线只读、只调 act；要加字段或动作写 lane-requests。
 */

/** 主区视图：会话 / 新建会话 / 设置 / 收件箱（设计 D §1 的全局待答清单） */
export type PiView = "session" | "new" | "settings" | "inbox"

/** 右 pane（桌面）/ 推入页（手机）当前的视图 */
export type PiPaneView = "changes" | "terminal" | "file"

/** 菜单、sheet、弹窗的打开状态：id 带线名前缀（"a:session-menu"、"c:model"），arg 是它作用的对象（会话 id、文件路径……） */
export interface PiUiOverlay {
  id: string
  arg?: string
}

export interface PiUi {
  view: PiView
  /** 桌面侧栏（⌘B）；存储 */
  sidebar: "expanded" | "rail"
  /** 右 pane / 推入页；null = 关着。存储（刷新后还是上次的视图） */
  pane: PiPaneView | null
  /** 文件视图当前的文件路径（pane = "file" 时） */
  file: string | null
  /** 命令面板（⌘K 只开这里，D-01） */
  paletteOpen: boolean
  /** 手机：会话列表页 / 对话页 */
  phonePage: "list" | "chat"
  /** 侧栏搜索：null = 没在搜；"" = 搜索框刚打开 */
  search: string | null
  /** 锚定菜单和 tray 上方的浮层面板（桌面） */
  menu: PiUiOverlay | null
  /** 手机 sheet（PiPhonePage 的 sheet 槽；390 下的弹窗也是 sheet） */
  sheet: PiUiOverlay | null
  /** 桌面弹窗（PiDesktopShell 的 overlay 槽） */
  dialog: PiUiOverlay | null
  /** "更多 N"展开的组（model/sidebarGroups.ts 的 sidebarGroupKey）；存储；改分组时清空 */
  expanded: readonly string[]
  /** 显示选项与设置里的偏好；存储 */
  prefs: PiPrefs
  /** 有可答的审批卡时是 "approval"：ApprovalContainer（b）写，ComposerContainer（c）读（D-08） */
  blockedBy: PiBlockedBy
}

/** 起始状态（#/live 的 seed）：prefs 可以只给几项，其余用默认值 */
export type PiUiSeed = Partial<Omit<PiUi, "prefs">> & { prefs?: Partial<PiPrefs> }

export interface PiUiActions {
  /** 回到会话视图（选哪个会话由调用方调 relay.selectRoom / selectListedSession）；手机切到对话页 */
  openSession(): void
  /** 新建会话（⇧⌘O）：关右 pane，手机离开列表页 */
  newSession(): void
  /** 设置（⌘,） */
  openSettings(): void
  /** 收件箱（设计 D §1：侧栏「待答」行进入） */
  openInbox(): void
  setView(view: PiView): void
  /** ⌘B */
  toggleSidebar(): void
  setPane(pane: PiPaneView | null): void
  /** ⌘.：关着时打开上一次的视图（默认改动）；不在会话视图时不动 */
  togglePane(): void
  /** 打开文件视图 */
  openFile(path: string): void
  setPaletteOpen(open: boolean): void
  setPhonePage(page: "list" | "chat"): void
  setSearch(query: string | null): void
  openMenu(menu: PiUiOverlay): void
  closeMenu(): void
  openSheet(sheet: PiUiOverlay): void
  closeSheet(): void
  openDialog(dialog: PiUiOverlay): void
  closeDialog(): void
  /** "更多 N" / "收起" */
  toggleExpanded(groupKey: string): void
  /** 改偏好；改分组时一并清空 expanded（setPiPref 的 clearExpanded） */
  setPref<K extends Exclude<keyof PiPrefs, "v">>(key: K, value: PiPrefs[K]): void
  /**
   * 换界面变体（PI-UI-REFS 架构线，等价于 setPref("ui", variant)）。只换展示树：
   * relay / 房间 / 草稿都在 PiApp 的 useRelay 那一份里，切换不重连、不丢状态（brief §架构契约 3）。
   */
  setUiVariant(variant: PiUiVariant): void
  setBlockedBy(blockedBy: PiBlockedBy): void
}

export const PI_UI_KEY = "pi_remote_pi_ui"

const DEFAULT_UI: PiUi = {
  view: "session",
  sidebar: "expanded",
  pane: null,
  file: null,
  paletteOpen: false,
  phonePage: "chat",
  search: null,
  menu: null,
  sheet: null,
  dialog: null,
  expanded: [],
  prefs: DEFAULT_PI_PREFS,
  blockedBy: null,
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    storage()?.setItem(key, value)
  } catch {
    // 存储不可用 / 配额满：界面状态只在本页有效，不报错
  }
}

const PANES: readonly string[] = ["changes", "terminal", "file"]

/** 存储 → 界面状态里能存的那几项；坏数据逐项丢掉 */
function loadStored(): Partial<PiUi> {
  const out: Partial<PiUi> = { prefs: migratePiPrefs(read(PI_PREFS_KEY), read(LEGACY_STYLE_KEY)) }
  let raw: unknown = null
  try {
    raw = JSON.parse(read(PI_UI_KEY) ?? "null")
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  const rec = raw as Record<string, unknown>
  if (rec.sidebar === "expanded" || rec.sidebar === "rail") out.sidebar = rec.sidebar
  if (rec.pane === null || (typeof rec.pane === "string" && PANES.includes(rec.pane))) out.pane = rec.pane as PiPaneView | null
  if (Array.isArray(rec.expanded)) out.expanded = rec.expanded.filter((k): k is string => typeof k === "string")
  return out
}

/** 两份偏好只差主题（偏好都经 migratePiPrefs 规整过：字段齐全，值都是标量） */
function onlyThemeChanged(prev: PiPrefs, next: PiPrefs): boolean {
  if (prev.theme === next.theme) return false
  return (Object.keys(next) as (keyof PiPrefs)[]).every((key) => key === "theme" || prev[key] === next[key])
}

function initialUi(seed: PiUiSeed | undefined, persist: boolean): PiUi {
  const stored = persist ? loadStored() : {}
  const { prefs: seedPrefs, ...rest } = seed ?? {}
  const prefs = seedPrefs ? migratePiPrefs({ ...(stored.prefs ?? DEFAULT_PI_PREFS), ...seedPrefs }) : (stored.prefs ?? DEFAULT_PI_PREFS)
  return { ...DEFAULT_UI, ...stored, ...rest, prefs }
}

/**
 * 界面状态 + 动作。seed 只在第一次渲染时用；persist（默认 true）= 读写 localStorage。
 * 返回的 act 引用稳定，可以放进依赖数组。
 */
export function usePiUiState(options: { seed?: PiUiSeed; persist?: boolean } = {}): [PiUi, PiUiActions] {
  const persist = options.persist ?? true
  const [ui, setUi] = useState<PiUi>(() => initialUi(options.seed, persist))
  const lastPane = useRef<PiPaneView>(ui.pane ?? "changes")
  useEffect(() => {
    if (ui.pane) lastPane.current = ui.pane
  }, [ui.pane])

  useEffect(() => {
    if (!persist) return
    write(PI_UI_KEY, JSON.stringify({ v: 1, sidebar: ui.sidebar, pane: ui.pane, expanded: ui.expanded }))
  }, [persist, ui.sidebar, ui.pane, ui.expanded])
  // 别的标签页改了偏好（storage 事件）：只接主题（别的偏好照旧各页各管各的），而且接过来的这一次不写回存储。
  // 本页别的偏好可能落后于存储，写回去会盖掉那一页刚改的，两页再来回互写、停不下来（P6 审查 P6-R1-1）。
  const adoptedTheme = useRef<PiThemePref | null>(null)
  const lastPrefs = useRef<PiPrefs | null>(null)
  useEffect(() => {
    if (!persist) return
    const prev = lastPrefs.current
    const adopted = adoptedTheme.current
    lastPrefs.current = ui.prefs
    adoptedTheme.current = null
    if (prev && adopted === ui.prefs.theme && onlyThemeChanged(prev, ui.prefs)) return
    write(PI_PREFS_KEY, JSON.stringify(ui.prefs))
  }, [persist, ui.prefs])
  useEffect(() => {
    if (!persist) return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PI_PREFS_KEY) return
      const theme = storedThemeOf(event.newValue)
      if (!theme) return
      adoptedTheme.current = theme
      setUi((cur) => (cur.prefs.theme === theme ? cur : { ...cur, prefs: setPiPref(cur.prefs, "theme", theme).prefs }))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [persist])

  const act = useMemo<PiUiActions>(() => {
    const patch = (next: (cur: PiUi) => Partial<PiUi>) => setUi((cur) => ({ ...cur, ...next(cur) }))
    return {
      openSession: () => patch(() => ({ view: "session", phonePage: "chat" })),
      newSession: () => patch(() => ({ view: "new", pane: null, phonePage: "chat", search: null })),
      openSettings: () => patch(() => ({ view: "settings", pane: null })),
      openInbox: () => patch(() => ({ view: "inbox", pane: null })),
      setView: (view) => patch(() => ({ view })),
      // P13：共享侧栏（cursor / claude / codex / 手机）的折叠读 prefs.sidebarCollapsed；
      // 旧 ui.sidebar 继续保留（#/play 舞台用），两边一起翻，⌘B 才真的看得见效果。
      toggleSidebar: () =>
        patch((cur) => ({
          sidebar: cur.sidebar === "expanded" ? "rail" : "expanded",
          prefs: { ...cur.prefs, sidebarCollapsed: !cur.prefs.sidebarCollapsed },
        })),
      setPane: (pane) => patch(() => ({ pane })),
      togglePane: () => patch((cur) => (cur.view !== "session" ? {} : { pane: cur.pane ? null : lastPane.current })),
      openFile: (path) => patch(() => ({ pane: "file", file: path })),
      setPaletteOpen: (paletteOpen) => patch(() => ({ paletteOpen })),
      setPhonePage: (phonePage) => patch(() => ({ phonePage })),
      setSearch: (search) => patch(() => ({ search })),
      openMenu: (menu) => patch(() => ({ menu })),
      closeMenu: () => patch(() => ({ menu: null })),
      openSheet: (sheet) => patch(() => ({ sheet })),
      closeSheet: () => patch(() => ({ sheet: null })),
      openDialog: (dialog) => patch(() => ({ dialog })),
      closeDialog: () => patch(() => ({ dialog: null })),
      toggleExpanded: (groupKey) =>
        patch((cur) => ({ expanded: cur.expanded.includes(groupKey) ? cur.expanded.filter((k) => k !== groupKey) : [...cur.expanded, groupKey] })),
      setPref: (key, value) =>
        patch((cur) => {
          const { prefs, clearExpanded } = setPiPref(cur.prefs, key, value)
          return clearExpanded ? { prefs, expanded: [] } : { prefs }
        }),
      setUiVariant: (variant) =>
        patch((cur) => (cur.prefs.ui === variant ? {} : { prefs: setPiPref(cur.prefs, "ui", variant).prefs })),
      setBlockedBy: (blockedBy) => setUi((cur) => (cur.blockedBy === blockedBy ? cur : { ...cur, blockedBy })),
    }
  }, [])
  return [ui, act]
}
