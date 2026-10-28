import { useEffect, useMemo, useState } from "react"
import { noteSlashCommandUsed } from "@/chat/slashUsage"
import { saveLegacyStyle, useLegacyStyle } from "@/pi/hooks/useLegacyStyle"
import { modelPillName, modelRowsOf, thinkingSegmentsOf, type PiModelRow } from "@/pi/model/models"
import { settingsPrefsOf, settingsWritesOf, type PiSettingsPrefs } from "@/pi/model/settingsView"
import { roomTitle } from "@/relay/useRelay"
import type { PiContainerProps, Relay } from "./types"

/*
 * c 线容器共用的 id、取数 hook 和小函数（P5.5；不含 JSX，免得 .tsx 文件同时导出组件和非组件）。
 * 只给 c 线的 Composer / NewSession / CommandPalette / Dialogs / Settings / DisplayOptions 容器用。
 */

/** c 线自己的浮层 id（ui.menu = 桌面锚定菜单 / tray 面板；ui.sheet = 手机 sheet）。arg：模型菜单 = 悬停 / 选中行（静态截图用） */
export const C_IDS = {
  plus: "c:plus",
  model: "c:model",
  delivery: "c:delivery",
  queue: "c:queue",
  newDevice: "c:new-device",
  newFolder: "c:new-folder",
  newPlus: "c:new-plus",
  newModel: "c:new-model",
} as const

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

/** 模型表与思考级别（菜单 / sheet 开着时才取） */
export function useModelData(relay: Relay, open: boolean) {
  const ready = open && commandsReady(relay)
  const models = useRelayCommand(relay.runCommand, ready ? "get_available_models" : null, undefined, relay.roomId)
  const levels = useRelayCommand(relay.runCommand, ready ? "get_available_thinking_levels" : null, undefined, `${relay.roomId}|${relay.model}`)
  const model = relay.model
  const modelMeta = relay.modelMeta
  const rows: PiModelRow[] = useMemo(() => (models.phase === "ready" ? modelRowsOf(models.data, { model, modelMeta }) : []), [models.phase, models.data, model, modelMeta])
  const segments = useMemo(() => (levels.phase === "ready" ? thinkingSegmentsOf(levels.data) : []), [levels.phase, levels.data])
  return { rows, segments, raw: models.data }
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

/** 设置页 / 显示选项读的偏好（提示音、网页回答、立即发送读旧键里真正生效的值） */
export function useSettingsPrefs(p: Pick<PiContainerProps, "ui" | "relay">): PiSettingsPrefs {
  const legacy = useLegacyStyle()
  return settingsPrefsOf(p.ui.prefs, legacy, p.relay.sendMode)
}
