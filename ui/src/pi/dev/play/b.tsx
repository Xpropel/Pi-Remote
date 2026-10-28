/*
 * b 线的可交互件（#/play，R2/p4-lanes.md §4）：对话流、右 pane、b 区的 sheet 与全屏浮层（灯箱）。归 b 线。PlayApp.tsx 只认
 * PlayTranscript / PlayPane / PlayBSheets / PlayBOverlays 四个槽位；另外导出两个给 c 线的 PlayDock 用（R2/lane-requests/p4-b.md）：
 *   - PlayStickTray：tray 右端"回到底部"钮要的 scrollDown / newCount / onScrollDown（吸底状态由对话流报上来）；
 *   - PlayApproval：approval-waiting 起始状态的审批卡（时钟真走，测读屏播报）。
 * 对话流和 dock、灯箱分在不同的槽位里，所以吸底状态和"灯箱开着哪张图"放在本文件的模块级小 store 里（一页只有一个 PlayApp）。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import { PiApprovalCard } from "@/components/pi/conversation/PiApprovalCard"
import { PiChangesPane } from "@/components/pi/conversation/PiChangesPane"
import { PiFilePane } from "@/components/pi/conversation/PiFilePane"
import { PiLightbox, type PiLightboxImage } from "@/components/pi/conversation/PiLightbox"
import { PiPaneTabs, type PiPaneKind } from "@/components/pi/conversation/PiPaneTabs"
import { PiTaskRows, taskProgress } from "@/components/pi/conversation/PiTaskPanel"
import { PiTerminalPane } from "@/components/pi/conversation/PiTerminalPane"
import { PiTranscript, type PiOpenImage, type PiStickChange, type PiTranscriptHandle } from "@/components/pi/conversation/PiTranscript"
import { PiSheet } from "@/components/pi/shared"
import { piBaseName } from "@/components/pi/shared/format"
import type { PiItem } from "@/components/pi/shared/types"
import {
  APPROVAL_DIALOG,
  CHANGED_FILES,
  CHANGES_TOTAL,
  CONVO_APPROVAL,
  CONVO_DONE,
  CONVO_STREAMING,
  FILE_RESULT,
  LIVE_EXPANDED,
  LIVE_RUNNING,
  LIVE_SUBAGENTS,
  NOW,
  TASKS,
  TERMINALS,
} from "@/pi/dev/fixtures/gallery/b"
import { stressItems } from "../screens/_stress/stressData"
import { B_LIGHTBOX, B_SHEET_TASKS } from "./presets-b"
import type { PlaySlotProps } from "./state"

/* ======================= 模块级小 store（槽位之间共享） ======================= */

function createStore<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      if (Object.is(next, value)) return
      value = next
      for (const f of subs) f()
    },
    subscribe: (f: () => void) => {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
  }
}

const STICK_AT_BOTTOM: PiStickChange = { atBottom: true, newCount: 0 }
const stickStore = createStore<PiStickChange>(STICK_AT_BOTTOM)
const setStick = (s: PiStickChange) => {
  const cur = stickStore.get()
  if (cur.atBottom !== s.atBottom || cur.newCount !== s.newCount) stickStore.set(s)
}
/** 对话流的 ref（scrollToBottom） */
const transcriptRef: { current: PiTranscriptHandle | null } = { current: null }

type LightboxState = { images: readonly PiLightboxImage[]; index: number; opener: HTMLElement | null } | null
const lightboxStore = createStore<LightboxState>(null)

/* ======================= 对话流 ======================= */

/** lightbox 起始状态：用户卡里三张图（竖 / 横 / 竖，和开发屏 b/_lightbox 同一组） */
const LIGHTBOX_IMAGES: PiLightboxImage[] = [
  { data: "", mimeType: "image/png", bytes: 182_400, aspect: 390 / 844, width: 1170, height: 2532 },
  { data: "", mimeType: "image/png", bytes: 412_800, aspect: 16 / 10, width: 2880, height: 1800 },
  { data: "", mimeType: "image/png", bytes: 176_100, aspect: 390 / 844, width: 1170, height: 2532 },
]
const CONVO_LIGHTBOX: PiItem[] = CONVO_DONE.map((it, i) => (i === 0 && it.kind === "user" ? { ...it, images: LIGHTBOX_IMAGES } : it))

/** stream-grow：每 0.6 秒追加一条，最多 40 条 */
const GROW_EVERY_MS = 600
const GROW_MAX = 40
function grownItem(n: number): PiItem {
  return {
    kind: "assistant",
    key: `grow-${n}`,
    startedAt: NOW + n * 600,
    timestamp: NOW + n * 600,
    blocks: [{ kind: "text", text: `第 ${n} 段`, prose: [{ p: [`（模拟流式输出）第 ${n} 段：横屏键盘弹出后 composer 贴住键盘上沿，`, { code: "vv.height" }, " 与 offsetTop 都按最新值算。"] }] }],
  }
}

let stressCache: PiItem[] | null = null
const stress = () => (stressCache ??= stressItems())

function usePlayItems(ui: PlaySlotProps["ui"]): PiItem[] {
  const [grown, setGrown] = useState(0)
  const growing = ui.screen === "stream-grow" && ui.running
  useEffect(() => {
    if (!growing) return
    const t = window.setInterval(() => setGrown((n) => Math.min(n + 1, GROW_MAX)), GROW_EVERY_MS)
    return () => window.clearInterval(t)
  }, [growing])
  return useMemo(() => {
    switch (ui.screen) {
      case "long-transcript":
        return stress()
      case "lightbox":
        return CONVO_LIGHTBOX
      case "approval-waiting":
        return CONVO_APPROVAL
      case "stream-grow":
        return [...CONVO_STREAMING, ...Array.from({ length: grown }, (_, i) => grownItem(i + 1))]
      default:
        // 起步版：回合在跑 = conversation-streaming 的流；停止后换成已完成的那一版（不模拟中断后的流）
        return ui.running ? CONVO_STREAMING : CONVO_DONE
    }
  }, [ui.screen, ui.running, grown])
}

/**
 * 主区对话流（可交互态）：吸底、上滑松开（状态报给 stickStore，c 线的 tray 据此出"回到底部"钮）、300 条渲染窗、
 * 切会话（ui.roomId）淡入、点图开灯箱（桌面 = 弹窗槽 b:lightbox，手机 = sheet 槽 b:lightbox）。
 */
export function PlayTranscript({ ui, act, variant }: PlaySlotProps) {
  const items = usePlayItems(ui)
  const approval = ui.screen === "approval-waiting"
  const running = ui.running ? (approval ? { since: CONVO_APPROVAL[0].timestamp ?? NOW, line: false } : LIVE_RUNNING) : null
  const openImage = useCallback<PiOpenImage>(
    (images, index, el) => {
      lightboxStore.set({ images, index, opener: el })
      if (variant === "phone") act.openSheet(B_LIGHTBOX)
      else act.openDialog(B_LIGHTBOX)
    },
    [act, variant],
  )
  // 卸掉时（换页、关会话）复位，免得 tray 留着上一页的"回到底部"
  useEffect(() => () => setStick(STICK_AT_BOTTOM), [])
  return (
    <PiTranscript
      ref={transcriptRef}
      items={items}
      variant={variant}
      now={NOW}
      sessionKey={ui.roomId}
      running={running}
      subagents={ui.running && !approval ? LIVE_SUBAGENTS : undefined}
      expanded={ui.running && !approval ? LIVE_EXPANDED : undefined}
      onStickChange={setStick}
      onOpenImage={openImage}
    />
  )
}

/** 给 c 线 PlayDock 的 tray 用：`<PiComposerDock {...usePlayStickTray()} …>`（scrollDown / newCount / onScrollDown） */
export function PlayStickTray({ children }: { children: (tray: { scrollDown: boolean; newCount: number; onScrollDown: () => void }) => ReactNode }) {
  const s = useSyncExternalStore(stickStore.subscribe, stickStore.get, stickStore.get)
  return <>{children({ scrollDown: !s.atBottom, newCount: s.newCount, onScrollDown: () => transcriptRef.current?.scrollToBottom() })}</>
}

/* ======================= 右 pane ======================= */

/**
 * 桌面右 pane（⌘. 开关）：页签切换改动 / 终端 / 文件，× 关掉（§1.8：一次只开一个视图）。
 * 文件页签：还没打开过文件时写"文件"（同画廊的 changes-pane / terminal-pane），进过文件视图后写文件名（同 file-pane）。
 */
export function PlayPane({ ui, act }: PlaySlotProps) {
  const [fileOpened, setFileOpened] = useState(false)
  if (ui.pane === "file" && !fileOpened) setFileOpened(true)
  if (ui.pane == null) return null
  const view: PiPaneKind = ui.pane
  return (
    <>
      <PiPaneTabs
        active={view}
        changes={CHANGES_TOTAL}
        terminalRunning={ui.running}
        file={fileOpened || view === "file" ? { name: piBaseName(FILE_RESULT.path), kind: "ts" } : undefined}
        onSelect={(kind) => act.setPane(kind)}
        onClose={() => act.setPane(null)}
      />
      {view === "changes" ? (
        <PiChangesPane files={CHANGED_FILES} total={CHANGES_TOTAL} variant="desktop" />
      ) : view === "terminal" ? (
        <PiTerminalPane items={TERMINALS} now={NOW} variant="desktop" />
      ) : (
        <PiFilePane file={FILE_RESULT} variant="desktop" />
      )}
    </>
  )
}

/* ======================= 灯箱、sheet、审批卡 ======================= */

function PlayLightbox({ variant, close }: { variant: "desktop" | "phone"; close: () => void }) {
  const lb = useSyncExternalStore(lightboxStore.subscribe, lightboxStore.get, lightboxStore.get)
  if (!lb) return null
  return (
    <PiLightbox
      images={lb.images}
      index={lb.index}
      variant={variant}
      onIndexChange={(index) => lightboxStore.set({ ...lb, index })}
      // 关闭后焦点回被点开的那张图（design §4.7 焦点表）
      returnFocus={lb.opener}
      onOpenChange={(open) => {
        if (!open) {
          lightboxStore.set(null)
          close()
        }
      }}
    />
  )
}

/** b 区的手机 sheet：任务面板（半高，design F02 / task-panel）、灯箱（盖住整页） */
export function PlayBSheets({ ui, act }: PlaySlotProps) {
  if (ui.sheet === B_LIGHTBOX) return <PlayLightbox variant="phone" close={act.closeSheet} />
  if (ui.sheet !== B_SHEET_TASKS) return null
  const { done, total } = taskProgress(TASKS)
  return (
    <PiSheet
      title="任务"
      subtitle={`${done}/${total} 完成`}
      size="half"
      onOpenChange={(open) => {
        if (!open) act.closeSheet()
      }}
    >
      <PiTaskRows tasks={TASKS} variant="phone" />
    </PiSheet>
  )
}

/** b 区的桌面全屏浮层：灯箱（PiDesktopShell 的 overlay 槽） */
export function PlayBOverlays({ ui, act }: PlaySlotProps) {
  if (ui.dialog !== B_LIGHTBOX) return null
  return <PlayLightbox variant="desktop" close={act.closeDialog} />
}

/** approval-waiting 的审批卡：剩余时间按真实时钟走（开场剩 1:22，和画廊屏一样）。c 线 PlayDock 在这个起始状态传给 dock 的 approval */
export function PlayApproval({ ui, variant }: PlaySlotProps) {
  const [start] = useState(() => Date.now())
  const [tick, setTick] = useState(start)
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  if (ui.screen !== "approval-waiting") return null
  const dialog = { ...APPROVAL_DIALOG, startedAt: APPROVAL_DIALOG.startedAt + (start - NOW) }
  return <PiApprovalCard dialog={dialog} now={tick} variant={variant} maxHeight={variant === "phone" ? 264 : undefined} />
}
