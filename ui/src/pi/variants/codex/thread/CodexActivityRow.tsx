import { memo, useState } from "react"
import { ChevronRight } from "../icons/CodexIcons"

/** 思考 / Worked for 折叠行（[X-§3]：默认收起成 12px 一行，点开看过程） */
export const CodexActivityRow = memo(function CodexActivityRow({ kind, label, detail }: { kind: "thought" | "worked"; label: string; detail?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="cx-fold-row" data-kind={kind} data-pi-ui-part="thread">
      <button type="button" className="cx-fold-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight aria-hidden size={12} strokeWidth={2} className="cx-fold-caret" />
        <span className="cx-fold-label" data-tone={kind}>
          {kind === "thought" ? "✦ " : ""}
          {label}
        </span>
      </button>
      {open && detail ? <div className="cx-fold-body">{detail}</div> : null}
    </div>
  )
})

export function CodexWorkedRow({ text }: { text: string | null }) {
  if (!text) return null
  return <div className="cx-worked" data-p4-surface="CX-THREAD-02" data-p4-ready="" data-pi-ui-part="thread">{text}</div>
}
