import type { ImagePart } from "@/relay/transcript"
import { ImageIcon } from "../icons/CodexIcons"
import { piBytes } from "../logic/view"

/** 图片/占位（[X-图7] 同族；推导：10 圆角 + 灯箱交给 CodexLightbox） */
export function CodexImagePart({ image, height = 160, onOpen }: { image: ImagePart; height?: number; onOpen?: () => void }) {
  const raw = image as ImagePart & { data?: string; src?: string }
  const src = raw.data ?? raw.src
  const url = src ? (src.startsWith("data:") ? src : `data:${image.mimeType ?? "image/png"};base64,${src}`) : null
  if (url) {
    return (
      <button type="button" className="cx-image-open" onClick={onOpen} aria-label="查看图片">
        <img className="cx-image" src={url} alt="图片" style={{ height }} />
      </button>
    )
  }
  if (image.omitted) {
    return (
      <div className="cx-image-omitted">
        <ImageIcon aria-hidden size={15} strokeWidth={1.5} />
        <span>图片过大未传输{image.bytes != null ? `（${piBytes(image.bytes)}）` : ""}</span>
      </div>
    )
  }
  return (
    <div className="cx-image" aria-label="图片占位" style={{ height, width: Math.round(height * 1.6) }}>
      <span className="cx-image-ph">图片</span>
    </div>
  )
}
