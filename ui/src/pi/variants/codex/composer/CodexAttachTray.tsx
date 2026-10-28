import { ImageIcon } from "../icons/CodexIcons"

/** `+` 菜单（[X-§4]：附件 / 插件提及；v2 首版只接图片与文本文件，芯片/插件提及留待后续） */
export function CodexAttachTray({ onImage, onText }: { onImage: () => void; onText: () => void }) {
  return (
    <div className="cx-composer-pop cx-composer-pop-attach" role="menu" aria-label="添加">
      <button type="button" role="menuitem" className="cx-pop-row" onClick={onImage}>
        <ImageIcon aria-hidden size={14} strokeWidth={1.5} />
        <span className="cx-pop-row-main">图片…</span>
        <span className="cx-pop-row-desc">png / jpeg / gif / webp，最多 5 张</span>
      </button>
      <button type="button" role="menuitem" className="cx-pop-row" onClick={onText}>
        <span className="cx-pop-row-main">文本文件…</span>
        <span className="cx-pop-row-desc">64 KB 以内的 UTF-8 文本，插进输入框</span>
      </button>
    </div>
  )
}
