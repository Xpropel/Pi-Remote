import { useEffect } from "react"
import { X } from "../icons/CodexIcons"

/** 图片灯箱（推导；[X-图7] 同族）：全屏遮罩 + 居中图 + Esc/点背景关闭（渲染在变体根内部，不 portal 到 body） */
export function CodexLightbox({ image, onClose }: { image: { src: string; alt?: string } | null; onClose: () => void }) {
  useEffect(() => {
    if (!image) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [image, onClose])
  if (!image) return null
  return (
    <div className="cx-lightbox" role="dialog" aria-modal="true" aria-label="图片" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <button type="button" className="cx-icon-btn cx-lightbox-close" onClick={onClose} aria-label="关闭图片">
        <X aria-hidden size={18} strokeWidth={1.5} />
      </button>
      <img src={image.src} alt={image.alt ?? "原图"} className="cx-lightbox-img" />
    </div>
  )
}
