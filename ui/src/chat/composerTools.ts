/** 输入卡底部工具栏的纯逻辑：投递方式、图片预算、模型显示、文本文件读取与插入。
 *  不依赖 React / 浏览器全局（TextDecoder 除外，Node 与浏览器都有），可直接单测。 */

import { prepareSendImage, type SendImage } from "../relay/transcript.ts"

export const COMPOSER_MAX_CHARS = 8000
export const TEXT_FILE_MAX_BYTES = 64 * 1024
export const SEND_IMAGE_MAX_CHARS = 131072
/** 输入条最多同时挂 5 张图；与 S0–S7 的 attachmentMaxCount 默认值一致。 */
export const MAX_PENDING_IMAGES = 5
/** 图片合计预算（base64 字符）。viewer 单帧上限 256KB，留出正文与 JSON 封装的空间；
 *  超过它的图片不再加入输入条，发送时也会明确告诉用户哪几张没发。 */
export const SEND_IMAGE_TOTAL_MAX_CHARS = 192 * 1024
/** 小于这个额度的图片不再压缩：缩到看不清也没有发送价值，直接明确拒绝。 */
export const MIN_IMAGE_BUDGET_CHARS = 4096
export const SEND_MODE_KEY = "pi_remote_send_mode"

export type SendMode = "auto" | "steer" | "follow_up"
export type SendCommand = "prompt" | "steer" | "follow_up"

export const SEND_MODES: readonly SendMode[] = ["auto", "steer", "follow_up"]

/** 存进 localStorage 的值只认三个真实投递方式；旧值/脏值一律回到自动。 */
export function parseSendMode(value: unknown): SendMode {
  return value === "steer" || value === "follow_up" ? value : "auto"
}

export function sendModeLabel(mode: SendMode): string {
  if (mode === "steer") return "插入当前回合"
  if (mode === "follow_up") return "排队"
  return "自动"
}

export function sendModeShortLabel(mode: SendMode): string {
  if (mode === "steer") return "当前回合"
  if (mode === "follow_up") return "排队"
  return "自动"
}

export function sendModeNote(mode: SendMode): string {
  if (mode === "steer") return "steer：当前工具结束后插入；空闲时按普通消息立即发送"
  if (mode === "follow_up") return "follow_up：等当前回合完全结束后投递；空闲时按普通消息立即发送"
  return "忙时插入当前回合，空闲时直接发送"
}

export type DeliveryPlan = { command: SendCommand; idleFallback: boolean }

/** 空闲时 prompt/steer/follow_up 都只会开一个新回合（pi 忽略空闲时的 deliverAs），
 *  所以这里明确回落 prompt，不假装“排队”。忙碌时按用户选择走 steer / follow_up。 */
export function deliveryPlan(mode: SendMode, busy: boolean): DeliveryPlan {
  if (!busy) return { command: "prompt", idleFallback: mode !== "auto" }
  if (mode === "follow_up") return { command: "follow_up", idleFallback: false }
  return { command: "steer", idleFallback: false }
}

export type SizedImage = { data: string }

/** 已挂图片的 base64 字符数合计（不把 data URL 前缀算进去，与扩展/relay 的口径一致）。 */
export function imageCharsTotal(images: readonly SizedImage[] | null | undefined): number {
  if (!images?.length) return 0
  let total = 0
  for (const image of images) total += typeof image?.data === "string" ? image.data.length : 0
  return total
}

/** 本次还能接收几张图。 */
export function remainingImageSlots(count: number, maxCount = MAX_PENDING_IMAGES): number {
  return Math.max(0, Math.floor(maxCount) - Math.max(0, Math.floor(count)))
}

/**
 * 一批新图的单张预算：先保证整批都塞得进合计上限，再受单图 128K 上限约束。
 * 例：一次选 5 张时每张约 38K；只选 1 张时最多可用到 128K。
 * 返回值可能小于 MIN_IMAGE_BUDGET_CHARS，调用方应明确拒绝而不是硬塞。
 */
export function imageBudgetFor(
  totalChars: number,
  batchRemaining: number,
  maxSingle = SEND_IMAGE_MAX_CHARS,
  maxTotal = SEND_IMAGE_TOTAL_MAX_CHARS,
): number {
  const remaining = Math.max(0, maxTotal - Math.max(0, totalChars))
  const slots = Math.max(0, Math.floor(batchRemaining))
  if (!slots) return 0
  return Math.min(maxSingle, Math.floor(remaining / slots))
}

export type PlannedSendImages = { images: SendImage[] | undefined; notice: string }

/**
 * 发送前的图片筛选：单张超限/格式不对只丢这一张，合计超预算只丢放不下的那几张。
 * 返回值里没有正文——调用方照常用原有 text 发送，**绝不因为一张坏图拦下整条消息**。
 */
export function planSendImages(
  attached: readonly SendImage[],
  maxTotal = SEND_IMAGE_TOTAL_MAX_CHARS,
): PlannedSendImages {
  const accepted: SendImage[] = []
  const rejected: string[] = []
  let total = 0
  for (const image of attached) {
    const prepared = prepareSendImage(image)
    if (!prepared.image) {
      if (prepared.reason) rejected.push(prepared.reason)
      continue
    }
    if (total + prepared.image.data.length > maxTotal) {
      rejected.push(`图片合计超过 ${Math.round(maxTotal / 1024)}K 字符，这一张没有发送`)
      continue
    }
    accepted.push(prepared.image)
    total += prepared.image.data.length
  }
  const images = accepted.length ? accepted : undefined
  if (!rejected.length) return { images, notice: "" }
  return {
    images,
    notice:
      rejected.length === 1
        ? rejected[0]
        : `有 ${rejected.length} 张图未随消息发送：${rejected.slice(0, 3).join("；")}${rejected.length > 3 ? "…" : ""}`,
  }
}

export type ModelMeta = { provider?: string; modelId?: string; name?: string }

function nonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

/** 从 pi 的 Model 对象、事件里的 model 对象或 assistant 消息里取模型身份。
 *  assistant 消息的 model 字段是模型 id；modelId/id 也是 id；name 只作显示名。 */
export function modelMetaFrom(value: unknown, fallbackId?: string): ModelMeta | null {
  if (!value || typeof value !== "object") {
    const id = nonEmpty(fallbackId)
    return id ? { modelId: id } : null
  }
  const row = value as Record<string, unknown>
  const provider = nonEmpty(row.provider)
  const modelId = nonEmpty(row.modelId) || nonEmpty(row.id) || nonEmpty(row.model) || nonEmpty(fallbackId)
  const name = nonEmpty(row.name)
  if (!provider && !modelId && !name) return null
  const out: ModelMeta = {}
  if (provider) out.provider = provider
  if (modelId) out.modelId = modelId
  if (name) out.name = name
  return out
}

/** 模型切换后旧名字不能盖在新模型上；同一个模型则保留 get_state 带回来的显示名。 */
export function mergeModelMeta(prev: ModelMeta, next: ModelMeta | null): ModelMeta {
  if (!next) return prev
  const changed = !!prev.modelId && !!next.modelId && prev.modelId !== next.modelId
  if (changed) return next
  const merged: ModelMeta = { ...prev, ...next }
  if (!next.name && prev.name) merged.name = prev.name
  return merged
}

/** 优先 modelId（如 step-5-preview）；没有 modelId 才回落显示名。 */
export function modelLabel(meta: ModelMeta | null | undefined, fallback?: string | null): string {
  return nonEmpty(meta?.modelId) || nonEmpty(meta?.name) || nonEmpty(fallback) || "模型"
}

/** 完整 provider/modelId 给 tooltip；缺一半时不拼半截。 */
export function modelTitle(meta: ModelMeta | null | undefined, fallback?: string | null): string {
  const provider = nonEmpty(meta?.provider)
  const modelId = nonEmpty(meta?.modelId)
  if (provider && modelId) return `${provider}/${modelId}`
  if (modelId) return modelId
  return nonEmpty(meta?.name) || nonEmpty(fallback)
}

export type TextDecodeResult = { ok: true; text: string } | { ok: false; reason: string }

/** 只接受 UTF-8 文本：NUL 字节按二进制拒绝；非法 UTF-8 用 fatal 解码拒绝。
 *  UTF-8 BOM 去掉；空文件不插入。 */
export function decodeTextFile(bytes: Uint8Array): TextDecodeResult {
  if (!bytes.length) return { ok: false, reason: "文件是空的，没有可插入的文本" }
  for (let i = 0; i < Math.min(bytes.length, 8192); i += 1) {
    if (bytes[i] === 0) return { ok: false, reason: "这是二进制文件，不是 UTF-8 文本，未插入" }
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: "文件不是合法的 UTF-8 文本，未插入" }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.trim()) return { ok: false, reason: "文件只有空白字符，没有可插入的文本" }
  return { ok: true, text: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n") }
}

export type FileInsertResult =
  | {
      ok: true
      text: string
      contentChars: number
      insertedChars: number
      truncated: boolean
      omittedChars: number
    }
  | { ok: false; reason: string }

function fenceFor(content: string): string {
  const runs = content.match(/`+/g) || []
  let longest = 2
  for (const run of runs) longest = Math.max(longest, run.length)
  return "`".repeat(longest + 1)
}

function safeFileName(name: string): string {
  return (name || "file.txt").replace(/[\r\n`]/g, " ").replace(/\s+/g, " ").trim() || "file.txt"
}

/** 不切断代理对（emoji 等），截断时少一个字而不是半个。 */
function cutAt(text: string, length: number): string {
  if (length <= 0) return ""
  if (length >= text.length) return text
  let end = length
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, Math.max(0, end))
}

/**
 * 把文本文件变成带文件名的 fenced block 追加到输入框，并守住 8000 字上限。
 * 超出可用字数的部分截断（尾部留一个 …），由调用方提示截断了多少字；不会把 textarea 撑爆。
 * 输入框连 fence 头都放不下时直接拒绝，返回原因。
 */
export function insertFileBlock(
  draft: string,
  fileName: string,
  content: string,
  maxChars = COMPOSER_MAX_CHARS,
): FileInsertResult {
  const base = typeof draft === "string" ? draft : ""
  const name = safeFileName(fileName)
  const body = typeof content === "string" ? content : ""
  if (!body.trim()) return { ok: false, reason: "文件只有空白字符，没有可插入的文本" }
  const fence = fenceFor(body)
  const prefix = base ? (base.endsWith("\n") ? "\n" : "\n\n") : ""
  const head = `${fence}${name}\n`
  const tail = `\n${fence}`
  const overhead = base.length + prefix.length + head.length + tail.length
  const room = maxChars - overhead
  if (room <= 1) {
    return { ok: false, reason: `输入框已接近 ${maxChars} 字上限，放不下文件内容，未插入` }
  }
  const truncated = body.length > room
  // 留一个字给截断标记
  const budget = truncated ? room - 1 : room
  const kept = cutAt(body, Math.max(0, budget))
  if (!kept) {
    return { ok: false, reason: `输入框已接近 ${maxChars} 字上限，放不下文件内容，未插入` }
  }
  const marker = truncated ? "…" : ""
  const text = `${base}${prefix}${head}${kept}${marker}${tail}`
  if (text.length > maxChars) {
    // 防御性兜底：上述预算在数学上不会再超，真超了宁可拒绝也不撑爆输入框
    return { ok: false, reason: `输入框已接近 ${maxChars} 字上限，放不下文件内容，未插入` }
  }
  return {
    ok: true,
    text,
    contentChars: body.length,
    insertedChars: kept.length,
    truncated,
    omittedChars: Math.max(0, body.length - kept.length),
  }
}
