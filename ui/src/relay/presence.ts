/** 连接与会话状态的展示口径（纯逻辑，不依赖 React）：头部状态行、标签页标题、断线横幅共用一份。
 *  三种断开分开叫（DOC/40 §10）：网页和服务器断了叫「断开 / 重连中」，设备没开 attach 叫「未连接」，
 *  会话没在跑叫「已结束」；面向用户不写「离线」。 */
// test/ui-sync.test.mjs 用 node 直接跑 .ts 源文件，相对导入必须带扩展名
import { baseName } from "./devices.ts"
import type { AttentionKind } from "./attention.ts"

export type LinkInput = {
  token: string
  authed: boolean
  /** 这个 token 连上过一次：之后再断开算"重连"，没连上过算"连不上" */
  everConnected: boolean
  /** 排定的下一次重连时刻；正在连或已连上时为 null */
  retryAt: number | null
}

export type LinkView =
  | { kind: "ok" }
  | { kind: "first" }
  | { kind: "waiting"; seconds: number; first: boolean }
  | { kind: "reconnecting" }

/** ok = 已连上（或在登录页）；first = 第一次连接中；waiting = 断了、等下一次重连；reconnecting = 断了、正在重连 */
export function linkView(input: LinkInput, now: number): LinkView {
  if (!input.token || input.authed) return { kind: "ok" }
  if (input.retryAt != null) return { kind: "waiting", seconds: Math.max(0, Math.ceil((input.retryAt - now) / 1000)), first: !input.everConnected }
  return input.everConnected ? { kind: "reconnecting" } : { kind: "first" }
}

/**
 * 页面上各处共用的连接口径（账户区第二行、连接状态行、输入框原因、tray）：浏览器自己报断网（navigator.onLine=false）时
 * 按"重连中"，不等 socket 的 close。真实断网时 WebSocket 要等心跳判死（PING_INTERVAL_MS 25s，最长约 50s）才 close，
 * 只看 authed 的地方会在这段时间里一直写"已连接"，和输入框的"未连接服务器"对不上（联动测试 L16）。
 */
export function pageLinkView(input: LinkInput & { browserOnline: boolean }, now: number): LinkView {
  return input.browserOnline ? linkView(input, now) : { kind: "reconnecting" }
}

/** 第一次连接（还没连上过、也没在等重试）才显示加载条；断线重连归横幅管，两者不同时出现 */
export function firstConnecting(input: LinkInput): boolean {
  return linkView(input, 0).kind === "first"
}

export function linkBannerText(view: LinkView): string {
  if (view.kind === "waiting") return view.first ? `连不上服务器，${view.seconds} 秒后重试` : `和服务器的连接断了，${view.seconds} 秒后重连`
  if (view.kind === "reconnecting") return "正在重新连接服务器…"
  return ""
}

export function roomStatusText(room: { online: boolean; busy: boolean }): string {
  return room.online ? (room.busy ? "运行中" : "在线") : "已结束"
}

export type HeaderInput = {
  room: { cwd: string | null } | null
  authed: boolean
  everConnected: boolean
  online: boolean
  /** 本机 pi 掉线已确认；刚掉线、还在换会话的过渡期里不写「已结束」，免得闪一下 */
  roomDown: boolean
  busy: boolean
  /** 名册生效时选中的设备；没有名册（旧 relay）时为 null */
  device: { name: string; online: boolean } | null
}

/** 头部状态行：只留连接状态、目录、设备；模型/档位/用量在输入框上下分区展示。 */
export function headerMeta(input: HeaderInput): string[] {
  const status = !input.authed
    ? input.everConnected ? "服务器已断开" : "连接中"
    : input.device && !input.device.online
      ? "设备未连接"
      : input.room && (input.online || input.roomDown)
        ? roomStatusText(input)
        : ""
  return [status, input.room?.cwd ? baseName(input.room.cwd) : "", input.device?.name || ""].filter(Boolean)
}

export type TitleInput = {
  /** 当前会话名；没选会话时为空串 */
  room: string
  busy: boolean
  /** 页面在后台时这一轮跑完了，用户还没回来看 */
  unseenDone: boolean
  /** 连上过、现在断了 */
  linkLost: boolean
  /**
   * P9 修复线 W（review-1 P2-2）：有任意「等你回答」（attentionItemsOf 里 kind==="waiting"，
   * 含别房 waiting / waitingPrompt）。标题前缀「? 」优先于「● 」（运行中）和「✓」。
   */
  waiting?: boolean
}

export type TitleTrack = { busy: boolean; roomId: string; unseen: boolean }

/** 「后台跑完」标记：同一会话从运行中变成空闲、页面又在后台时打上；重新运行或换了会话就清掉（回到页面也清，见 usePageTitle） */
export function nextUnseen(prev: TitleTrack, next: { busy: boolean; roomId: string; hidden: boolean }): boolean {
  if (next.roomId !== prev.roomId || next.busy) return false
  if (prev.busy && next.hidden) return true
  return prev.unseen
}

/**
 * 标签页标题：标记放最前，标签页很窄时也能看到。
 * 优先级（review-1 P2-2）：已断开 > 等你回答「? 」> 运行中「● 」> 后台完成「✓」。
 * 「等你回答」压过运行中与完成标记（连接断开仍排最前，断了的时候网页也答不了）。
 */
export function pageTitle(input: TitleInput): string {
  const base = input.room ? `${input.room} · pi` : "pi"
  if (input.linkLost) return `已断开 · ${base}`
  if (input.waiting) return `? ${base}`
  if (input.busy) return `● ${base}`
  if (input.unseenDone) return `✓ ${base}`
  return base
}

/* ---------------- 注意力状态点语义（P3-6）：侧栏会话行与待处理清单共用一份 ---------------- */

export type AttentionDotTone = "success" | "warning" | "danger" | "muted"
export type AttentionDot = { tone: AttentionDotTone; pulse: boolean; label: string }

/**
 * 状态点语义表（纯函数，与 linkView 等呈现函数分工：linkView 管连接面，本表管
 * "这个会话现在要不要人管"）。优先级：注意力条目 > 运行中 > 在线 / 已结束。
 * tone 只是语义名，落色由 CSS 按语义色 token 处理；形状只有实心点，pulse 决定
 * 是否呼吸——呈现细节不进逻辑。行上的运行中由既有 spinner 呈现，与本表的
 * success + pulse 是同一语义的两种载体（行内空间只够一个指示位）。
 */
export function attentionDotOf(input: {
  /** attentionForRoom 的结果；device-offline 不落行，但清单条目也查本表取点 */
  item: { kind: AttentionKind } | null
  busy: boolean
  online: boolean
}): AttentionDot {
  switch (input.item?.kind) {
    case "waiting":
      return { tone: "warning", pulse: true, label: "等你处理" }
    case "error":
      return { tone: "danger", pulse: false, label: "回合出错了" }
    case "done":
      return { tone: "success", pulse: false, label: "已完成，还没看" }
    case "device-offline":
      return { tone: "danger", pulse: false, label: "设备未连接" }
  }
  if (input.busy) return { tone: "success", pulse: true, label: "运行中" }
  if (!input.online) return { tone: "muted", pulse: false, label: "已结束" }
  return { tone: "success", pulse: false, label: "在线" }
}
