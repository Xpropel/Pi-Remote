/**
 * 文件视图（PaneContainer 的"文件"，design §3.4 file-pane、§7.2；G10）。纯函数，node --test 直接加载。
 * get_file 的回包对照过扩展代码（extension/pi-remote-sync.ts 的 readFileInRoot）：
 *   { name, mimeType, size, encoding: "utf8" | "base64", data, truncated }
 *   - 只读当前会话 cwd 里的普通文件；png / jpeg / gif / webp 走 base64，其余按 UTF-8 文本读；
 *   - 文本超过 5 MB 只回前 5 MB（truncated: true）；二进制、非 UTF-8、目录直接报 unsupported；超过 5 MB 的图片报 payload_too_large。
 * 校验口径同旧界面 conversation/FileViewer.tsx 的 normalizeFilePayload（P7 删旧文件，这里是新界面的那一份）：
 * encoding / data 是硬前提，缺了返回 null（坏包）；size 不合法就当"大小未知"，不补猜。
 */

export type PiFilePayload = {
  name: string
  mimeType: string
  size: number | null
  encoding: "utf8" | "base64"
  data: string
  truncated: boolean
}

/** 扩展的文本读取上限（FILE_MAX_BYTES）：截断时界面写"只显示前 5 MB" */
export const FILE_TEXT_MAX_BYTES = 5 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** get_file 回包 → 契约字段；坏包返回 null */
export function filePayloadOf(value: unknown): PiFilePayload | null {
  if (!isRecord(value) || typeof value.data !== "string") return null
  const encoding = value.encoding === "utf8" || value.encoding === "base64" ? value.encoding : null
  if (!encoding) return null
  const size = typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0 ? Math.trunc(value.size) : null
  return {
    name: typeof value.name === "string" ? value.name : "",
    mimeType: typeof value.mimeType === "string" ? value.mimeType : "",
    size,
    encoding,
    data: value.data,
    truncated: value.truncated === true,
  }
}

/** utf8 一律当文本；base64 只有 image/* 能预览，其余是二进制 */
export function fileKindOf(file: PiFilePayload): "text" | "image" | "binary" {
  if (file.encoding === "utf8") return "text"
  return /^image\//i.test(file.mimeType) ? "image" : "binary"
}

/** 图片的 data URL；不是图片返回 ""（不把文本塞进 img） */
export function fileImageSrcOf(file: PiFilePayload): string {
  return fileKindOf(file) === "image" ? `data:${file.mimeType};base64,${file.data}` : ""
}

const FILE_ERROR_COPY: Record<string, string> = {
  path_required: "先选一个文件",
  not_found: "找不到这个文件：检查路径是否在当前会话目录里",
  file_not_found: "找不到这个文件：检查路径是否在当前会话目录里",
  enoent: "找不到这个文件：检查路径是否在当前会话目录里",
  payload_too_large: "文件超过单次读取上限，请到电脑上打开",
  file_too_large: "文件超过单次读取上限，请到电脑上打开",
  too_large: "文件超过单次读取上限，请到电脑上打开",
  cwd_not_allowed: "这个路径不在当前会话目录里",
  path_not_allowed: "这个路径不在当前会话目录里",
  file_not_allowed: "这个路径不在当前会话目录里",
  is_directory: "这是一个目录，不能预览",
  eisdir: "这是一个目录，不能预览",
  not_ready: "当前会话没有工作目录，读不了文件",
  bad_args: "文件路径不合法",
  unsupported: "这个文件不能预览：只支持 UTF-8 文本和 png / jpeg / gif / webp 图片",
  internal: "读取文件失败，请稍后重试",
  unknown_command: "电脑上的 pi 扩展还没有 get_file，更新扩展后重试",
  unknown_type: "电脑上的 pi 扩展还没有 get_file，更新扩展后重试",
  not_loaded: "这个会话还没载入：先发一条消息载入会话",
  no_room: "先选一个会话",
  room_offline: "这个会话已结束，读不了电脑上的文件",
  device_offline: "设备未连接，读不了文件",
  offline: "连接断开了，重连后再读",
  timeout: "电脑没有回应，请重试",
  result_unknown: "没有收到读取结果，请重试",
  closed: "连接已关闭，重连后再读",
  bad_payload: "返回的文件数据不完整",
}

/** 这些码的服务端原文更具体（权限 / 大小 / 路径），有原文时用原文 */
const SPECIFIC = new Set(["unsupported", "payload_too_large", "bad_args", "internal"])

/** 读取失败 → 一句话：认得的码用固定文案；没有码用错误原文；都没有写"读取失败" */
export function fileErrorTextOf(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : ""
  const message = error instanceof Error ? error.message.trim() : isRecord(error) && typeof error.message === "string" ? error.message.trim() : ""
  if (code && SPECIFIC.has(code) && message) return message
  if (code && FILE_ERROR_COPY[code]) return FILE_ERROR_COPY[code]
  return message || "读取文件失败，请重试"
}
