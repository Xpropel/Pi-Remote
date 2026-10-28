/**
 * 本机弹窗等待（ui_prompt）、对话框内容卡（dialog_open / close，O1 / O2）、扩展状态快照（ext_status）的纯归约与文案。
 * P7 B2g：从 chat/composer/PromptWaiting.tsx 原样挪出（函数体、类型一字不改），relay/useRelay.ts 改从这里 import；
 * PromptWaiting.tsx 只 import 后转出，B3c 删它时不影响 useRelay 和测试。纯函数，node --test 直接加载。
 */
export type UiPrompt = {
  /** 事件里的 kind，没有就留空；不补猜类型。 */
  kind: string
  /** 事件里的 title（relay 已截到 120 字），没有就留空；不编造弹窗文案。 */
  title: string
  /** 第一次看到同一个弹窗的本地时刻（同 kind/title 的重放不重置计时）。 */
  startedAt: number
}

export type UiPromptEvent = {
  type?: string
  kind?: unknown
  title?: unknown
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * ui_prompt_start / ui_prompt_end 的事件归约。
 *  - end 立即清空；
 *  - start 建立或更新；同一 kind/title 的重放（重连补发）保留 startedAt，换弹窗才重新计时；
 *  - 未知事件原样返回，空 start 也只表示“有弹窗”，不补任何内容。
 */
export function uiPromptAfterEvent(current: UiPrompt | null, event: UiPromptEvent, now: number): UiPrompt | null {
  if (!event || typeof event !== "object") return current
  if (event.type === "ui_prompt_end") return null
  if (event.type !== "ui_prompt_start") return current
  const kind = textField(event.kind)
  const title = textField(event.title)
  const startedAt = current && current.kind === kind && current.title === title ? current.startedAt : now
  return { kind, title, startedAt }
}

/* ---------------- 对话框观察（O1）：dialog_open/close 与 ext_status 的归约 ---------------- */

export type DialogCard = {
  dialogId: string
  /** select / confirm / input / editor（custom 不会被捕获，见定版不做清单）。 */
  kind: string
  title?: string
  options?: string[]
  /** 选项总数（选项被协议上限截断时才有，> options.length）。 */
  optionsTotal?: number
  message?: string
  placeholder?: string
  prefill?: string
  /** 宿主给的超时（毫秒）：有它才有真 deadline 倒计时，没有就只显示已等待。 */
  timeout?: number
  /** 帧内 startedAt（扩展捕获时刻）：多端计时统一以它为锚，不用本地到达时刻。 */
  startedAt: number
  /** O2 接管中的 dialog（dialog_open.answerable）：网页端可直接应答；观察态（undefined）只读。 */
  answerable?: boolean
}

export type DialogEvent = {
  type?: string
  dialogId?: unknown
  kind?: unknown
  title?: unknown
  options?: unknown
  optionsTotal?: unknown
  message?: unknown
  placeholder?: unknown
  prefill?: unknown
  timeout?: unknown
  startedAt?: unknown
  answerable?: unknown
  outcome?: unknown
  reason?: unknown
  note?: unknown
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** dialog_open 帧 → 内容卡。无 dialogId/kind 的坏帧不建卡（返回 null，归约保留上一帧）。 */
export function normalizeDialogCard(event: DialogEvent, now: number): DialogCard | null {
  const dialogId = textField(event.dialogId)
  const kind = textField(event.kind)
  if (!dialogId || !kind) return null
  const card: DialogCard = {
    dialogId,
    kind,
    startedAt: typeof event.startedAt === "number" && Number.isFinite(event.startedAt) && event.startedAt > 0 ? event.startedAt : now,
  }
  const title = textField(event.title)
  if (title) card.title = title
  if (Array.isArray(event.options)) card.options = event.options.map((value) => String(value ?? ""))
  if (typeof event.optionsTotal === "number" && Number.isFinite(event.optionsTotal)) card.optionsTotal = event.optionsTotal
  const message = textField(event.message)
  if (message) card.message = message
  const placeholder = textField(event.placeholder)
  if (placeholder) card.placeholder = placeholder
  const prefill = rawText(event.prefill)
  if (prefill) card.prefill = prefill
  if (event.answerable === true) card.answerable = true
  if (typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0) card.timeout = event.timeout
  return card
}

/** 应答动作（一期决策面）：allow = Allow once / confirm 的确认；submit 带值（选项原文、输入文本）；
 * deny 带可选理由 — 理由只给人看，不回传模型（定版）。 */
export type DialogAnswer = { action: "allow" | "submit" | "deny"; value?: string; note?: string }

/** 应答发送结果：ok 已被桥接受；gone 弹窗已被处理（他端先答/已关闭）；error 发送层失败（可重试）。 */
export type DialogAnswerResult = "ok" | "gone" | "error"

/** 已拒绝回执：dialog_close{reason:"denied"} 的呈现载体。独立于 dialogs 列表 —
 * 卡片关闭即从 waiting 消失，回执只留「已拒绝 + 理由原文」给人看，可手动关掉。 */
export type DialogReceipt = {
  dialogId: string
  kind: string
  title?: string
  note?: string
  at: number
}

/** dialog_close 事件 → 拒绝回执：仅 reason==="denied" 产出，其余关闭（answered/timeout/aborted）不留回执。
 * kind/标题从被关的卡片取（close 事件本身不带）。 */
export function dialogReceiptOf(event: DialogEvent, card: DialogCard | undefined, now = Date.now()): DialogReceipt | null {
  if (!event || typeof event !== "object" || event.type !== "dialog_close") return null
  if (event.reason !== "denied") return null
  const dialogId = textField(event.dialogId) || card?.dialogId || ""
  if (!dialogId) return null
  const receipt: DialogReceipt = { dialogId, kind: card?.kind || "confirm", at: now }
  if (card?.title) receipt.title = card.title
  const note = textField(event.note)
  if (note) receipt.note = note
  return receipt
}

/**
 * dialog_open / dialog_close 的多槽归约。
 *  - open 按 dialogId 建卡或原位更新（重连补发同 id 不新增、不动 startedAt——帧里带着）；
 *  - close 按 dialogId 摘卡；未知 id / 坏帧 / 无关事件原样返回同一引用。
 */
export function dialogsAfterEvent(current: DialogCard[], event: DialogEvent, now = Date.now()): DialogCard[] {
  if (!event || typeof event !== "object") return current
  if (event.type === "dialog_close") {
    const dialogId = textField(event.dialogId)
    if (!dialogId || !current.some((card) => card.dialogId === dialogId)) return current
    return current.filter((card) => card.dialogId !== dialogId)
  }
  if (event.type !== "dialog_open") return current
  const card = normalizeDialogCard(event, now)
  if (!card) return current
  const index = current.findIndex((item) => item.dialogId === card.dialogId)
  if (index < 0) return [...current, card]
  const next = current.slice()
  next[index] = card
  return next
}

export type ExtStatusWidget = {
  key: string
  lines?: string[]
  placement?: string
  factory?: boolean
}

export type ExtStatusSnapshot = {
  statuses: Record<string, string>
  widgets: ExtStatusWidget[]
  title: string | null
  working: Record<string, unknown> | null
  /** tap 健康度：{ state: "ok" | "failed" | "off" }；failed 时 UI 回退信号模式并给出提示。 */
  tap: { state: string } | null
  at: number
}

export type ExtStatusEvent = {
  type?: string
  statuses?: unknown
  widgets?: unknown
  title?: unknown
  working?: unknown
  tap?: unknown
  at?: unknown
}

/** ext_status 全量快照归约：坏帧（statuses 不是对象）保留上一份，不清空。 */
export function extStatusAfterEvent(current: ExtStatusSnapshot | null, event: ExtStatusEvent): ExtStatusSnapshot | null {
  if (!event || typeof event !== "object" || event.type !== "ext_status") return current
  if (!event.statuses || typeof event.statuses !== "object" || Array.isArray(event.statuses)) return current
  const statuses: Record<string, string> = {}
  for (const [key, value] of Object.entries(event.statuses)) {
    if (typeof value === "string") statuses[key] = value
  }
  const widgets: ExtStatusWidget[] = []
  if (Array.isArray(event.widgets)) {
    for (const raw of event.widgets) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as { key?: unknown; lines?: unknown; placement?: unknown; factory?: unknown }
      if (typeof item.key !== "string" || !item.key) continue
      const widget: ExtStatusWidget = { key: item.key }
      if (Array.isArray(item.lines)) widget.lines = item.lines.map((line) => String(line ?? ""))
      if (typeof item.placement === "string") widget.placement = item.placement
      if (item.factory === true) widget.factory = true
      widgets.push(widget)
    }
  }
  const tapState = event.tap && typeof event.tap === "object" ? (event.tap as { state?: unknown }).state : undefined
  return {
    statuses,
    widgets,
    title: typeof event.title === "string" ? event.title : null,
    working: event.working && typeof event.working === "object" && !Array.isArray(event.working) ? (event.working as Record<string, unknown>) : null,
    tap: typeof tapState === "string" ? { state: tapState } : null,
    at: typeof event.at === "number" && Number.isFinite(event.at) ? event.at : 0,
  }
}

const DIALOG_KIND_LABELS: Record<string, string> = {
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑",
  custom: "自定义",
}

export function dialogKindLabel(kind: string): string {
  return DIALOG_KIND_LABELS[kind] || kind || "弹窗"
}

/** 单个 dialog 的计时文案：有 timeout 显示真剩余，没有显示已等待（锚点都是帧内 startedAt）。 */
export function formatDialogTiming(dialog: DialogCard, now: number): string {
  if (typeof dialog.timeout === "number" && dialog.timeout > 0) {
    return `剩余 ${formatPromptWait(Math.max(0, dialog.startedAt + dialog.timeout - now))}`
  }
  return `已等待 ${formatPromptWait(now - dialog.startedAt)}`
}

/** 等待时长：秒级 tick；超过一小时才带小时，避免 390 宽的状态条被撑开。 */
export function formatPromptWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
