/*
 * c 线的可交互件（#/play，R2/p4-lanes.md §4）：dock（composer、tray、框下状态行）、新建会话页、设置页、c 区的 sheet 与全屏浮层。
 * 归 c 线：真输入框、/ @ 菜单、+ / 模型 / 投递 / 设备 / 目录菜单（桌面锚定菜单、手机 sheet）、命令面板（⌘K / 斜杠 /commands）、
 * tray 面板（排队、任务）、用量弹窗、显示选项、设置页都接在这里。PlayApp.tsx 只认 PlayDock / PlayNewSession / PlaySettings /
 * PlayCSheets / PlayCOverlays 这几个导出；PlayDisplayOptionsMenu + C_SHEET_DISPLAY_OPTIONS 给 a 线的账户区滑杆用（lane-requests/p4-c.md）。
 *
 * c 线自己的状态（草稿、引用、模型、投递、偏好、新建会话的设备 / 目录、tray 面板、用量弹窗）放在本文件的小 store 里：
 * PlayDock、PlayCSheets、PlayCOverlays 由 PlayApp 摆在不同的槽位，没有共同的 c 线祖先。按起始状态 id 分开（换路由就重置）。
 * 外壳状态（视图、回合在跑、手机当前 sheet、命令面板开合）照旧走 ui / act。
 */
import { useRef, useSyncExternalStore, type ReactNode } from "react"
import { MenuItem } from "@/components/kit"
import { SuggestionPills } from "@/components/kit/composer/SuggestionPills"
import { ModelExplainerCard } from "@/components/kit/menu/ModelExplainerCard"
import { PiTaskPanel } from "@/components/pi/conversation/PiTaskPanel"
import {
  PiAttachMenu,
  PiComposerDock,
  PiDeliveryOptions,
  PiDisplayOptions,
  PiFolderBrowser,
  PiFolderPicker,
  PiMenuCloseContext,
  PiModelMenu,
  PiQueuePanel,
  PiUsageDialog,
  type CImage,
  type CPrefs,
  type PiAttachPick,
  type PiTrayItem,
  type SlashRow,
} from "@/components/pi/composer"
import { PiCommandPalette, type PiPaletteRun } from "@/components/pi/composer/PiCommandPalette"
import { PiEmptyComposer, type PiEmptyMenu } from "@/components/pi/composer/PiEmptyComposer"
import { PiSettingsPage } from "@/components/pi/composer/PiSettingsPage"
import type { PiRemoteQueueState } from "@/components/pi/shared/types"
import { PiDeviceMenu, PiPhonePage, PiSheet, PiTopBar } from "@/components/pi/shared"
import { BROWSE_REASON } from "@/pi/model/folderBrowser"
import { deviceScopeLabel } from "@/pi/model/newSession"
import { TASKS, TRAY_CHANGES, TRAY_TASKS, TRAY_TERMINAL } from "@/pi/dev/fixtures/gallery/b"
import {
  C_HOST_QUEUE,
  C_MODELS,
  C_NOW,
  C_PREFS,
  C_REMOTE_QUEUE,
  C_STATS,
  GEMINI_EXPLAINER,
  MENTION_POOL,
  NEW_SESSION_SUGGESTIONS,
  PALETTE_COMMANDS,
  PALETTE_SESSIONS,
  RECENT_FOLDERS,
  THINKING_CURRENT,
  THINKING_LEVELS,
  slashBrowseGroups,
} from "@/pi/dev/fixtures/gallery/c"
import { MOCK_DEVICES, MOCK_NOW, MOCK_RELAY_HOST, MOCK_USAGE, mockSessionCounts } from "@/pi/dev/fixtures/gallery/shared"
import { PlayApproval, PlayStickTray } from "./b"
import { B_SHEET_TASKS } from "./presets-b"
import type { PlaySlotProps } from "./state"

/* ======================= sheet / 浮层 id（带线名前缀，act.openSheet 用） ======================= */

export const C_SHEET_ATTACH = "c:attach"
export const C_SHEET_MODEL = "c:model"
export const C_SHEET_DELIVERY = "c:delivery"
export const C_SHEET_QUEUE = "c:queue"
/** 显示选项（手机列表页账户区滑杆 → act.openSheet(C_SHEET_DISPLAY_OPTIONS)，a 线接入口） */
export const C_SHEET_DISPLAY_OPTIONS = "c:display-options"
/** 新建会话页的四个 sheet：c:new-device / c:new-folder / c:new-plus / c:new-model */
const NEW_SHEET_PREFIX = "c:new-"

/* ======================= c 线的小 store ======================= */

interface CPlayState {
  draft: string
  mentions: string[]
  images: CImage[]
  /** 当前模型（C_MODELS 的 key） */
  model: string
  thinking: string
  delivery: "steer" | "follow_up"
  prefs: CPrefs
  /** 新建会话：设备 id、目录（完整路径）、草稿、桌面开着的菜单 */
  device: string
  folder: string
  newDraft: string
  newMenu: PiEmptyMenu | null
  /** P9 C：文件夹浏览器开着（桌面 PiDialog / 手机全高 sheet） */
  browsing: boolean
  /** 桌面 dock 的 + / 模型菜单 */
  plus: boolean
  modelMenu: boolean
  /** 桌面 tray 上方的面板 */
  panel: "queue" | "tasks" | null
  /** 用量弹窗；关闭后焦点回哪（data-cw-id，不给 = 打开前的焦点） */
  usage: boolean
  usageReturn: string | null
  queue: PiRemoteQueueState
  /** 最近一次 c 线动作（写在 dock 的 data-pi-play-c-last 上，给人看、给用例断言） */
  last: string | null
}

type CPatch = Partial<CPlayState> | ((cur: CPlayState) => Partial<CPlayState>)

function initialState(screen: string): CPlayState {
  return {
    draft: "",
    mentions: [],
    images: [],
    model: C_MODELS.find((m) => m.current)?.key ?? C_MODELS[0]!.key,
    thinking: THINKING_CURRENT,
    delivery: "steer",
    prefs: { ...C_PREFS },
    device: MOCK_DEVICES[0]?.id ?? "",
    folder: "/Users/dev/code/pi-remote",
    newDraft: "",
    newMenu: screen === "new-session-picker" ? "folder" : null,
    browsing: false,
    plus: false,
    modelMenu: false,
    panel: screen === "queue-panel" ? "queue" : null,
    usage: screen === "dialog-usage",
    usageReturn: null,
    queue: C_REMOTE_QUEUE,
    last: null,
  }
}

let current: { screen: string; state: CPlayState } | null = null
const listeners = new Set<() => void>()
function readState(screen: string): CPlayState {
  if (!current || current.screen !== screen) current = { screen, state: initialState(screen) }
  return current.state
}
function writeState(screen: string, patch: CPatch) {
  const cur = readState(screen)
  current = { screen, state: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } }
  for (const listener of [...listeners]) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function useCPlay(screen: string): [CPlayState, (patch: CPatch) => void] {
  const state = useSyncExternalStore(
    subscribe,
    () => readState(screen),
    () => readState(screen),
  )
  return [state, (patch) => writeState(screen, patch)]
}

/* ======================= 小工具 ======================= */

const SLASH_GROUPS = slashBrowseGroups()
/** 带参数的命令：选中后把"/命令 "填进输入框，等用户接着写；其余命令选中即执行 */
const SLASH_WITH_ARG = new Set(["model", "thinking", "name", "follow"])
const GEMINI = "google/gemini-2.5-pro"

const byCwId = (id: string) => () => document.querySelector<HTMLElement>(`[data-cw-id="${id}"]`)
const focusLater = (id: string) => window.setTimeout(() => byCwId(id)()?.focus({ preventScroll: true }), 30)

function modelsOf(key: string) {
  return C_MODELS.map((m) => ({ ...m, current: m.key === key }))
}
/** composer 里的模型名：去掉厂商前缀（和 C_MODEL_LABEL 的"Sonnet 4.5"一个写法） */
function modelLabel(key: string): string {
  const m = C_MODELS.find((x) => x.key === key)
  return (m?.name ?? key).replace(/^Claude /, "")
}
function queueCount(q: PiRemoteQueueState): number {
  return q.items.filter((i) => i.status === "pending").length + C_HOST_QUEUE.steering.length + C_HOST_QUEUE.followUp.length
}
function baseName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path
}

/* P9 C：新建会话的文件夹菜单 / 浏览器（#/play 的假设备）：mock 一台新 attach——浏览根目录 = 设备用户的家目录 */
const PLAY_HOME = "/Users/dev"
const PLAY_DIR_TREE: Record<string, { name: string; path: string }[]> = {
  "/Users/dev": [
    { name: "code", path: "/Users/dev/code" },
    { name: "work", path: "/Users/dev/work" },
    { name: "Desktop", path: "/Users/dev/Desktop" },
    { name: ".config", path: "/Users/dev/.config" },
  ],
  "/Users/dev/code": [
    { name: "pi-remote", path: "/Users/dev/code/pi-remote" },
    { name: "notes-app", path: "/Users/dev/code/notes-app" },
    { name: "dotfiles", path: "/Users/dev/code/dotfiles" },
    { name: ".git", path: "/Users/dev/code/.git" },
  ],
  "/Users/dev/work": [
    { name: "billing-service", path: "/Users/dev/work/billing-service" },
    { name: "infra", path: "/Users/dev/work/infra" },
  ],
  "/Users/dev/code/pi-remote": [
    { name: "src", path: "/Users/dev/code/pi-remote/src" },
    { name: "test", path: "/Users/dev/code/pi-remote/test" },
  ],
  "/Users/dev/code/pi-remote/src": [
    { name: "components", path: "/Users/dev/code/pi-remote/src/components" },
    { name: "pi", path: "/Users/dev/code/pi-remote/src/pi" },
  ],
}

/** list_dirs 的 mock：只认 PLAY_DIR_TREE 里的目录；隐藏目录按 showHidden 过滤 */
async function playListDirs(path?: string, showHidden?: boolean) {
  const dir = path || PLAY_HOME
  const entries = (PLAY_DIR_TREE[dir] ?? []).filter((entry) => showHidden === true || !entry.name.startsWith("."))
  const parent = dir === PLAY_HOME ? null : dir.split("/").slice(0, -1).join("/") || PLAY_HOME
  return { root: PLAY_HOME, path: dir, parent, entries, truncated: false }
}

/** 这台 mock 设备的文件夹数据：白名单 + 最近（去重）；浏览能力按在线 / 离线降级 */
function playFolderData(device: (typeof MOCK_DEVICES)[number]) {
  const knownFolders = [...device.projects]
  for (const path of RECENT_FOLDERS) if (device.projects.some((p) => path.startsWith(p)) && !knownFolders.includes(path)) knownFolders.push(path)
  const online = device.online
  return {
    scopeLabel: deviceScopeLabel(device, MOCK_DEVICES),
    knownFolders,
    canBrowse: online,
    browseReason: online ? null : BROWSE_REASON.offline,
  }
}

/** 把 PiMenuCloseContext 交给 sheet 里的菜单内容：listbox 行（模型、目录）选中后关 sheet */
function SheetHost({ close, children }: { close: () => void; children: ReactNode }) {
  return <PiMenuCloseContext.Provider value={close}>{children}</PiMenuCloseContext.Provider>
}

/** 桌面模型菜单的内容（dock 和新建会话共用） */
function ModelMenuContent({ c, set, variant }: { c: CPlayState; set: (patch: CPatch) => void; variant: "desktop" | "phone" }) {
  return (
    <PiModelMenu
      variant={variant}
      models={modelsOf(c.model)}
      thinkingLevels={THINKING_LEVELS}
      thinking={c.thinking}
      onSelectModel={(model) => set({ model, last: `model:${model}` })}
      onThinkingChange={(thinking) => set({ thinking })}
      explainerFor={(key) =>
        key === GEMINI ? (
          // 费用一行用 Pi 的警告橙（--cw-orange 在白底只有 3.1:1），和 c/model-menu 屏同一个写法
          <ModelExplainerCard data-cw-id="pi-model-explainer" explainer={GEMINI_EXPLAINER} className="[--cw-orange:var(--cw-pi-warning,#8A6516)]" />
        ) : null
      }
    />
  )
}

/** + 菜单选中一项（dock 用） */
function useAttachPick(screen: string, set: (patch: CPatch) => void) {
  const imageInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLInputElement>(null)
  const pick = (key: PiAttachPick) => {
    if (key === "image") imageInput.current?.click()
    else if (key === "text") textInput.current?.click()
    else if (key === "commands") {
      // "命令…" = 在输入框里打 /（斜杠菜单由输入内容打开）
      set({ draft: "/", last: "attach:commands" })
      focusLater("pi-composer-input")
    } else set({ usage: true, usageReturn: "pi-composer-plus", last: "attach:usage" })
  }
  const inputs = (
    <>
      <input
        ref={imageInput}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ""
          writeState(screen, (cur) => ({
            images: [...cur.images, ...files.map((f) => ({ mimeType: f.type || "image/png", bytes: f.size }))].slice(0, 5),
            last: "attach:image",
          }))
        }}
      />
      <input
        ref={textInput}
        type="file"
        hidden
        accept="text/*,.md,.txt,.json,.ts,.tsx,.js,.py,.sh,.go"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ""
          if (!file || file.size > 64 * 1024) return
          void file.text().then((text) => writeState(screen, (cur) => ({ draft: cur.draft + text, last: "attach:text" })))
        }}
      />
    </>
  )
  return { pick, inputs }
}

/* ======================= dock ======================= */

/** 会话视图的 dock：回合在跑 = S3 / S4（黑圆停止或发送 + 裸停止，Esc 第 3 层停止它），否则 S0 / S1 */
export function PlayDock({ ui, act, variant }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  const phone = variant === "phone"
  const { pick, inputs } = useAttachPick(ui.screen, set)
  const hasContent = c.draft.trim().length > 0 || c.images.length > 0
  const state = ui.running ? (hasContent ? "S4" : "S3") : hasContent ? "S1" : "S0"
  const queueN = queueCount(c.queue)
  // b 线的 approval-waiting：审批卡在 dock 里（PlayApproval），输入只读、原因写在框下状态行（同画廊屏 b/approval-waiting）
  const approval = ui.screen === "approval-waiting"
  const tray: PiTrayItem[] = approval
    ? [{ ...TRAY_CHANGES, active: !phone && ui.pane === "changes" }]
    : ui.running
    ? [
        // 手机的任务 sheet 归 b 线（PlayBSheets，B_SHEET_TASKS）；桌面 tray 上方的任务浮层在这里
        { ...TRAY_TASKS, active: phone ? ui.sheet === B_SHEET_TASKS : c.panel === "tasks" },
        ...(ui.screen === "queue-panel" && queueN > 0
          ? [{ kind: "queue" as const, label: `排队 ${queueN}`, active: phone ? ui.sheet === C_SHEET_QUEUE : c.panel === "queue" }]
          : []),
        { ...TRAY_TERMINAL, active: !phone && ui.pane === "terminal" },
        { ...TRAY_CHANGES, active: !phone && ui.pane === "changes" },
      ]
    : [{ ...TRAY_CHANGES, active: ui.pane === "changes" }]
  const panelKind = phone ? null : c.panel === "queue" && queueN === 0 ? null : c.panel
  const onTrayItem = (kind: PiTrayItem["kind"]) => {
    if (kind === "tasks" || kind === "queue") {
      if (phone) act.openSheet(kind === "tasks" ? B_SHEET_TASKS : C_SHEET_QUEUE)
      else set({ panel: c.panel === kind ? null : kind })
      return
    }
    // 终端 / 改动：开关右 pane（手机的推入页归 b 线）
    if (!phone) act.setPane(ui.pane === kind ? null : kind)
  }
  const runSlash = (row: SlashRow) => {
    if (SLASH_WITH_ARG.has(row.key)) {
      set({ draft: `${row.name} ` })
      return
    }
    set({ draft: "", last: `slash:${row.name}` })
    if (row.key === "new") act.newSession()
    else if (row.key === "settings") act.openSettings()
    else if (row.key === "commands") act.setPaletteOpen(true)
    else if (row.key === "stats" || row.key === "usage") set({ usage: true, usageReturn: "pi-composer-input" })
  }
  const sheetToggle = (id: string) => (open: boolean) => (open ? act.openSheet(id) : act.closeSheet())
  return (
    <>
      {/* b 线的吸底状态（D21）：对话流离开底部时 tray 右端出"回到底部"钮和新消息数，点了贴回底部 */}
      <PlayStickTray>
        {(stick) => (
          <PiComposerDock
            {...stick}
            data-pi-play-c-last={c.last ?? undefined}
            variant={variant}
            state={state}
            approval={approval ? <PlayApproval ui={ui} act={act} variant={variant} /> : undefined}
            blockedBy={approval ? "approval" : null}
            draft={c.draft}
            onDraftChange={(draft) => set({ draft })}
            mentions={c.mentions}
            onMentionsChange={(mentions) => set({ mentions })}
            images={c.images}
            onRemoveImage={(index) => set({ images: c.images.filter((_, i) => i !== index) })}
            model={{ name: modelLabel(c.model), thinking: c.thinking }}
            tray={tray}
            onTrayItem={onTrayItem}
            panel={panelKind === "queue" ? (
              <PiQueuePanel
                variant="desktop"
                remote={c.queue}
                host={C_HOST_QUEUE}
                now={C_NOW}
                onAction={(id, action) =>
                  action === "cancel"
                    ? set({ queue: { ...c.queue, items: c.queue.items.filter((i) => i.id !== id) }, last: `queue:cancel:${id}` })
                    : set({ last: `queue:${action}:${id}` })
                }
              />
            ) : panelKind === "tasks" ? (
              <PiTaskPanel tasks={TASKS} />
            ) : undefined}
            onPanelClose={() => set({ panel: null })}
            status={
              approval
                ? { device: "MacBook Pro", branch: "main", note: "先回答上面的问题", tone: "warn" }
                : ui.running
                  ? { device: "MacBook Pro", branch: "main", delivery: c.delivery, running: true }
                  : { device: "MacBook Pro", branch: "main" }
            }
            onDeliveryChange={(delivery) => set({ delivery })}
            deliveryOpen={phone ? ui.sheet === C_SHEET_DELIVERY : undefined}
            onDeliveryOpenChange={phone ? sheetToggle(C_SHEET_DELIVERY) : undefined}
            plusOpen={phone ? ui.sheet === C_SHEET_ATTACH : c.plus}
            onPlusOpenChange={phone ? sheetToggle(C_SHEET_ATTACH) : (plus) => set({ plus })}
            plusMenu={phone ? undefined : <PiAttachMenu variant="desktop" className="w-[280px]" onPick={pick} />}
            modelOpen={phone ? ui.sheet === C_SHEET_MODEL : c.modelMenu}
            onModelOpenChange={phone ? sheetToggle(C_SHEET_MODEL) : (modelMenu) => set({ modelMenu })}
            modelMenu={phone ? undefined : <ModelMenuContent c={c} set={set} variant="desktop" />}
            slashGroups={SLASH_GROUPS}
            onSlashCommand={runSlash}
            mentionPool={MENTION_POOL}
            onSend={() => set({ draft: "", mentions: [], images: [], last: "send" })}
            onStop={act.stop}
          />
        )}
      </PlayStickTray>
      {inputs}
    </>
  )
}

/* ======================= 新建会话 ======================= */

function NewComposer({ ui, act, variant }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  const phone = variant === "phone"
  const device = MOCK_DEVICES.find((d) => d.id === c.device) ?? MOCK_DEVICES[0]!
  const folders = playFolderData(device)
  const phoneOpen = ui.sheet?.startsWith(NEW_SHEET_PREFIX) ? (ui.sheet.slice(NEW_SHEET_PREFIX.length) as PiEmptyMenu) : null
  const selectDevice = (id: string) => {
    const next = MOCK_DEVICES.find((d) => d.id === id)
    if (!next) return
    // 换了设备：目录不在它允许的目录里时换成它的第一个目录
    set((cur) => ({ device: id, folder: next.projects.includes(cur.folder) ? cur.folder : (next.projects[0] ?? ""), last: `device:${id}` }))
  }
  return (
    <PiEmptyComposer
      variant={variant}
      data-pi-play-c-last={c.last ?? undefined}
      device={{ name: device.name, platform: device.platform, offline: !device.online }}
      folder={c.folder ? baseName(c.folder) : null}
      model={{ name: modelLabel(c.model), thinking: c.thinking }}
      draft={c.newDraft}
      onDraftChange={(newDraft) => set({ newDraft })}
      // 发送时才启动 pi（待用户确认 12）：这里直接进会话视图
      onSend={() => {
        set({ newDraft: "", last: "new:send" })
        act.openSession()
      }}
      open={phone ? phoneOpen : c.newMenu}
      onOpenChange={phone ? (which) => (which ? act.openSheet(`${NEW_SHEET_PREFIX}${which}`) : act.closeSheet()) : (newMenu) => set({ newMenu })}
      deviceMenu={
        phone ? undefined : (
          <PiDeviceMenu
            devices={MOCK_DEVICES}
            counts={mockSessionCounts()}
            value={device.id}
            title="运行在"
            now={MOCK_NOW}
            onSelect={selectDevice}
            footer={<MenuItem onSelect={() => set({ last: "device:pair" })}>配对新设备…</MenuItem>}
          />
        )
      }
      folderMenu={
        phone ? undefined : (
          <PiFolderPicker
            variant="desktop"
            scopeLabel={folders.scopeLabel}
            platform={device.platform}
            recent={RECENT_FOLDERS.filter((p) => device.projects.includes(p))}
            knownFolders={folders.knownFolders}
            canBrowse={folders.canBrowse}
            browseReason={folders.browseReason}
            homeRoots={[PLAY_HOME]}
            value={c.folder}
            onBrowse={() => set({ browsing: true, last: "folder:browse" })}
            onSelect={(folder) => set({ folder, last: `folder:${folder}` })}
          />
        )
      }
      plusMenu={phone ? undefined : <PiAttachMenu variant="desktop" className="w-[280px]" commandsDisabled onPick={(k) => set({ last: `new-attach:${k}` })} />}
      modelMenu={phone ? undefined : <ModelMenuContent c={c} set={set} variant="desktop" />}
      below={variant === "desktop" ? <SuggestionPills data-cw-id="pi-new-suggestions" items={NEW_SESSION_SUGGESTIONS} /> : undefined}
    />
  )
}

/** 新建会话页手机的四个 sheet（设备、目录、+、模型） */
function NewSheets({ ui, act }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  const device = MOCK_DEVICES.find((d) => d.id === c.device) ?? MOCK_DEVICES[0]!
  const folders = playFolderData(device)
  const close = act.closeSheet
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  const which = ui.sheet?.startsWith(NEW_SHEET_PREFIX) ? ui.sheet.slice(NEW_SHEET_PREFIX.length) : null
  if (c.browsing) {
    return (
      <PiFolderBrowser
        viewport="phone"
        scopeLabel={folders.scopeLabel}
        initialPath={c.folder}
        listDirs={playListDirs}
        open={c.browsing}
        onOpenChange={(open) => {
          if (open) return
          set({ browsing: false })
          act.openSheet(`${NEW_SHEET_PREFIX}folder`)
        }}
        onPick={(folder) => set({ folder, browsing: false, last: `folder:${folder}` })}
      />
    )
  }
  if (which === "device") {
    return (
      <PiSheet title="运行在" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-device")}>
        <PiDeviceMenu
          devices={MOCK_DEVICES}
          counts={mockSessionCounts()}
          value={device.id}
          asSheet
          now={MOCK_NOW}
          onSelect={(id) => {
            const next = MOCK_DEVICES.find((d) => d.id === id)
            set((cur) => ({ device: id, folder: next?.projects.includes(cur.folder) ? cur.folder : (next?.projects[0] ?? ""), last: `device:${id}` }))
            close()
          }}
        />
      </PiSheet>
    )
  }
  if (which === "folder") {
    return (
      <PiSheet title="选择文件夹" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-folder")}>
        <SheetHost close={close}>
          <PiFolderPicker
            variant="phone"
            scopeLabel={folders.scopeLabel}
            platform={device.platform}
            recent={RECENT_FOLDERS.filter((p) => device.projects.includes(p))}
            knownFolders={folders.knownFolders}
            canBrowse={folders.canBrowse}
            browseReason={folders.browseReason}
            homeRoots={[PLAY_HOME]}
            value={c.folder}
            onBrowse={() => {
              close()
              set({ browsing: true, last: "folder:browse" })
            }}
            onSelect={(folder) => set({ folder, last: `folder:${folder}` })}
          />
        </SheetHost>
      </PiSheet>
    )
  }
  if (which === "plus") {
    return (
      <PiSheet title="添加" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-plus")}>
        <PiAttachMenu
          variant="phone"
          bare
          commandsDisabled
          onPick={(k) => {
            set({ last: `new-attach:${k}` })
            close()
          }}
        />
      </PiSheet>
    )
  }
  if (which === "model") {
    return (
      <PiSheet title="模型与思考" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-new-model")}>
        <SheetHost close={close}>
          <ModelMenuContent c={c} set={set} variant="phone" />
        </SheetHost>
      </PiSheet>
    )
  }
  return null
}

/** 新建会话（⇧⌘O）：桌面 = 主区正文；手机 = 整页 */
export function PlayNewSession(p: PlaySlotProps) {
  const { act, variant } = p
  if (variant === "phone") {
    return (
      <PiPhonePage
        topBar={<PiTopBar variant="phone-page" title="新会话" onBack={() => act.openSession()} />}
        contentClassName="h-full"
        dock={
          <div className="px-4 pt-2 pb-2">
            <NewComposer {...p} />
          </div>
        }
        sheet={<NewSheets {...p} />}
      >
        <div className="flex h-full flex-col justify-center px-4">
          <SuggestionPills
            data-cw-id="pi-new-suggestions"
            items={NEW_SESSION_SUGGESTIONS}
            className="flex-col items-stretch gap-2.5"
            pillClassName="h-11 w-full justify-center text-[15px]"
          />
        </div>
      </PiPhonePage>
    )
  }
  return (
    <div className="absolute inset-0 flex justify-center px-10 pt-[268px]">
      <div className="w-full max-w-[640px]">
        <NewComposer {...p} />
      </div>
    </div>
  )
}

/* ======================= 设置 ======================= */

/** 设置（⌘,）：桌面 = 主区正文；手机 = 整页。偏好改在 c 线 store 里（P5 换成 prefs.ts） */
export function PlaySettings({ ui, act, variant }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  const page = (
    <PiSettingsPage
      variant={variant}
      prefs={c.prefs}
      devices={MOCK_DEVICES}
      relayHost={MOCK_RELAY_HOST}
      now={C_NOW}
      onPrefsChange={(patch) => set((cur) => ({ prefs: { ...cur.prefs, ...patch } }))}
      onAction={(action) => set({ last: `settings:${action}` })}
    />
  )
  if (variant === "phone") {
    return (
      <PiPhonePage topBar={<PiTopBar variant="phone-page" title="设置" onBack={() => act.openSession()} />} scrollTop={0}>
        {page}
      </PiPhonePage>
    )
  }
  return <div data-pi-play-c-last={c.last ?? undefined} className="contents">{page}</div>
}

/* ======================= 命令面板、用量、显示选项 ======================= */

/** 命令面板（桌面 ⌘K；手机由斜杠 /commands 打开）：执行一行 = 先关面板，再做外壳动作 */
function PlayPalette({ ui, act, variant }: PlaySlotProps) {
  const [, set] = useCPlay(ui.screen)
  const close = () => act.setPaletteOpen(false)
  const run = (row: PiPaletteRun) => {
    close()
    if (row.kind === "session") {
      act.openSession(row.id)
      return
    }
    if (row.key === "new") act.newSession()
    else if (row.key === "sidebar") act.toggleSidebar()
    else if (row.key === "pane") act.togglePane()
    else if (row.key === "settings") act.openSettings()
    else if (row.key === "usage") set({ usage: true, usageReturn: null, last: "palette:usage" })
    else set({ last: `palette:${row.key}` })
  }
  return (
    <PiCommandPalette
      variant={variant}
      commands={PALETTE_COMMANDS}
      sessions={PALETTE_SESSIONS}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      onRun={run}
    />
  )
}

function PlayUsage({ ui, variant }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  if (!c.usage) return null
  return (
    <PiUsageDialog
      viewport={variant}
      usage={MOCK_USAGE}
      stats={C_STATS}
      subtitle="修复手机键盘收起时输入框跳动"
      returnFocus={c.usageReturn ? byCwId(c.usageReturn) : undefined}
      onOpenChange={(open) => {
        if (!open) set({ usage: false, usageReturn: null })
      }}
      onRefresh={() => set({ last: "usage:refresh" })}
    />
  )
}

/** 显示选项的内容（桌面放进账户区滑杆的锚定菜单；入口在 a 线的 PiAccountFooter，见 lane-requests/p4-c.md） */
export function PlayDisplayOptionsMenu({ ui, act, variant }: PlaySlotProps) {
  const [c, set] = useCPlay(ui.screen)
  return (
    <PiDisplayOptions
      variant={variant}
      bare={variant === "phone"}
      prefs={c.prefs}
      devices={MOCK_DEVICES}
      counts={mockSessionCounts()}
      now={MOCK_NOW}
      onPrefsChange={(patch) => set((cur) => ({ prefs: { ...cur.prefs, ...patch }, last: `prefs:${Object.keys(patch).join(",")}` }))}
      onOpenSettings={() => {
        if (variant === "phone") act.closeSheet()
        act.openSettings()
      }}
    />
  )
}

/** c 区的手机 sheet：+ 菜单、模型、投递、排队、显示选项、命令面板（全高）、用量（全高）。任务 sheet 归 b 线（PlayBSheets，B_SHEET_TASKS） */
export function PlayCSheets(p: PlaySlotProps) {
  const { ui, act } = p
  const [c, set] = useCPlay(ui.screen)
  const { pick, inputs } = useAttachPick(ui.screen, set)
  const close = act.closeSheet
  const onOpenChange = (open: boolean) => {
    if (!open) close()
  }
  return (
    <>
      {ui.sheet === C_SHEET_ATTACH && (
        <PiSheet title="添加" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-composer-plus")}>
          <PiAttachMenu
            variant="phone"
            bare
            onPick={(k) => {
              close()
              pick(k)
            }}
          />
        </PiSheet>
      )}
      {ui.sheet === C_SHEET_MODEL && (
        <PiSheet title="模型与思考" bodyClassName="px-4" onOpenChange={onOpenChange} returnFocus={byCwId("pi-composer-model")}>
          <SheetHost close={close}>
            <ModelMenuContent c={c} set={set} variant="phone" />
          </SheetHost>
        </PiSheet>
      )}
      {ui.sheet === C_SHEET_DELIVERY && (
        <PiSheet title="pi 忙的时候发消息" bodyClassName="px-2" onOpenChange={onOpenChange} returnFocus={byCwId("pi-delivery")}>
          <PiDeliveryOptions
            variant="phone"
            bare
            value={c.delivery}
            onValueChange={(delivery) => {
              set({ delivery })
              close()
            }}
          />
        </PiSheet>
      )}
      {ui.sheet === C_SHEET_QUEUE && (
        <PiSheet
          title="排队"
          subtitle={`${queueCount(c.queue)} 条在等`}
          size="half"
          bodyClassName="px-4"
          onOpenChange={onOpenChange}
          returnFocus={byCwId("pi-tray-queue")}
        >
          <PiQueuePanel
            variant="phone"
            bare
            remote={c.queue}
            host={C_HOST_QUEUE}
            now={C_NOW}
            onAction={(id, action) =>
              action === "cancel"
                ? set({ queue: { ...c.queue, items: c.queue.items.filter((i) => i.id !== id) }, last: `queue:cancel:${id}` })
                : set({ last: `queue:${action}:${id}` })
            }
          />
        </PiSheet>
      )}
      {ui.sheet === C_SHEET_DISPLAY_OPTIONS && (
        <PiSheet title="显示选项" bodyClassName="px-2" onOpenChange={onOpenChange}>
          <PlayDisplayOptionsMenu {...p} variant="phone" />
        </PiSheet>
      )}
      {ui.paletteOpen && <PlayPalette {...p} variant="phone" />}
      <PlayUsage {...p} variant="phone" />
      {inputs}
    </>
  )
}

/**
 * c 区的全屏浮层（桌面）：命令面板（⌘K 打开，PiOverlay：自己登记为 overlay 层，Esc 由 Radix 关、不会停止生成）、用量弹窗（PiDialog）。
 * 两个都 portal 到 body，overlay 槽保持空（empty:hidden，不挡点击）。
 */
export function PlayCOverlays(p: PlaySlotProps) {
  const [c, set] = useCPlay(p.ui.screen)
  if (p.variant === "phone") return null
  const device = MOCK_DEVICES.find((d) => d.id === c.device) ?? MOCK_DEVICES[0]!
  if (!c.browsing) {
    return (
      <>
        {p.ui.paletteOpen && <PlayPalette {...p} />}
        <PlayUsage {...p} />
      </>
    )
  }
  const folders = playFolderData(device)
  return (
    <>
      {p.ui.paletteOpen && <PlayPalette {...p} />}
      <PlayUsage {...p} />
      <PiFolderBrowser
        viewport="desktop"
        scopeLabel={folders.scopeLabel}
        initialPath={c.folder}
        listDirs={playListDirs}
        open={c.browsing}
        onOpenChange={(open) => {
          if (!open) set({ browsing: false })
        }}
        onPick={(folder) => set({ folder, browsing: false, last: `folder:${folder}` })}
      />
    </>
  )
}
