import { ChangesSummaryRow, DiffFileRow, DiffFileSection, DiffStat, type DiffRow } from "@/components/kit"
import { cn } from "@/lib/utils"
import { langOf } from "./PiDiffCard"
import { T_ERROR, T_SECONDARY, TOUCH_44_CHILD_BUTTON } from "./styles"

export interface PiChangedFile {
  path: string
  added: number
  removed: number
  isNew: boolean
  /** 本会话里编辑了几次 */
  edits: number
  rows: DiffRow[]
  /** 最后一次编辑没生效（工具 output-error） */
  failed?: boolean
  /** P5.4（G5）：有一次编辑的 patch 超过 200k 字被截断，计数只是下限 */
  truncated?: boolean
}

export interface PiChangesPaneProps {
  files: readonly PiChangedFile[]
  total: { added: number; removed: number }
  variant: "desktop" | "phone"
  /** 展开的文件（默认第一个） */
  openPaths?: readonly string[]
  className?: string
}

/**
 * 手机：diff 行软换行（kit UnifiedDiff wrap），续行留在代码列里；行号栏收窄（推断）。
 * 手机按字符断行（break-all，冻结版的折行），kit wrap 默认是 overflow-wrap:anywhere（先在空格处断）
 */
const PHONE_DIFF = {
  wrap: true,
  className: "[&_[data-slot=diff-code]]:break-all",
  style: {
    ["--cw-diff-gutter-w" as string]: "36px",
    ["--cw-diff-lineno-pad" as string]: "8px",
    ["--cw-diff-code-pad" as string]: "8px",
  },
}

/** 桌面：pane 只有 460 宽，长行软换行（续行留在代码列里，与手机一致），不再被代码列硬切（B1）。行号栏照 Cursor */
const DESKTOP_DIFF = { wrap: true }
/** 未改动折叠条的"30 行未改动"是要读的灰字：底是 --cw-diff-unmodified-bg（浅 #EAEAEA），secondary 只有 4.43，用 --cw-text-2（R2-B-02） */
/** kit 图标钮的中文名（原先由 kitLabels.ts 在 DOM 上替换英文 aria-label） */
const ROW_LABELS = { toggle: "改动文件列表" }
const FILE_LABELS = { open: "打开文件", copy: "复制路径" }
const UNMODIFIED_SECONDARY = "[&_[data-slot=unmodified-lines-bar]]:text-(--cw-text-2)"
/**
 * 改动视图（PiChangesPane；compose from kit: DiffStat, ChangesSummaryRow, DiffFileRow, DiffFileSection, UnifiedDiff, UnmodifiedLinesBar）。
 * Cursor diffs view 的同一语法（规则 7）：三级统计 → 文件行 → 单列 unified diff（一列行号）+ 未改动折叠条。
 * 数据来自本会话的 edit / write 记录，不是 git 状态；所以没有勾选框、撤销、Commit & Push（§8）。
 */
export function PiChangesPane({ files, total, variant, openPaths, className }: PiChangesPaneProps) {
  const phone = variant === "phone"
  const open = new Set(openPaths ?? (files[0] ? [files[0].path] : []))
  if (files.length === 0) {
    // 没有改动（design changes-pane states）：本会话还没有成功的 edit / write
    return (
      <div data-pi-part="changes-pane" data-empty="" className={cn("flex min-h-0 flex-1 flex-col items-center justify-center px-6", className)}>
        <div className="text-(length:--cw-text-md) text-(--cw-text-2)">这个会话还没有编辑文件</div>
        <div className={cn("mt-1 text-(length:--cw-text-sm) leading-(--cw-leading-sm)", T_SECONDARY)}>改动视图根据本会话的编辑记录，不是 git 状态</div>
      </div>
    )
  }
  return (
    <div data-pi-part="changes-pane" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className={cn("shrink-0", phone ? "px-4 pt-3 pb-2" : "px-3.5 pt-3 pb-2.5")}>
        <DiffStat
          added={total.added}
          removed={total.removed}
          className={cn("font-(--cw-weight-semibold)", phone ? "text-[17px]" : "text-(length:--cw-text-lg)")}
        />
        <div className={cn("mt-1 text-(length:--cw-text-sm) leading-(--cw-leading-sm)", T_SECONDARY)}>
          根据本会话的编辑记录，不是 git 状态
        </div>
      </div>
      <ChangesSummaryRow
        variant="uncommitted"
        label={`${files.length} 个文件改动`}
        added={total.added}
        removed={total.removed}
        revert={false}
        checkbox={false}
        // kit 图标钮的中文名（§4.7 D-04；kit-requests pi b6）
        labels={ROW_LABELS}
        // 手机：Toggle changes 视觉 12，点击区 44×44（§4.4；B3）
        className={cn("shrink-0 border-t border-(--cw-divider)", phone ? cn("h-11 pr-4 pl-4", TOUCH_44_CHILD_BUTTON) : "pr-3.5")}
      />
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]",
          UNMODIFIED_SECONDARY,
          phone ? "space-y-2 px-3 py-3" : "space-y-2 p-3",
        )}
      >
        {files.map((f) =>
          open.has(f.path) ? (
            <DiffFileSection
              key={f.path}
              path={f.path}
              added={f.added}
              removed={f.removed > 0 ? f.removed : undefined}
              isNew={f.isNew}
              rows={f.rows}
              lang={langOf(f.path)}
              revert={false}
              checkbox={false}
              defaultOpen
              labels={FILE_LABELS}
              // 手机：文件行高 44，Open file ↗ 视觉 16、点击区 44×44（B3）
              headerClassName={phone ? cn("h-11", TOUCH_44_CHILD_BUTTON) : undefined}
              diffProps={phone ? PHONE_DIFF : DESKTOP_DIFF}
            />
          ) : (
            <DiffFileRow
              key={f.path}
              path={f.path}
              added={f.added}
              removed={f.removed > 0 ? f.removed : undefined}
              isNew={f.isNew}
              revert={false}
              checkbox={false}
              labels={FILE_LABELS}
              className={phone ? cn("h-11", TOUCH_44_CHILD_BUTTON) : undefined}
            />
          ),
        )}
        {files.some((f) => f.failed) && (
          <div className={cn("px-1 text-(length:--cw-text-sm)", T_ERROR)}>有编辑未生效，以文件当前内容为准</div>
        )}
        {files.some((f) => f.truncated) && (
          <div data-pi-part="changes-truncated" className={cn("px-1 text-(length:--cw-text-sm)", T_SECONDARY)}>
            有的改动太长（超过 200k 字），只显示了前面一段，计数比实际少
          </div>
        )}
      </div>
    </div>
  )
}
