import { SendIcon } from "./icons"

/** P11-SIDE-04 新会话 pill（34px、圆角 8、padding 0 10、gap 9）。 */
export function NewSessionPill({ label = "新会话", onClick }: { label?: string; onClick?: () => void }) {
  return (
    <button type="button" className="sb-newpill" data-p11-surface="P11-SIDE-04" onClick={onClick}>
      <SendIcon size={16} />
      <span>{label}</span>
    </button>
  )
}
