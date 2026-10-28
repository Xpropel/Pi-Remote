import type { PiPaneDiffRow } from "@/pi/model/changesView"

export type CodexFoldedRow = PiPaneDiffRow

/** changesView 给出的行已经是「行 + 未改动折叠条」，这里只做透传（渲染在 CodexDiffCard） */
export function codexFoldDiffRows(rows: readonly PiPaneDiffRow[]): CodexFoldedRow[] {
  return [...rows]
}
