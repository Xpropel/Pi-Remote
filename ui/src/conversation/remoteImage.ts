/**
 * 按需补拉被 omit 的图片（纯逻辑，不依赖 React/DOM）。
 *
 * 定位只认扩展投影写出的 entryId + blockIndex：两者都必须是真实值，缺一个就返回 null，
 * 不发命令、不按消息文本或图片体积猜位置。get_image 的后端口径是
 * {entryId, blockIndex}，blockIndex 是条目原始 content 的下标。
 */
import { imageAddressOf } from "../relay/transcript.ts"

export type RemoteImageRef = { entryId: string; blockIndex: number }

export type RemoteImageLookup = {
  entryId?: unknown
  blockIndex?: unknown
}

/** 图片块/ImagePart 是否带完整定位。 */
export function remoteImageRef(image: RemoteImageLookup | null | undefined): RemoteImageRef | null {
  return imageAddressOf(image)
}

export type RemoteImagePhase = "idle" | "loading" | "ready" | "compressed" | "error"

/** 一次按需加载的可展示状态。ready 的 src 是 data URL；compressed 永远没有 src（不伪造原图）。 */
export type RemoteImageState = {
  phase: RemoteImagePhase
  src?: string
  mimeType?: string
  bytes?: number
  error?: string
}

export const REMOTE_IMAGE_LOAD = "点击加载原图"
export const REMOTE_IMAGE_LOADING = "正在加载原图…"
export const REMOTE_IMAGE_RETRY = "重试"

export function formatRemoteImageBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return ""
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 超限压缩占位说明：明确说“无法加载”，不把空数据包装成图片。 */
export function compressedImageText(bytes?: number): string {
  const size = formatRemoteImageBytes(bytes)
  return `原图${size ? `（${size}）` : ""}超过网页端单帧上限，无法加载；请在本机查看`
}

export function dataUrlFor(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`
}

function isImageMime(value: unknown): value is string {
  return typeof value === "string" && /^image\/[a-z0-9.+-]+$/i.test(value)
}

function payloadBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** get_image 成功回包 → 展示状态。compressed/空 data 一律走“无法加载”，绝不拼 data URL。 */
export function imagePayloadState(payload: unknown): RemoteImageState {
  if (!payload || typeof payload !== "object") return { phase: "error", error: "原图回包不是有效数据" }
  const record = payload as Record<string, unknown>
  const mimeType = isImageMime(record.mimeType) ? record.mimeType : undefined
  const bytes = payloadBytes(record.bytes)
  if (record.compressed === true) {
    return { phase: "compressed", mimeType, bytes, error: compressedImageText(bytes) }
  }
  if (record.omitted === true) {
    // 后端标了 omitted 但没标 compressed：同样没有原图数据，给出中性说明，不伪造。
    return { phase: "error", error: "原图没有随回包返回；请在本机查看" }
  }
  if (typeof record.data === "string" && record.data.length > 0 && mimeType) {
    return { phase: "ready", src: dataUrlFor(mimeType, record.data), mimeType, bytes }
  }
  return { phase: "error", error: "原图数据为空或格式不对" }
}

const IMAGE_ERROR_COPY: Record<string, string> = {
  payload_too_large: "原图超过网页端单帧上限，无法加载；请在本机查看",
  too_large: "原图超过网页端单帧上限，无法加载；请在本机查看",
  not_found: "本机会话里找不到这张原图了（可能已被压缩或清理）",
  bad_args: "图片定位信息无效，无法加载",
  bad_payload: "原图数据不完整，无法显示",
  device_offline: "设备未连接：原图暂时无法加载",
  offline: "连接已断开：重连后再加载原图",
  no_room: "先选择一个会话，再加载原图",
  room_offline: "这个会话已结束，原图暂时无法加载",
  not_loaded: "这个会话还没载入：先发送一条消息载入会话",
  unknown_command: "当前后台版本不支持按需加载原图，请更新扩展",
  unknown_type: "当前后台版本不支持按需加载原图，请更新扩展",
  unsupported: "当前后台版本不支持按需加载原图，请更新扩展",
  timeout: "加载原图超时，请重试",
  result_unknown: "没有收到原图回包，命令可能仍在执行：请重试",
  closed: "连接已关闭：重连后再加载原图",
  internal: "本机读取原图失败，请稍后重试",
}

function errorCodeOf(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return ""
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : ""
}

/** 加载失败 → 可读文案。known code 用固定文案；未知错误优先用错误自带 message。 */
export function imageLoadErrorText(error: unknown): string {
  const code = errorCodeOf(error)
  const message = error instanceof Error ? error.message.trim() : ""
  if (code && IMAGE_ERROR_COPY[code]) return IMAGE_ERROR_COPY[code]
  if (message) return message
  return "加载原图失败，请重试"
}

export type RemoteImageLoader = (ref: RemoteImageRef) => Promise<unknown>

let activeLoader: RemoteImageLoader | null = null

/** 由 useRelay 注册当前会话的 get_image 通道；返回注销函数，卸载后不再指向旧 relay。 */
export function setRemoteImageLoader(loader: RemoteImageLoader | null): () => void {
  if (!loader) {
    activeLoader = null
    return () => {}
  }
  activeLoader = loader
  return () => {
    if (activeLoader === loader) activeLoader = null
  }
}

export function getRemoteImageLoader(): RemoteImageLoader | null {
  return activeLoader
}

/** 执行一次按需加载。永不 reject：失败折成 error 态，Lightbox 只负责显示。 */
export async function loadRemoteImage(
  ref: RemoteImageRef,
  loader: RemoteImageLoader | null = activeLoader,
): Promise<RemoteImageState> {
  if (!loader) return { phase: "error", error: "还没有连上会话，原图暂时无法加载" }
  try {
    const payload = await loader(ref)
    return imagePayloadState(payload)
  } catch (error) {
    return { phase: "error", error: imageLoadErrorText(error) }
  }
}

/** get_image 命令参数：显式只带 entryId/blockIndex，不夹带其他字段。 */
export function remoteImageCommandArgs(ref: RemoteImageRef): { entryId: string; blockIndex: number } {
  return { entryId: ref.entryId, blockIndex: ref.blockIndex }
}
