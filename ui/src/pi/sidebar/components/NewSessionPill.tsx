import { SendIcon } from "./icons"

/** P11-SIDE-04 新会话行（32px、圆角 8、padding 0 10、gap 9）；悬停 / 聚焦时行尾露出快捷键。 */
export function NewSessionPill({ label = "新会话", shortcut, onClick }: { label?: string; shortcut?: string; onClick?: () => void }) {
  return (
    <button type="button" className="sb-newpill" data-p11-surface="P11-SIDE-04" onClick={onClick}>
      <SendIcon />
      <span className="sb-newpill-label">{label}</span>
      {shortcut ? <kbd className="sb-kbd sb-newpill-kbd" aria-hidden>{shortcut}</kbd> : null}
    </button>
  )
}
