/** 第 5 章交互质感的纯逻辑与唯一数值源。
 *
 *  这里不依赖 React/DOM，方便 Node 直接做单测。CSS 中的同名数值必须与这里
 *  对齐（test/chapter5-composer.test.mjs 会做源码断言），组件只消费常量，
 *  避免悬停、按压、转场、回底钮各自漂移。
 */

/** 悬停显隐：进入 120ms，离开 80ms。 */
export const HOVER_REVEAL_IN_MS = 120
export const HOVER_REVEAL_OUT_MS = 80
/** 按钮按压：scale 0.97 / 80ms；禁用态不参与。 */
export const PRESS_SCALE = 0.97
export const PRESS_MS = 80
/** 切换会话：160ms opacity + 4px 位移。 */
export const SESSION_SWITCH_MS = 160
export const SESSION_SWITCH_OFFSET_PX = 4
/** 回底钮：距底 > 120px 才出现，高 32px；≤2000px 平滑，否则即时。 */
export const BACK_TO_BOTTOM_THRESHOLD_PX = 120
export const BACK_TO_BOTTOM_SIZE_PX = 32
export const BACK_TO_BOTTOM_SMOOTH_MAX_PX = 2000
export const BACK_TO_BOTTOM_SCROLL_MS = 240
/** 复制成功 ✓ 停留 1.2s 后回退；失败才进通知。 */
export const COPY_FEEDBACK_HOLD_MS = 1200
/** 通知进出场：入场 200ms / 退场 150ms。 */
export const NOTICE_ENTER_MS = 200
export const NOTICE_EXIT_MS = 150
/** 快捷键提示：首次悬停 500ms；3s 窗口内再次悬停 0ms。 */
export const TOOLTIP_FIRST_DELAY_MS = 500
export const TOOLTIP_WARM_WINDOW_MS = 3000
/** 斜杠菜单行高 30px（移动端 36px 命中区由 CSS 另加）。 */
export const SLASH_ROW_HEIGHT_PX = 30
/** kbd 统一规格。 */
export const KBD_FONT_PX = 11
export const KBD_LINE_PX = 16
export const KBD_RADIUS_PX = 5
/** 循环动画并发预算：最多 2 个。流式光标永不降级。 */
export const MOTION_LOOP_BUDGET = 2

export type LoopKind = "caret" | "connection" | "spinner" | "skeleton"

export type LoopCandidate = {
  id: string
  kind: LoopKind
}

const LOOP_PRIORITY: Record<LoopKind, number> = {
  caret: 0,
  connection: 1,
  spinner: 2,
  skeleton: 3,
}

/**
 * 第 5 章 §2.4：按优先级从高到低最多放行 2 个循环动画。
 * 流式光标永不降级；其余超额者由调用方降级为静态形态。
 */
export function selectLoopBudget<T extends LoopCandidate>(
  loops: readonly T[],
  budget: number = MOTION_LOOP_BUDGET,
): { active: T[]; degraded: T[] } {
  const rank = (loop: T) => LOOP_PRIORITY[loop.kind]
  const sorted = [...loops].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  const carets = sorted.filter((loop) => loop.kind === "caret")
  const rest = sorted.filter((loop) => loop.kind !== "caret")
  const room = Math.max(0, Math.max(0, Math.floor(budget)) - carets.length)
  return { active: [...carets, ...rest.slice(0, room)], degraded: rest.slice(room) }
}

export function backToBottomVisible(distancePx: number, unread: number, streaming: boolean): boolean {
  return distancePx > BACK_TO_BOTTOM_THRESHOLD_PX && (unread > 0 || streaming)
}

export type BackToBottomPlan = {
  visible: boolean
  behavior: "smooth" | "instant"
  label: string
  unread: number
}

/** 回底钮的显示条件、滚动方式与计数文案（上限 99+）。 */
export function backToBottomPlan(input: {
  distancePx: number
  unread?: number
  streaming?: boolean
}): BackToBottomPlan {
  const unread = Math.max(0, Math.floor(input.unread ?? 0))
  const visible = backToBottomVisible(input.distancePx, unread, input.streaming === true)
  return {
    visible,
    behavior: input.distancePx <= BACK_TO_BOTTOM_SMOOTH_MAX_PX ? "smooth" : "instant",
    label: unread > 99 ? "99+ 条新消息" : unread > 0 ? `${unread} 条新消息` : "",
    unread,
  }
}

/* ------------------------------------------------------------------ */
/* 连接 6 态：一个状态点 + 一句话，不用横幅                            */
/* ------------------------------------------------------------------ */

export type ConnectionState =
  | "connecting"
  | "reconnecting"
  | "connected"
  | "offline"
  | "device-offline"
  | "device-busy"

export type ConnectionTone = "info" | "success" | "warning" | "error" | "muted"
export type ConnectionShape = "solid" | "ring"

export type ConnectionChip = {
  state: ConnectionState
  /** 一句话；重连第 2 次起带「第 n 次 · Ns」。 */
  label: string
  tone: ConnectionTone
  shape: ConnectionShape
  breathing: boolean
  /** 重连倒计时秒数；非重连或第 1 次重试为 null。 */
  countdownSeconds: number | null
  retryCount: number
  ariaLabel: string
}

export type ConnectionInput = {
  authed: boolean
  everConnected: boolean
  retryAt: number | null
  now?: number
  /** 第几次重连，从 1 起；第 1 次不显示倒计时。 */
  retryCount?: number
  device?: { name?: string | null; online?: boolean | null } | null
  /** 当前会话在生成；设备在线但忙时给「运行中」，仍算稳定态。 */
  busy?: boolean
  /** 只点选未载入的会话不影响连接态。 */
  lazySession?: boolean
  /** 本次掉线已持续多久（毫秒）；由 useLinkState 提供。 */
  downFor?: number
  /** 正在拨号 / 等 auth_result（socket CONNECTING 或过程状态映射）；该档不判已断开。 */
  trying?: boolean
  /** 重连持续多久后降级为「已断开」；默认 30s。 */
  offlineAfter?: number
}

/** §2.7.2：重连持续 30s 仍没恢复，状态点 / 胶囊 / 连接页一起降级为「已断开」。 */
export const CONNECTION_OFFLINE_AFTER_MS = 30_000

function retrySuffix(countdown: number | null, retryCount: number): string {
  return countdown == null ? "" : ` · 第 ${retryCount} 次 · ${countdown}s`
}

/** 只有重连态会因超时降级；首次连接与设备状态不参与。 */
function degradedByTime(input: ConnectionInput): boolean {
  if (typeof input.downFor !== "number" || !Number.isFinite(input.downFor)) return false
  const limit =
    typeof input.offlineAfter === "number" && Number.isFinite(input.offlineAfter) && input.offlineAfter > 0
      ? input.offlineAfter
      : CONNECTION_OFFLINE_AFTER_MS
  return input.downFor >= limit
}

function offlineChip(retryCount: number): ConnectionChip {
  return {
    state: "offline",
    label: "已断开",
    tone: "error",
    shape: "ring",
    breathing: false,
    countdownSeconds: null,
    retryCount,
    ariaLabel: "连接状态：已断开",
  }
}

/**
 * 6 态优先级：断开后正在自动重连 > 首次连接 > 设备离线 > 设备忙 >
 * 已连接；offline 是断开后没有排下一次重连的稳定态。
 */
export function connectionChip(input: ConnectionInput): ConnectionChip {
  const now = input.now ?? Date.now()
  const deviceName = input.device?.name?.trim() || "设备"
  const retryCount = Math.max(1, Math.floor(input.retryCount ?? 1))

  if (!input.authed) {
    if (!input.everConnected) {
      return {
        state: "connecting",
        label: "连接中…",
        tone: "info",
        shape: "solid",
        breathing: true,
        countdownSeconds: null,
        retryCount: 0,
        ariaLabel: "连接状态：连接中",
      }
    }
    // 30s 降级优先于重连倒计时：仍然保留 立即重连 按钮，只把展示态收成「已断开」。
    if (degradedByTime(input)) return offlineChip(retryCount)
    // 拨号 / 鉴权中：还没有失败结论，不能因为 retryAt 被 connect() 清空就跳到 offline。
    // 这一档统一「重连中…」，不带倒计时（倒计时属于两次尝试之间的等待期）。
    if (input.trying) {
      return {
        state: "reconnecting",
        label: "重连中…",
        tone: "warning",
        shape: "solid",
        breathing: true,
        countdownSeconds: null,
        retryCount,
        ariaLabel: "连接状态：重连中",
      }
    }
    if (input.retryAt != null) {
      const seconds = Math.max(0, Math.ceil((input.retryAt - now) / 1000))
      // 第 1 次重试只有「重连中…」；从第 2 次起才报次数与倒计时。
      const countdown = retryCount >= 2 ? seconds : null
      const label = retryCount >= 2 ? `重连中${retrySuffix(countdown, retryCount)}` : "重连中…"
      return {
        state: "reconnecting",
        label,
        tone: "warning",
        shape: "solid",
        breathing: true,
        countdownSeconds: countdown,
        retryCount,
        ariaLabel: `连接状态：${label}`,
      }
    }
    return offlineChip(retryCount)
  }

  if (input.device && input.device.online === false) {
    return {
      state: "device-offline",
      label: `${deviceName} 离线`,
      tone: "muted",
      shape: "ring",
      breathing: false,
      countdownSeconds: null,
      retryCount,
      ariaLabel: `连接状态：${deviceName} 离线`,
    }
  }

  if (input.busy) {
    return {
      state: "device-busy",
      label: "运行中",
      tone: "warning",
      shape: "solid",
      breathing: false,
      countdownSeconds: null,
      retryCount,
      ariaLabel: "连接状态：运行中",
    }
  }

  return {
    state: "connected",
    label: "已连接",
    tone: "success",
    shape: "solid",
    breathing: false,
    countdownSeconds: null,
    retryCount,
    ariaLabel: "连接状态：已连接",
  }
}

/* ------------------------------------------------------------------ */
/* 发送中的延迟显形                                                     */
/* ------------------------------------------------------------------ */

/** ack 在 200ms 内到达时，「发送中」标记永不出现。 */
export const SENDING_HINT_DELAY_MS = 200

export function sendingHintVisible(elapsedMs: number): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs > SENDING_HINT_DELAY_MS
}

/* ------------------------------------------------------------------ */
/* 复制反馈                                                             */
/* ------------------------------------------------------------------ */

export type CopyFeedback = "idle" | "pending" | "copied" | "failed"

/** 复制成功就地 morph；只允许 copied/failed 两种结果，失败仍走通知解释。 */
export function copyFeedbackAfter(ok: boolean): CopyFeedback {
  return ok ? "copied" : "failed"
}
