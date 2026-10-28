/**
 * 附件展示模型（纯函数，不依赖 React/DOM）。
 *
 * 只消费消息里真实存在的 ImagePart：当前协议没有文件附件、上传进度或删除命令，
 * 所以这里不生成“上传中 / 文件卡 / 下载”等无数据状态。
 */
import { remoteImageRef, type RemoteImageRef } from "./remoteImage.ts"

export type AttachmentImageLike = {
  data?: string
  mimeType?: string
  omitted?: boolean
  bytes?: number
  /** 投影/历史里能真实定位到会话条目时才有；缺一个就不按需补拉。 */
  entryId?: string
  blockIndex?: number
}

export type AttachmentEntry =
  | {
      kind: "image"
      key: string
      src: string
      mimeType: string
      alt: string
      gif: boolean
      bytes?: number
      shotIndex: number
    }
  | {
      kind: "omitted"
      key: string
      note: string
      mimeType: string
      bytes?: number
      /** 可补拉的定位；没有就只显示占位文案。 */
      remote?: RemoteImageRef
      /** 该条目在 Lightbox 里的页码（可补拉的占位也参与翻页）。 */
      shotIndex?: number
    }

export type AttachmentLayout = "single" | "grid" | "hero"

export function formatImageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 保留旧 ImgView 的文案：超限图在本机查看，不拼裂图 data URL。
 *  有真实定位时把“请在本机查看”换成“点击加载原图”的动作（由网格渲染），文案只留体积。 */
export function imageNote(image: AttachmentImageLike): string {
  if (image.omitted) {
    const local = remoteImageRef(image) ? "" : "，请在本机查看"
    return `图片过大未传输${image.bytes ? `（${formatImageBytes(image.bytes)}）` : ""}${local}`
  }
  if (!image.data) return "图片未传输"
  return image.data
}

export function isGifMime(mimeType: string | undefined): boolean {
  return /^image\/gif$/i.test((mimeType || "").trim())
}

function usableImage(image: AttachmentImageLike): boolean {
  if (image.omitted) return false
  if (!image.data) return false
  if (image.data.startsWith("[")) return false
  if (!image.mimeType) return false
  return /^image\//i.test(image.mimeType)
}

/** 1 张单图 / 2–4 两列 / 5+ 首图跨两列；数量按消息里实际条目算。 */
export function attachmentLayout(count: number): AttachmentLayout {
  if (count <= 1) return "single"
  if (count <= 4) return "grid"
  return "hero"
}

export function attachmentEntries(images: readonly AttachmentImageLike[]): AttachmentEntry[] {
  let shotIndex = 0
  return images.map((image, index) => {
    const mimeType = image.mimeType || "application/octet-stream"
    const key = `${index}-${mimeType}-${image.data?.length ?? 0}`
    if (!usableImage(image)) {
      const remote = remoteImageRef(image) ?? undefined
      return {
        kind: "omitted",
        key,
        note: imageNote(image),
        mimeType,
        bytes: image.bytes,
        remote,
        shotIndex: remote ? shotIndex++ : undefined,
      }
    }
    return {
      kind: "image",
      key,
      src: `data:${mimeType};base64,${image.data}`,
      mimeType,
      alt: `图片 ${index + 1}`,
      gif: isGifMime(mimeType),
      bytes: image.bytes,
      shotIndex: shotIndex++,
    }
  })
}

/**
 * Lightbox 的图；真实图直接显示，带定位的 omit 占位也进列表（打开后才按需拉原图）。
 * 不带定位的占位不参与翻页——点不开的空图不应进查看器。
 */
export function lightboxImages(entries: readonly AttachmentEntry[]) {
  return entries.flatMap((entry) => {
    if (entry.kind === "image") {
      return [{ src: entry.src, alt: entry.alt, mimeType: entry.mimeType, gif: entry.gif, bytes: entry.bytes }]
    }
    if (entry.remote) {
      return [
        {
          src: "",
          alt: "待加载的原图",
          mimeType: entry.mimeType,
          gif: false,
          bytes: entry.bytes,
          remote: entry.remote,
        },
      ]
    }
    return []
  })
}

/** 全部条目都是“点不开的占位”时，直接显示原文案，不画一个点不开的空网格。
 *  带定位的可补拉占位仍按网格按钮渲染，因此不算 only-notes。 */
export function attachmentsAreOnlyNotes(entries: readonly AttachmentEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.kind === "omitted" && !entry.remote)
}
