/**
 * 设置页 v2 · 宿主消费接线（P13）。
 *
 * 设置页只写本机偏好；本组件把偏好接到宿主行为上，不改设置页实现：
 *   - 默认设备：连接成功后自动选中（当前无选中 / 当前选中离线；手动选择后本会话不覆盖）；
 *   - 通知：标题前缀 / favicon 角标 / 提示音 / 应用内提醒按 prefs.notifications 与 privacyMode 生效；
 *   - 快捷键：window keydown → prefs.shortcuts → 现有 act / composer / relay 动作；
 *   - 隐私：把 prefs.privacyMode 交给根节点（data-pi-privacy + html 镜像）。
 *
 * 产品入口 PiApp 与开发画廊 #/live 共用本组件；静态画廊可关掉 notifications / shortcuts，
 * 避免截图被副作用影响。设置页打开时快捷键一律不抢（页面自己负责录制/校验）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { PiPrivacyProvider, PiSendKeyProvider } from "@/pi/headless"
import { modelRowsOf, thinkingSegmentsOf } from "@/pi/model/models"
import { openSessionRow, sidebarSessionsOf } from "@/pi/model/sidebarSource"
import {
  browserShortcutHintOf,
  defaultDevicePickOf,
  notificationAwayOk,
  notificationGateOf,
  shortcutBlockedByFocus,
  shortcutBlockedByOverlay,
  shortcutHasStrongModifier,
  shortcutHitOf,
  titleCompletionEnabled,
  titleWaitingCountOf,
} from "@/pi/model/settingsHost"
import { piPlatformOf } from "@/pi/model/shortcuts"
import { focusKindOf } from "@/pi/hooks/usePiShortcuts"
import { useCompletionNotice, useWaitingNotice } from "@/pi/hooks/useCompletionNotice"
import { usePiSettingsPrefs } from "@/pi/hooks/usePiSettingsPrefs"
import { sidebarSessionKeyOf } from "@/pi/sidebar/model.ts"
import { PI_SIDEBAR_COPY } from "@/pi/sidebar/types.ts"
import { useSidebarLocalState, type SidebarLocalState } from "@/pi/sidebar/useSidebarLocal"
import { usePageTitle } from "@/chat/hooks"
import { pageAway, useCompletionBadge } from "@/chat/composer/faviconBadge"
import { useCompletionSound } from "@/chat/composer/sound"
import type { PiUi, PiUiActions } from "@/pi/hooks/usePiUiState"
import type { Relay } from "@/relay/useRelay"
import { attentionItemsOf, attentionWaitingCountOf } from "@/relay/attention"
import type { SettingsPrefs } from "@/pi/settings/types.ts"

/* ------------------------------------------------------------------ */
/* 默认设备                                                             */
/* ------------------------------------------------------------------ */

function useDefaultDeviceSelection(relay: Relay, prefs: SettingsPrefs, enabled: boolean): void {
  /** 用户本会话手动选过设备后，默认设备不再覆盖。 */
  const manual = useRef(false)
  /** 已自动应用过的默认设备 id（同一个 id 只应用一次）。 */
  const applied = useRef<string | null>(null)
  /** 上次看到的选中设备；只在“用户已经交互过”时把变化认定为手动选择。 */
  const lastSelected = useRef(relay.selectedDeviceId)
  const interacted = useRef(false)

  useEffect(() => {
    const mark = () => {
      interacted.current = true
    }
    window.addEventListener("pointerdown", mark, { capture: true, passive: true })
    window.addEventListener("keydown", mark, { capture: true })
    window.addEventListener("touchstart", mark, { capture: true, passive: true })
    return () => {
      window.removeEventListener("pointerdown", mark, { capture: true })
      window.removeEventListener("keydown", mark, { capture: true })
      window.removeEventListener("touchstart", mark, { capture: true })
    }
  }, [])

  useEffect(() => {
    const current = relay.selectedDeviceId
    if (current === lastSelected.current) return
    // 排除宿主自己刚应用的默认设备；其余在用户交互后发生的变化都视为手动选择。
    if (current && current !== applied.current && interacted.current) manual.current = true
    lastSelected.current = current
  }, [relay.selectedDeviceId])

  const selectDevice = relay.selectDevice
  const devices = relay.devices
  const selectedDeviceId = relay.selectedDeviceId
  const defaultDeviceId = prefs.defaultDeviceId
  const authed = relay.authed
  useEffect(() => {
    if (!enabled || !authed) return
    const pick = defaultDevicePickOf({
      devices,
      selectedDeviceId,
      defaultDeviceId,
      manual: manual.current,
      appliedDefaultId: applied.current,
    })
    if (!pick) return
    applied.current = pick
    selectDevice(pick)
  }, [enabled, authed, devices, selectedDeviceId, defaultDeviceId, selectDevice])
}

/* ------------------------------------------------------------------ */
/* 快捷键动作                                                           */
/* ------------------------------------------------------------------ */

interface ShortcutContext {
  relay: Relay
  ui: PiUi
  act: PiUiActions
  sidebar: SidebarLocalState
  keyboardOpen: boolean
}

/** 焦点在按钮 / 链接 / 菜单行上时，裸键（Enter / Space / Esc）归它们自己，不抢。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  if (!element || typeof element.closest !== "function") return false
  return !!element.closest('button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], summary')
}

function errorTextOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ""
  return message || fallback
}

/** 点现有 composer 的发送钮：斜杠命令 / 草稿校验 / 发送锁都走既有实现。 */
function clickComposerSend(): boolean {
  if (typeof document === "undefined") return false
  const button = document.querySelector<HTMLButtonElement>(
    '[data-cw-id="pi-composer-send"], [data-cw-id="pi-composer-send-muted"]',
  )
  if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false
  button.click()
  return true
}

function sendWithDeliveryMode(ctx: ShortcutContext, mode: "steer" | "follow_up"): boolean {
  const { relay } = ctx
  const previous = relay.sendMode
  relay.setSendMode(mode)
  const clicked = clickComposerSend()
  if (!clicked) {
    if (!relay.draft.trim()) {
      relay.setSendMode(previous)
      return false
    }
    void relay.sendText()
  }
  // sendText 在同一 tick 里同步读 sendModeRef；下一 tick 恢复输入条原来的投递方式。
  window.setTimeout(() => relay.setSendMode(previous), 0)
  return true
}

function insertNewlineIntoComposer(ctx: ShortcutContext): boolean {
  const { relay } = ctx
  const input =
    document.querySelector<HTMLTextAreaElement>('textarea[data-cw-id="pi-composer-input"]') ??
    document.querySelector<HTMLTextAreaElement>('[data-slot="pi-empty-composer"] textarea, [data-slot="pi-follow-up-composer"] textarea')
  if (!input) {
    if (!relay.draft.trim()) return false
    relay.setDraft(`${relay.draft}\n`)
    return true
  }
  input.focus({ preventScroll: true })
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const nextValue = `${input.value.slice(0, start)}\n${input.value.slice(end)}`
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  if (setter) setter.call(input, nextValue)
  else input.value = nextValue
  input.selectionStart = start + 1
  input.selectionEnd = start + 1
  input.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}

/** 展开 / 折叠所有已完成思考块：有任意一个收起就全开，否则全收。 */
function toggleThinkingBlocks(): boolean {
  const roots = [...document.querySelectorAll<HTMLElement>('[data-pi-part="thinking"]')]
  const triggers = roots
    .map((root) => root.querySelector<HTMLElement>('button[data-cw-id$="-toggle"]'))
    .filter((item): item is HTMLElement => item != null)
  if (!triggers.length) return false
  const anyClosed = roots.some((root) => root.getAttribute("data-state") === "closed")
  for (const trigger of triggers) {
    const root = trigger.closest('[data-pi-part="thinking"]')
    if (anyClosed && root?.getAttribute("data-state") !== "closed") continue
    trigger.click()
  }
  return true
}

function openAdjacentSession(ctx: ShortcutContext, delta: -1 | 1): boolean {
  const { relay, act } = ctx
  const rows = sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice)
  if (!rows.length) return false
  const current = rows.findIndex((row) => row.id === relay.roomId && (row.deviceId ?? null) === relay.selectedDeviceId)
  const index = current < 0 ? (delta > 0 ? -1 : 0) : current
  const next = rows[(index + delta + rows.length) % rows.length]
  if (!next) return false
  openSessionRow(relay, next, () => act.openSession())
  return true
}

function toggleSidebarFlag(ctx: ShortcutContext, kind: "pin" | "archive"): boolean {
  const { relay, sidebar } = ctx
  if (!relay.roomId) return false
  const key = sidebarSessionKeyOf(relay.selectedDeviceId ?? "", relay.roomId)
  if (kind === "pin") {
    sidebar.togglePin(key)
    relay.notify(PI_SIDEBAR_COPY.pinHint, "warn")
  } else {
    sidebar.toggleArchive(key)
    relay.notify(PI_SIDEBAR_COPY.archiveHint, "warn")
  }
  return true
}

function cycleModel(ctx: ShortcutContext): boolean {
  const { relay } = ctx
  void relay
    .runCommand("get_available_models")
    .then(async (data) => {
      const rows = modelRowsOf(data, { model: relay.model, modelMeta: relay.modelMeta }).filter((row) => !row.unconfigured)
      if (!rows.length) {
        relay.notify("当前无法读取模型列表，未切换", "warn")
        return
      }
      if (rows.length === 1) {
        relay.notify("当前只有一个可用模型", "warn")
        return
      }
      const current = rows.findIndex((row) => row.current)
      const next = rows[(current + 1 + rows.length) % rows.length]
      await relay.runCommand("set_model", { provider: next.provider, modelId: next.modelId })
      relay.notify(`已切换到 ${next.name}`)
    })
    .catch((error: unknown) => relay.notify(`切换模型失败：${errorTextOf(error, "命令失败")}`, "warn"))
  return true
}

function cycleThinkingLevel(ctx: ShortcutContext): boolean {
  const { relay } = ctx
  void relay
    .runCommand("get_available_thinking_levels")
    .then(async (data) => {
      const levels = thinkingSegmentsOf(data).map((segment) => segment.value)
      if (!levels.length) {
        relay.notify("当前模型没有可选的思考级别", "warn")
        return
      }
      const current = levels.indexOf(relay.thinkingLevel)
      const next = levels[(current + 1) % levels.length]
      await relay.runCommand("set_thinking_level", { level: next })
      relay.notify(`思考级别：${next}`)
    })
    .catch((error: unknown) => relay.notify(`切换思考级别失败：${errorTextOf(error, "命令失败")}`, "warn"))
  return true
}

/** 返回 true = 这个动作确实处理了（调用方 preventDefault）；false = 交给浏览器。 */
function runShortcutAction(id: keyof SettingsPrefs["shortcuts"], ctx: ShortcutContext): boolean {
  const { relay, act } = ctx
  switch (id) {
    case "newSession":
      act.newSession()
      return true
    case "globalSearch":
      act.setPaletteOpen(true)
      return true
    case "toggleSidebar":
      act.toggleSidebar()
      return true
    case "openSettings":
      act.openSettings()
      return true
    case "previousSession":
      return openAdjacentSession(ctx, -1)
    case "nextSession":
      return openAdjacentSession(ctx, 1)
    case "archiveSession":
      return toggleSidebarFlag(ctx, "archive")
    case "pinSession":
      return toggleSidebarFlag(ctx, "pin")
    case "stopGeneration":
      if (!relay.busy || !relay.online) return false
      void relay.abort()
      return true
    case "sendMessage":
      return clickComposerSend() || (relay.draft.trim() ? (void relay.sendText(), true) : false)
    case "insertNewline":
      return insertNewlineIntoComposer(ctx)
    case "switchModel":
      return cycleModel(ctx)
    case "cycleThinkingLevel":
      return cycleThinkingLevel(ctx)
    case "toggleThinkingBlock":
      return toggleThinkingBlocks()
    case "queueSend":
      return sendWithDeliveryMode(ctx, "follow_up")
    case "steerSend":
      return sendWithDeliveryMode(ctx, "steer")
    default:
      return false
  }
}

function useShortcutDispatch(options: {
  relay: Relay
  ui: PiUi
  act: PiUiActions
  prefs: SettingsPrefs
  enabled: boolean
  keyboardOpen: boolean
}): void {
  const { relay, ui, act, prefs, enabled, keyboardOpen } = options
  const sidebar = useSidebarLocalState(relay.serverName || "local", relay.selectedDeviceId ?? "")
  const latest = useRef({ relay, ui, act, prefs, sidebar, keyboardOpen })
  useLayoutEffect(() => {
    latest.current = { relay, ui, act, prefs, sidebar, keyboardOpen }
  })
  const platform = useMemo(() => piPlatformOf(typeof navigator === "undefined" ? null : navigator), [])
  /** 浏览器保留键提示：每个组合一次会话只提示一次。 */
  const hinted = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const current = latest.current
      const hit = shortcutHitOf(
        current.prefs.shortcuts,
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          repeat: event.repeat,
        },
        platform,
      )
      if (!hit) return
      // 设置页 / 菜单 / 弹窗 / 命令面板打开时，键盘归它们；移动端软键盘开着时裸键也归输入框。
      if (
        shortcutBlockedByOverlay({
          menu: !!current.ui.menu,
          sheet: !!current.ui.sheet,
          dialog: !!current.ui.dialog,
          palette: current.ui.paletteOpen,
          settings: current.ui.view === "settings",
        })
      ) {
        return
      }
      if (shortcutBlockedByFocus(hit.keys, focusKindOf(event.target))) return
      if (current.keyboardOpen && !shortcutHasStrongModifier(hit.keys)) return
      if (isInteractiveTarget(event.target) && !shortcutHasStrongModifier(hit.keys)) return
      const handled = runShortcutAction(hit.id, current)
      if (!handled) return
      event.preventDefault()
      if (hit.browserConflict && !hinted.current.has(hit.signature)) {
        hinted.current.add(hit.signature)
        current.relay.notify(browserShortcutHintOf(hit), "warn")
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, platform])
}

/* ------------------------------------------------------------------ */
/* 通知                                                                 */
/* ------------------------------------------------------------------ */

/** 页面在不在场（与角标 / 提示音 / 应用内提醒同一口径）。 */
function usePageAway(): boolean {
  const [away, setAway] = useState(pageAway)
  useEffect(() => {
    const update = () => setAway(pageAway())
    document.addEventListener("visibilitychange", update)
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
    }
  }, [])
  return away
}

function useAttentionState(relay: Relay): { waiting: number; waitingKeys: readonly string[] } {
  return useMemo(() => {
    const items = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      inbox: relay.inbox,
      selectedDevice: relay.selectedDevice,
    })
    return {
      waiting: attentionWaitingCountOf(items),
      waitingKeys: items.filter((item) => item.kind === "waiting").map((item) => item.key),
    }
  }, [relay.roomId, relay.rooms, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.inbox, relay.selectedDevice])
}

/* ------------------------------------------------------------------ */
/* 宿主组件                                                             */
/* ------------------------------------------------------------------ */

export interface PiSettingsHostProps {
  relay: Relay
  ui: PiUi
  act: PiUiActions
  keyboardOpen?: boolean
  /** 消费通知偏好（标题 / 角标 / 提示音 / 应用内提醒）。默认 true。 */
  notifications?: boolean
  /** 消费快捷键偏好（window keydown）。默认 true。 */
  shortcuts?: boolean
  /** 消费默认设备偏好（连接成功后自动选中）。默认 true。 */
  defaultDevice?: boolean
  children: ReactNode
}

export function PiSettingsHost({
  relay,
  ui,
  act,
  keyboardOpen = false,
  notifications = true,
  shortcuts = true,
  defaultDevice = true,
  children,
}: PiSettingsHostProps) {
  const prefs = usePiSettingsPrefs()
  const gate = useMemo(() => notificationGateOf(prefs), [prefs])
  const attention = useAttentionState(relay)
  const waiting = attention.waiting
  const away = usePageAway()

  useDefaultDeviceSelection(relay, prefs, defaultDevice)
  useShortcutDispatch({ relay, ui, act, prefs, enabled: shortcuts, keyboardOpen })

  // 通知四个消费者：偏好关闭时对应提醒不发；privacyMode 让标题不带会话正文。
  // 「仅页面外」对等待角标同样生效；「总是提醒」时等待角标常驻。
  const waitingVisible = notifications ? titleWaitingCountOf(gate, notificationAwayOk(gate, away) ? waiting : 0) : 0
  usePageTitle(relay, waitingVisible, {
    completion: notifications && titleCompletionEnabled(gate),
    privacy: gate.privacy,
    always: !gate.onlyWhenAway,
  })
  useCompletionBadge(relay, waitingVisible, {
    enabled: notifications && gate.badge,
    waitingEnabled: gate.waiting,
    doneEnabled: gate.complete,
    errorEnabled: gate.error,
    onlyWhenAway: gate.onlyWhenAway,
  })
  useCompletionSound(relay, {
    enabled: notifications && gate.sound,
    doneEnabled: gate.complete,
    errorEnabled: gate.error,
    onlyWhenAway: gate.onlyWhenAway,
  })
  useCompletionNotice(relay, { gate, enabled: notifications })
  // 等待确认：新出现的 waiting 条目 → 应用内提醒 + 提示音（仍受开关 / 仅页面外 / 总是提醒约束）。
  useWaitingNotice(relay, { gate, enabled: notifications, waitingKeys: attention.waitingKeys })

  return (
    <PiPrivacyProvider value={gate.privacy}>
      <PiSendKeyProvider value={prefs.sendKey}>{children}</PiSendKeyProvider>
    </PiPrivacyProvider>
  )
}
