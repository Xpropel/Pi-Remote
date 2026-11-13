import { useEffect, useMemo, useState } from "react"
import { noteSlashCommandUsed } from "@/chat/slashUsage"
import { saveLegacyStyle, useLegacyPrefs, useLegacyStyle } from "@/pi/hooks/useLegacyStyle"
import { modelDefaultOf, modelPillName, modelRowsOf, thinkingSegmentsOf, type PiModelRow } from "@/pi/model/models"
import { settingsPrefsOf, settingsWritesOf, type PiSettingsPrefs } from "@/pi/model/settingsView"
import { roomDeviceId } from "@/relay/devices"
import { roomTitle } from "@/relay/useRelay"
import type { PiUiActions } from "@/pi/hooks/usePiUiState"
import type { PiContainerProps, PiVariant, Relay } from "./types"

/*
 * c 线容器共用的 id、取数 hook 和小函数（P5.5；不含 JSX，免得 .tsx 文件同时导出组件和非组件）。
 * 只给 c 线的 Composer / NewSession / CommandPalette / Dialogs / Settings / DisplayOptions 容器用。
 */

/** c 线自己的浮层 id（ui.menu = 桌面锚定菜单 / tray 面板；ui.sheet = 手机 sheet）。arg：模型菜单 = 悬停 / 选中行（静态截图用）；排队 = 要直接编辑的那一条 */
export const C_IDS = {
  plus: "c:plus",
  model: "c:model",
  delivery: "c:delivery",
  queue: "c:queue",
  newDevice: "c:new-device",
  newFolder: "c:new-folder",
  newPlus: "c:new-plus",
  /** 手机新会话页的文件夹浏览器（全高 sheet）：放在 ui.sheet 里，手机导航把它当一层，系统返回只关它 */
  newBrowse: "c:new-browse",
} as const

/**
 * 打开排队面板并直接编辑这一条（给对话流里排队气泡的「编辑」用；queueId = remoteQueue 条目的 id）。
 * 桌面开 tray 上方的面板，手机开排队 sheet；ComposerContainer / ComposerSheets 读到 arg 后进入那一条的编辑、聚焦编辑框，再把 arg 去掉。
 * 那一条已经在发 / 不在队里时照常提示「这条已经在发了，改不了」，面板仍打开。
 */
export function openQueueEdit(act: Pick<PiUiActions, "openMenu" | "openSheet">, variant: PiVariant, queueId: string): void {
  if (variant === "phone") act.openSheet({ id: C_IDS.queue, arg: queueId })
  else act.openMenu({ id: C_IDS.queue, arg: queueId })
}

/** 当前会话已载入（不是只点选的 lazySession） */
export function sessionLoaded(relay: Pick<Relay, "lazySession" | "roomId">): boolean {
  return !(relay.lazySession && relay.lazySession.id === relay.roomId)
}

/** 房间连着、已载入：设备命令（get_git_branch、get_commands…）能跑 */
export function commandsReady(relay: Relay): boolean {
  return relay.authed && relay.online && !!relay.roomId && sessionLoaded(relay)
}

/** relay 的错误 → 一句话（RelayError 的 message 已是中文） */
export function commandErrorText(error: unknown, fallback = "命令失败"): string {
  const message = error instanceof Error ? error.message.trim() : ""
  return message || fallback
}

export type PiCommandPhase = "idle" | "loading" | "error" | "ready"
export interface PiCommandData {
  phase: PiCommandPhase
  data: unknown
  error: string
  reload: () => void
}

/**
 * 跑一条只读命令拿回包（照 chat/dialogs.tsx 的 useCommandData）：command 为 null 时不跑；key 变了（换房间 / 换参数）重跑。
 * 卸载后晚到的回包丢掉；参数刚变、新回包还没到时按加载中给（不拿上一份的回包冒充）。
 */
export function useRelayCommand(run: Relay["runCommand"], command: string | null, args?: Record<string, unknown>, key = ""): PiCommandData {
  const [state, setState] = useState<{ phase: PiCommandPhase; data: unknown; error: string; sig: string }>(() => ({
    phase: command ? "loading" : "idle",
    data: undefined,
    error: "",
    sig: "",
  }))
  const [nonce, setNonce] = useState(0)
  const argsKey = JSON.stringify(args ?? null)
  const sig = `${command ?? ""}|${argsKey}|${key}|${nonce}`
  useEffect(() => {
    if (!command) return
    let alive = true
    const parsedArgs = JSON.parse(argsKey) as Record<string, unknown> | null
    Promise.resolve()
      .then(() => run(command, parsedArgs ?? undefined))
      .then(
        (data) => {
          if (alive) setState({ phase: "ready", data, error: "", sig })
        },
        (error: unknown) => {
          if (alive) setState({ phase: "error", data: undefined, error: commandErrorText(error, "读取失败"), sig })
        },
      )
    return () => {
      alive = false
    }
  }, [run, command, argsKey, sig])
  const reload = () => setNonce((n) => n + 1)
  if (!command) return { phase: "idle", data: undefined, error: "", reload }
  const fresh = state.sig === sig
  return { phase: fresh ? state.phase : "loading", data: fresh ? state.data : undefined, error: fresh ? state.error : "", reload }
}

/**
 * 写剪贴板：新界面只有一份，即 b 的 piCopyText（components/pi/conversation/clipboard.ts，口径同旧界面 chat/slash.tsx 的 copyText；
 * 不 import slash.tsx：它会带进旧界面的样式表）。lane-requests/p5-c.md 第 3 条：c 线这里只转出。
 */
export { piCopyText as copyToClipboard } from "@/components/pi/conversation/clipboard"

/** 当前会话的名字（弹窗标题下的灰字） */
export function currentSessionTitle(relay: Pick<Relay, "rooms" | "roomId">): string | null {
  const room = relay.rooms.find((r) => r.id === relay.roomId) ?? null
  return room ? roomTitle(room) : null
}

/** 当前房间所在的设备 id；没有房间时 null */
function currentRoomDeviceId(relay: Pick<Relay, "rooms" | "roomId">): string | null {
  const room = relay.rooms.find((r) => r.id === relay.roomId)
  return room ? roomDeviceId(room) : null
}

/** 各设备默认模型的名字（get_available_models 回包的 defaultModel）：null = 回包没带。新会话页靠它，进出页面不必每次都等回包 */
const deviceDefaultModelNames = new Map<string, string | null>()

function useRememberDeviceDefault(deviceId: string | null, data: unknown, ready: boolean) {
  const name = ready ? (modelDefaultOf(data)?.name ?? null) : undefined
  useEffect(() => {
    if (deviceId && name !== undefined) deviceDefaultModelNames.set(deviceId, name)
  }, [deviceId, name])
  return name
}

/** 模型表与思考级别（菜单 / sheet 开着时才取） */
export function useModelData(relay: Relay, open: boolean) {
  const ready = open && commandsReady(relay)
  const models = useRelayCommand(relay.runCommand, ready ? "get_available_models" : null, undefined, relay.roomId)
  const levels = useRelayCommand(relay.runCommand, ready ? "get_available_thinking_levels" : null, undefined, `${relay.roomId}|${relay.model}`)
  const model = relay.model
  const modelMeta = relay.modelMeta
  useRememberDeviceDefault(currentRoomDeviceId(relay), models.data, models.phase === "ready")
  const rows: PiModelRow[] = useMemo(() => (models.phase === "ready" ? modelRowsOf(models.data, { model, modelMeta }) : []), [models.phase, models.data, model, modelMeta])
  const segments = useMemo(() => (levels.phase === "ready" ? thinkingSegmentsOf(levels.data) : []), [levels.phase, levels.data])
  /** 菜单的读取行：每次打开都重新问，回包到之前是 loading（不冒充「还没有配置任何模型」） */
  const listPhase = models.phase === "loading" || models.phase === "error" ? models.phase : undefined
  return { rows, segments, raw: models.data, listPhase, listError: models.error, reload: models.reload }
}

/**
 * 新会话将用的模型 = 那台设备的默认模型（harness_start 不能指定模型，新会话页只读显示，绝不发 set_model / set_thinking_level）。
 * 名字只能从 get_available_models 的回包里读，而命令要经某个房间跑：只在当前房间就在这台设备上时问一次（只读）。
 * 问不到（没有这台设备的房间、回包没带默认模型）返回 null，由页面写「设备默认模型」。
 */
export function useDeviceDefaultModelName(relay: Relay, deviceId: string | null): string | null {
  const ready = !!deviceId && currentRoomDeviceId(relay) === deviceId && commandsReady(relay)
  const models = useRelayCommand(relay.runCommand, ready ? "get_available_models" : null, undefined, `${relay.roomId}|${deviceId ?? ""}`)
  const fresh = useRememberDeviceDefault(ready ? deviceId : null, models.data, models.phase === "ready")
  const name = fresh !== undefined ? fresh : deviceId ? (deviceDefaultModelNames.get(deviceId) ?? null) : null
  return name ? modelPillName({ model: name }) : null
}

/** composer 里的模型选择器文字：模型名（去掉"Claude "）· 思考级别原值（design：Sonnet 4.5 · medium） */
export function modelPillOf(relay: Pick<Relay, "model" | "modelMeta" | "thinkingLevel">): { name: string; thinking: string } {
  return { name: modelPillName(relay) ?? "选择模型", thinking: relay.thinkingLevel || "" }
}

/** 切模型 / 思考级别：失败时选择器回到原值（选择器读 relay，本来就没改），出 warning 通知 */
export function useModelActions(relay: Relay) {
  return {
    selectModel: (key: string, rows: readonly PiModelRow[]) => {
      const row = rows.find((m) => m.key === key)
      if (!row || row.unconfigured) return
      void relay.runCommand("set_model", { provider: row.provider, modelId: row.modelId }).then(
        () => noteSlashCommandUsed("/model"),
        (error: unknown) => relay.notify(`切换模型失败：${commandErrorText(error)}`, "warn"),
      )
    },
    setThinking: (level: string) => {
      if (level === relay.thinkingLevel) return
      void relay.runCommand("set_thinking_level", { level }).then(
        () => noteSlashCommandUsed("/thinking"),
        (error: unknown) => relay.notify(`切换思考级别失败：${commandErrorText(error)}`, "warn"),
      )
    },
  }
}

/* 旧键 pi_remote_style 里还在生效的三项：P7 B4 挪到 pi/hooks/useLegacyStyle.ts（relay/useRelay.ts、chat/composer/sound.ts 也要用，放在 containers 里会成环），这里照旧转出 */
export { saveLegacyStyle, useLegacyStyle }
/** 偏好改动 → 写到该写的地方（ui.prefs、旧键 pi_remote_style、relay.sendMode）。设置页和显示选项共用 */
export function usePrefsWriter(p: Pick<PiContainerProps, "act" | "relay">) {
  return (patch: Partial<PiSettingsPrefs>) => {
    for (const w of settingsWritesOf(patch)) {
      if (w.kind === "pref") (p.act.setPref as (key: string, value: unknown) => void)(w.key, w.value)
      else if (w.kind === "legacy") saveLegacyStyle(w.patch)
      else p.relay.setSendMode(w.value)
    }
  }
}

/**
 * Settings-page / display-options preferences. The legacy argument must
 * be the FULL legacyPrefsOf set (legacy three + G1/G2 switches):
 * settingsPrefsOf prefers the legacy copy for the ask_user switch and
 * the approval gate, and device-report adoption rewrites only the
 * legacy key -- feeding it the three-field useLegacyStyle object left
 * those fields undefined, so the display silently fell back to the
 * PiPrefs copy and never followed the device state.
 */
export function useSettingsPrefs(p: Pick<PiContainerProps, "ui" | "relay">): PiSettingsPrefs {
  const legacy = useLegacyPrefs()
  return settingsPrefsOf(p.ui.prefs, legacy, p.relay.sendMode)
}
