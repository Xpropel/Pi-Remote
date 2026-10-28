import type { PiPaneDiffRow } from "@/pi/model/changesView"
import { codexFoldDiffRows } from "../model/fold"
import { ChevronRight } from "../icons/CodexIcons"

/** diff 行（[X-图7⑥][X-图10②]：行号列 + ± 标 + 红绿底 + 「N unmodified lines」折叠条） */
export function CodexDiffRows({ rows }: { rows: readonly PiPaneDiffRow[] }) {
  const folded = codexFoldDiffRows(rows)
  return (
    <div className="cx-diff" data-p4-surface="CX-THREAD-04" data-p4-ready="">
      {folded.map((row, index) =>
        row.kind === "fold" ? (
          <div className="cx-diff-fold" key={`fold-${index}`}>
            <span>{row.count} 行未改动</span>
          </div>
        ) : (
          <div className="cx-diff-row" data-kind={row.kind} key={index}>
            <span className="cx-diff-n">{row.n ?? ""}</span>
            <span className="cx-diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
            <span className="cx-diff-code">{row.text || " "}</span>
          </div>
        ),
      )}
    </div>
  )
}

/** 可折叠的 diff 卡（标题行由工具行给，这里只负责展开态） */
export function CodexDiffCard({ rows, open }: { rows: readonly PiPaneDiffRow[]; open: boolean }) {
  if (!open) return null
  return <CodexDiffRows rows={rows} />
}

/** 视图里用的折叠 caret */
export function CodexCaret({ open }: { open: boolean }) {
  return <ChevronRight aria-hidden size={12} strokeWidth={2} className="cx-fold-caret" data-open={open ? "" : undefined} />
}
