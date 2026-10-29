/**
 * 旧键 pi_remote_style 里新界面还在用的三项（提示音、网页回答确认框、排队"立即发送"的方式；读写口径在 pi/model/legacyStyle.ts）。
 * P7 B4：从 pi/containers/cShared.ts 原样挪来（cShared 照旧转出 useLegacyStyle / saveLegacyStyle），
 * 因为删 style/prefs.ts 以后 relay/useRelay.ts（对话框远程应答开关）和 chat/composer/sound.ts（提示音开关）也从这里读。
 * 别的标签页改了走 storage 事件，本页写入派发 "pi-style"。
 */
import { useSyncExternalStore } from "react"
import { ASK_GATE_DEFAULTS, LEGACY_STYLE_DEFAULTS, LEGACY_STYLE_EVENT, LEGACY_STYLE_KEY, askGatePrefsOf, legacyStyleOf, legacyStyleWrite, type PiAskGatePrefs, type PiLegacyStyle } from "@/pi/model/legacyStyle"
import type { PiLegacyStylePrefs } from "@/pi/model/settingsView"
let legacyRaw: string | null | undefined
let legacyValue: PiLegacyStyle = { ...LEGACY_STYLE_DEFAULTS }
function readLegacyRaw(): string | null {
  try {
    return localStorage.getItem(LEGACY_STYLE_KEY)
  } catch {
    return null
  }
}
/** 当前生效值（非 hook，sound.ts 在回合结束时读一次） */
export function loadLegacyStyle(): PiLegacyStyle {
  const raw = readLegacyRaw()
  if (raw !== legacyRaw) {
    legacyRaw = raw
    legacyValue = legacyStyleOf(raw)
  }
  return legacyValue
}
function subscribeLegacy(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener(LEGACY_STYLE_EVENT, listener)
  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener(LEGACY_STYLE_EVENT, listener)
  }
}
const legacyServer = () => LEGACY_STYLE_DEFAULTS as PiLegacyStyle

/** 旧键里三项的生效值（提示音、网页回答确认框、排队"立即发送"的方式） */
export function useLegacyStyle(): PiLegacyStyle {
  return useSyncExternalStore(subscribeLegacy, loadLegacyStyle, legacyServer)
}

let askGateRaw: string | null | undefined
let askGateValue: PiAskGatePrefs = { ...ASK_GATE_DEFAULTS }
const askGateServer = () => ASK_GATE_DEFAULTS as PiAskGatePrefs

/** G1/G2 开关的生效值（同一个旧键、同一个事件；useRelay 下达桥时现读，与 useLegacyStyle 并行一份缓存） */
export function useAskGatePrefs(): PiAskGatePrefs {
  return useSyncExternalStore(
    subscribeLegacy,
    () => {
      const raw = readLegacyRaw()
      if (raw !== askGateRaw) {
        askGateRaw = raw
        askGateValue = askGatePrefsOf(raw)
      }
      return askGateValue
    },
    askGateServer,
  )
}

/** 写旧键里的这三项（口径同 style/prefs.ts 的 saveStyle：存储不可用时不落盘，照样派发事件） */
export function saveLegacyStyle(patch: PiLegacyStylePrefs) {
  try {
    localStorage.setItem(LEGACY_STYLE_KEY, legacyStyleWrite(readLegacyRaw(), patch))
  } catch {
    // 隐私模式 / 配额满：这次不落盘
  }
  window.dispatchEvent(new Event(LEGACY_STYLE_EVENT))
}

