/** 回合完成提示音：WebAudio 现场合成，不带任何音频文件。
 *
 *  语义（定版，勿改）：
 *  - 开关 completionSound 存既有偏好（style/prefs），默认关；关时任何情况无声。
 *  - 只在页面不在场（失焦或隐藏，口径同 faviconBadge.pageAway）时响；正盯着页面不响。
 *  - 与 favicon 角标同源：同一个 relay.turnEnd 信号（当前房间），按 seq 去重，
 *    同一回合只响一次；聚焦时到达的信号被静默消费，之后再失焦不补响。
 *  - AudioContext 必须经用户手势解锁：首次 pointerdown / keydown / touchend 时
 *    顺带创建并 resume；未解锁（context 不在 running）时触发一律静默跳过、
 *    不报错、不排队补响——oscillator 绝不挂到 suspended 的 context 上等它醒。
 *  - 音量固定低档（峰值 0.15），不另设音量项。
 */

import { useEffect, useRef, useState } from "react"
import { loadLegacyStyle } from "@/pi/hooks/useLegacyStyle"
import { pageAway, type BadgeRelay } from "./faviconBadge"
import {
  completionSoundGate,
  decideTurnEndSound,
  toneSpecsFor,
  type CompletionSoundKind,
  type ToneSpec,
} from "./soundDecision"

export type { CompletionSoundKind } from "./soundDecision"

const PEAK = 0.15

let sharedCtx: AudioContext | null = null
let unlockWired = false

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (sharedCtx) return sharedCtx
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    sharedCtx = new Ctor()
  } catch {
    return null
  }
  return sharedCtx
}

/** 手势解锁只装一次：任何首次点击/按键都顺带把 context 唤醒，失败静默。 */
function wireUnlock() {
  if (unlockWired || typeof window === "undefined") return
  unlockWired = true
  const unlock = () => {
    const ctx = ensureContext()
    if (ctx && ctx.state !== "running") {
      void ctx.resume().catch(() => {})
    }
  }
  window.addEventListener("pointerdown", unlock, { capture: true, passive: true })
  window.addEventListener("keydown", unlock, { capture: true })
  window.addEventListener("touchend", unlock, { capture: true, passive: true })
}

function scheduleTone(ctx: AudioContext, spec: ToneSpec) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = "sine"
  const t0 = ctx.currentTime + spec.at
  osc.frequency.setValueAtTime(Math.max(1, spec.from), t0)
  if (spec.to !== spec.from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.dur)
  }
  // 快起慢落的包络避免爆音；峰值就是定版的低档音量。
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(PEAK, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + spec.dur + 0.05)
}

/** 真正发声。context 不在 running（未解锁/被策略挂起）时静默跳过，返回 false。 */
function playTones(kind: CompletionSoundKind): boolean {
  const ctx = sharedCtx
  if (!ctx || ctx.state !== "running") return false
  try {
    // 音色谱在 soundDecision.toneSpecsFor 定版，这里只按谱逐音排程。
    for (const spec of toneSpecsFor(kind)) scheduleTone(ctx, spec)
    return true
  } catch {
    return false
  }
}

export function completionSoundEnabled(): boolean {
  try {
    return loadLegacyStyle().completionSound === true
  } catch {
    return false
  }
}

/**
 * 回合完成时调用：开关开 + 页面不在场（默认）+ 已解锁，三条同真才响。
 * 设置 v2 的「总是提醒」传 requireAway:false；任何一条不满足都是静默无操作（不报错、不补响）。
 */
export function playCompletionSound(kind: CompletionSoundKind, options: { enabled?: boolean; requireAway?: boolean } = {}) {
  wireUnlock()
  // 双闸在 soundDecision.completionSoundGate 定版；开关在此刻现读、失焦口径与角标同源。
  const enabled = options.enabled ?? completionSoundEnabled()
  if (!completionSoundGate({ enabled, away: pageAway(), requireAway: options.requireAway !== false })) return
  playTones(kind)
}

/** 设置页试听：绕过开关与失焦条件；点击本身就是手势，可顺带解锁。 */
export function playTestSound(kind: CompletionSoundKind) {
  wireUnlock()
  const ctx = ensureContext()
  if (!ctx) return
  if (ctx.state === "running") {
    playTones(kind)
    return
  }
  void ctx
    .resume()
    .then(() => {
      playTones(kind)
    })
    .catch(() => {})
}

export interface UseCompletionSoundOptions {
  /** 提示音开关（设置 › 通知「提示音」）；不传 = 旧键 completionSound（兼容旧入口）。 */
  enabled?: boolean
  /** 任务完成时响。 */
  doneEnabled?: boolean
  /** 出错时响。 */
  errorEnabled?: boolean
  /** true = 仅当页面不在场；false = 总是提醒（页面在场也响）。 */
  onlyWhenAway?: boolean
}

/**
 * 完成提示音 hook：与 useCompletionBadge 并列消费 relay.turnEnd（当前房间）。
 *  - 每条 seq 只消费一次：失焦时响一声并消费；聚焦时静默消费，之后失焦不重响；
 *  - 开关在响的那一刻现读偏好，设置页改完下一个回合即生效，无需刷新；
 *  - P13：事件类型 / 仅页面外 / 总是提醒由宿主按设置 v2 传入。
 */
export function useCompletionSound(relay: BadgeRelay, options: UseCompletionSoundOptions = {}) {
  const { enabled, doneEnabled = true, errorEnabled = true, onlyWhenAway = true } = options
  const [away, setAway] = useState(pageAway)
  const consumedRef = useRef(0)

  useEffect(() => {
    wireUnlock()
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

  const signal = relay.turnEnd && relay.turnEnd.roomId === relay.roomId ? relay.turnEnd : null

  useEffect(() => {
    if (!signal) return
    const soundEnabled = enabled ?? completionSoundEnabled()
    // 消费/发声决策在 soundDecision.decideTurnEndSound 定版；这里只落账与发声。
    const decision = decideTurnEndSound({
      seq: signal.seq,
      error: signal.error,
      consumedSeq: consumedRef.current,
      away,
      enabled: soundEnabled,
      doneEnabled,
      errorEnabled,
      awayOnly: onlyWhenAway,
    })
    if (!decision.consume) return
    consumedRef.current = signal.seq
    if (decision.kind) playCompletionSound(decision.kind, { enabled: soundEnabled, requireAway: onlyWhenAway })
  }, [signal, away, enabled, doneEnabled, errorEnabled, onlyWhenAway])
}
