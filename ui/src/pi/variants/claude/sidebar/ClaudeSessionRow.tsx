import { Ellipsis } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import type { ClaudeListRow } from "../model/view"
import { ClaudeMenu } from "../primitives/ClaudePrimitives"
import { ClaudeSessionMenuItems } from "../overlays/ClaudeSessionDialogs"

/**
 * 会话行（[C-图12③④]）：28/36 双密度、行首状态点 / 问号圈、标题 13px、行尾「等你回答」/ 相对时间、
 * hover 4% 淡染、选中浅陶土底；行尾「…」打开会话菜单（打开 / 重命名 / 删除 —— P9 B 功能锚点）。
 */
export function ClaudeSessionRow({
  p,
  row,
  density,
  onOpen,
}: {
  p: PiContainerProps
  row: ClaudeListRow
  density: "compact" | "comfortable"
  onOpen: () => void
}) {
  return (
    <div className="claude-row" data-row="" data-marker={row.marker} data-dimmed={row.dimmed ? "" : undefined} data-density={density}>
      <button type="button" className="claude-row-main" data-p4-row="" aria-label={row.title} onClick={onOpen}>
        <span aria-hidden className="claude-row-marker" data-marker={row.marker}>
          {row.marker === "waiting" ? "?" : null}
        </span>
        <span className="claude-row-title">{row.title}</span>
        {row.trailingText ? (
          <span className="claude-row-trailing" data-tone={row.trailingTone ?? undefined}>
            {row.trailingText}
          </span>
        ) : row.time ? (
          <span className="claude-row-time">{row.time}</span>
        ) : null}
      </button>
      {row.deviceOnly ? null : (
        <ClaudeMenu
          align="end"
          width={220}
          trigger={
            <button type="button" className="claude-row-more" aria-label={`${row.title} 的会话菜单`}>
              <Ellipsis size={14} strokeWidth={1.75} aria-hidden />
            </button>
          }
        >
          <ClaudeSessionMenuItems p={p} rowId={row.id} />
        </ClaudeMenu>
      )}
    </div>
  )
}
