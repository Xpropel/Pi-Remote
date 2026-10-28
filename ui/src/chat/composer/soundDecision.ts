/** 完成提示音的纯决策：零导入、无 DOM / 无 React / 无偏好读取，可直接单测。
 *
 *  sound.ts 只做副作用（现读偏好、看页面在不在场、WebAudio 发声、管
 *  AudioContext 解锁）；「该不该响、响哪种音色、这条 turnEnd 信号算不算
 *  消费过」全部在这里定版，语义与 sound.ts 文件头注释一致、勿单独改一处。
 */

export type CompletionSoundKind = "done" | "error" | "waiting"

export type ToneSpec = { from: number; to: number; at: number; dur: number }

/**
 * 音色谱：
 *  - done 单音上行（D5 → A5）短促收尾；
 *  - error 双音下行（C4 微降 → G3 微降），第二音稍长；
 *  - waiting 双音上行（C5 → E5 → G5）像提问，区别于「完成」的收尾感。
 */
export function toneSpecsFor(kind: CompletionSoundKind): ToneSpec[] {
  if (kind === "done") return [{ from: 587, to: 880, at: 0, dur: 0.18 }]
  if (kind === "waiting") {
    return [
      { from: 523, to: 659, at: 0, dur: 0.14 },
      { from: 784, to: 784, at: 0.16, dur: 0.12 },
    ]
  }
  return [
    { from: 262, to: 247, at: 0, dur: 0.11 },
    { from: 196, to: 185, at: 0.13, dur: 0.17 },
  ]
}

/**
 * 发声双闸：开关开（由调用方在发声那一刻现读偏好后传入），且（默认）页面不在场。
 * 设置 › 通知「总是提醒」时 requireAway = false，页面在场也响；任一不满足都是静默无操作。
 */
export function completionSoundGate(input: { enabled: boolean; away: boolean; requireAway?: boolean }): boolean {
  return input.enabled && (input.requireAway === false || input.away)
}

export type TurnEndSoundDecision = {
  /** 是否把这条 seq 记为已消费：新 seq 一律消费；已消费过的 seq 不再动。 */
  consume: boolean
  /** 要响的音色；null = 静默（聚焦时静默消费，或这条 seq 已经消费过）。 */
  kind: CompletionSoundKind | null
}

/**
 * 一条 turnEnd 信号的消费决策：
 *  - seq 与已消费 seq 相同 → 不重复消费、不响（同一回合只响一次）；
 *  - 新 seq → 先消费再说响不响：没有开启提示音 / 对应事件类型关闭 / 页面在场且仅页面外提醒时
 *    静默消费（kind=null），之后再失焦也不会补响，因为 seq 已经被记下；
 *    其余情况给音色：error 结束走 "error"，正常结束走 "done"。
 *  enabled / doneEnabled / errorEnabled / awayOnly 由宿主按设置 v2 的 prefs.notifications 传入；
 *  不传时保持旧行为（enabled=true、两类事件都响、仅页面外）。
 */
export function decideTurnEndSound(input: {
  seq: number
  error: boolean
  consumedSeq: number
  away: boolean
  enabled?: boolean
  doneEnabled?: boolean
  errorEnabled?: boolean
  awayOnly?: boolean
}): TurnEndSoundDecision {
  if (input.seq === input.consumedSeq) return { consume: false, kind: null }
  const eventEnabled = input.error ? input.errorEnabled !== false : input.doneEnabled !== false
  const audible = input.enabled !== false && eventEnabled && (input.awayOnly === false || input.away)
  return { consume: true, kind: audible ? (input.error ? "error" : "done") : null }
}
