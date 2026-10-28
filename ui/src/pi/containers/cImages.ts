import {
  MAX_PENDING_IMAGES,
  MIN_IMAGE_BUDGET_CHARS,
  SEND_IMAGE_MAX_CHARS,
  SEND_IMAGE_TOTAL_MAX_CHARS,
  imageBudgetFor,
  imageCharsTotal,
  remainingImageSlots,
} from "@/chat/composerTools"
import { normalizeSendImageMime, type SendImage } from "@/relay/transcript"
import type { Relay } from "./types"

/*
 * + 菜单"图片…"的导入流水线（P5 c 线）。口径照 chat/toolbar.tsx 的 importImageFiles（同样的压缩阶梯、单张 / 合计额度、拒绝原因），
 * 不直接 import 它：toolbar.tsx 带着旧界面的全局样式表（style/composer.css，里面有全站 kbd 规则），一进新界面就把 kit 键帽的底色盖掉了
 * （P5 c 线 L1 实测：c/command-palette 的键帽）。lane-requests/p5-c.md 第 2 条请把这段搬进一个不带样式的模块，两边共用一份。
 * 只用浏览器 API（FileReader、createImageBitmap、canvas），不进 node 测试。
 */

/** 文件选择器给出的类型。空类型或 octet-stream 时按扩展名认 png / jpeg / gif / webp。 */
function imageSendMime(file: File): string | null {
  const fromType = normalizeSendImageMime(file.type)
  if (fromType) return fromType
  if (file.type && file.type !== "application/octet-stream") return null
  const name = file.name.toLowerCase()
  if (name.endsWith(".png")) return "image/png"
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg"
  if (name.endsWith(".gif")) return "image/gif"
  if (name.endsWith(".webp")) return "image/webp"
  return null
}

function formatChars(chars: number) {
  return `${Math.max(1, Math.round(chars / 1024))}K 字符`
}

/** 压缩时的长边阶梯与质量阶梯：先保尺寸，仍超限再降质量，最后才继续缩小。 */
const IMAGE_EDGE_STEPS = [1568, 1280, 1024, 896, 768, 640, 512, 384, 256, 192, 128, 96, 64]
const IMAGE_QUALITIES = [0.85, 0.72, 0.6]

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(file)
  })
}

type Drawable = { source: CanvasImageSource; width: number; height: number; close: () => void }

async function loadDrawable(file: File): Promise<Drawable | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // 解码失败时走 <img> 兜底
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = "async"
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("decode failed"))
    })
    image.src = url
    await loaded
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("empty image")
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

/** 把图缩 / 转成 JPEG，直到 base64 ≤ targetChars；画布先铺白底，透明 PNG 不会变黑块。 */
async function compressImageFile(file: File, targetChars: number): Promise<{ ok: true; data: string; mimeType: string } | { ok: false; reason: "decode" | "size" }> {
  const drawable = await loadDrawable(file)
  if (!drawable) return { ok: false, reason: "decode" }
  try {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    if (!context) return { ok: false, reason: "decode" }
    const longEdge = Math.max(drawable.width, drawable.height)
    const edges = [...new Set(IMAGE_EDGE_STEPS.map((edge) => Math.min(edge, longEdge)))]
    for (const edge of edges) {
      const scale = edge / longEdge
      const width = Math.max(1, Math.round(drawable.width * scale))
      const height = Math.max(1, Math.round(drawable.height * scale))
      canvas.width = width
      canvas.height = height
      context.fillStyle = "#ffffff"
      context.fillRect(0, 0, width, height)
      context.drawImage(drawable.source, 0, 0, width, height)
      for (const quality of IMAGE_QUALITIES) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality)
        const comma = dataUrl.indexOf(",")
        const data = comma >= 0 ? dataUrl.slice(comma + 1) : ""
        if (data && data.length <= targetChars) return { ok: true, data, mimeType: "image/jpeg" }
      }
      // 每次编码都是同步的：让出一拍，连着处理 5 张时输入框不会卡死
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0)
      })
    }
    return { ok: false, reason: "size" }
  } finally {
    drawable.close()
  }
}

async function prepareImageForBudget(file: File, budgetChars: number): Promise<{ ok: true; image: SendImage; note?: string } | { ok: false; reason: string }> {
  const mimeType = imageSendMime(file)
  if (!mimeType) return { ok: false, reason: "只接受 png / jpeg / gif / webp" }
  if (budgetChars < MIN_IMAGE_BUDGET_CHARS) return { ok: false, reason: `图片合计额度不足（需 ≥${formatChars(MIN_IMAGE_BUDGET_CHARS)}）` }
  const target = Math.min(budgetChars, SEND_IMAGE_MAX_CHARS)
  let raw: string
  try {
    raw = await readFileDataUrl(file)
  } catch {
    return { ok: false, reason: "文件读不出来" }
  }
  const comma = raw.indexOf(",")
  const data = comma >= 0 ? raw.slice(comma + 1) : ""
  if (!data) return { ok: false, reason: "读不出来" }
  if (data.length <= target && data.length <= SEND_IMAGE_MAX_CHARS) return { ok: true, image: { data, mimeType } }
  const compressed = await compressImageFile(file, target)
  if (!compressed.ok) {
    return { ok: false, reason: compressed.reason === "decode" ? "这张图无法解码（格式不受支持），未添加" : `压缩后仍超过 ${formatChars(target)}，未添加` }
  }
  const name = file.name || "图片"
  const note = mimeType === "image/gif" ? `${name} 超过上限，已转成静态 JPEG` : mimeType === "image/png" ? `${name} 已压缩成 JPEG（透明区域填白）` : `${name} 已压缩`
  return { ok: true, image: { data: compressed.data, mimeType: compressed.mimeType }, note }
}

/**
 * 多图入口：单张图压缩失败只记一条拒绝原因，其他图照常保留（绝不整条连坐）。被拒 / 压缩的说明走 relay.notify（warning 通知卡）。
 */
export async function importImageFiles(relay: Pick<Relay, "composer" | "pendingImages" | "addPendingImages" | "notify">, files: readonly File[]): Promise<void> {
  if (!files.length) return
  if (!relay.composer.canType) {
    relay.notify("当前会话不能添加图片", "warn")
    return
  }
  const current = relay.pendingImages ?? []
  const slots = remainingImageSlots(current.length)
  if (!slots) {
    relay.notify(`输入条最多同时挂 ${MAX_PENDING_IMAGES} 张图片，请先移除一张再添加`, "warn")
    return
  }
  const acceptedFiles = files.slice(0, slots)
  const overflow = files.length - acceptedFiles.length
  const rejected: string[] = []
  const notes: string[] = []
  let total = imageCharsTotal(current)
  for (let index = 0; index < acceptedFiles.length; index += 1) {
    const file = acceptedFiles[index]!
    const budget = imageBudgetFor(total, acceptedFiles.length - index)
    if (budget < MIN_IMAGE_BUDGET_CHARS) {
      rejected.push(`图片合计超过 ${formatChars(SEND_IMAGE_TOTAL_MAX_CHARS)}，剩余额度不足`)
      break
    }
    const prepared = await prepareImageForBudget(file, budget)
    if (!prepared.ok) {
      rejected.push(`${file.name || "图片"}：${prepared.reason}`)
      continue
    }
    if (relay.addPendingImages([prepared.image]) !== 1) {
      rejected.push(`图片合计超过 ${formatChars(SEND_IMAGE_TOTAL_MAX_CHARS)}，${file.name || "图片"} 未添加`)
      break
    }
    total += prepared.image.data.length
    if (prepared.note) notes.push(prepared.note)
  }
  if (overflow > 0) rejected.push(`最多 ${MAX_PENDING_IMAGES} 张，另有 ${overflow} 张未添加`)
  if (!notes.length && !rejected.length) return
  const parts: string[] = []
  if (notes.length) parts.push(notes.slice(0, 2).join("；"))
  if (rejected.length) parts.push(`未添加：${rejected.slice(0, 2).join("；")}${rejected.length > 2 ? `；另有 ${rejected.length - 2} 项` : ""}`)
  relay.notify(parts.join("；"), rejected.length ? "bad" : "warn")
}
