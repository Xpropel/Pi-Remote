import { MenuSearch } from "@/components/kit"
import { PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiSegments } from "./PiDisplayOptions"
import { PiDialogError, PiDialogListRow, PiDialogNote, PiDialogStatus, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"
import { C_SECONDARY } from "./styles"

/** 树的一个节点（chat/treeFlatten.ts 的 FlatNode 里界面要用的字段） */
export interface PiTreeNode {
  id: string
  label: string
  depth: number
  /** 当前叶（加粗、行尾"当前叶"） */
  current: boolean
}

export interface PiTreeDialogProps extends PiFamilyDialogProps {
  /** 已按筛选 / 搜索过滤好的节点 */
  nodes?: PiTreeNode[]
  /** 树本身是空的（不是过滤后为空） */
  treeEmpty?: boolean
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
  /** 跳转方式：直接跳转 / 跳转并总结（navigate_tree 的 summarize） */
  jumpMode?: "direct" | "summarize"
  onJumpModeChange?: (mode: "direct" | "summarize") => void
  /** 筛选（treeFlatten 的五种） */
  filter?: string
  filterOptions?: readonly { value: string; label: string }[]
  onFilterChange?: (value: string) => void
  query?: string
  onQueryChange?: (value: string) => void
  /** 正在跳的节点 */
  pendingId?: string | null
  error?: string | null
  onJump?: (id: string) => void
}

const JUMP_OPTIONS = [
  { value: "direct", label: "直接跳转" },
  { value: "summarize", label: "跳转并总结" },
]

/**
 * 会话树（G10，design §2 H：PiDialog + compose from kit: MenuSearch；缩进参照 ch5/TaskGroup；当前路径加粗，推断）。
 * 桌面 PiDialog 560；手机全高 sheet（搜索框遇到键盘时 sheet 按 sheetLayout 摆，P6.3）。
 * 顶部：跳转方式（分段）→ 筛选（分段）→ 搜索；下面是缩进的节点行，点一行 = navigate_tree。
 */
export function PiTreeDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  nodes = [],
  treeEmpty,
  phase = "ready",
  loadError,
  onRetry,
  jumpMode = "direct",
  onJumpModeChange,
  filter = "default",
  filterOptions = [],
  onFilterChange,
  query = "",
  onQueryChange,
  pendingId,
  error,
  onJump,
}: PiTreeDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const ready = phase === "ready" && !treeEmpty
  return (
    <PiDialog
      title="会话树"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-tree-dialog" className="flex flex-col gap-3 pt-1">
        {ready && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className={cn("text-(length:--cw-text-sm)", C_SECONDARY)}>跳转方式</span>
              <PiSegments
                variant={v}
                label="跳转方式"
                options={JUMP_OPTIONS}
                value={jumpMode}
                className={phone ? "w-full" : "w-[240px]"}
                onValueChange={isStatic ? undefined : (value) => onJumpModeChange?.(value as "direct" | "summarize")}
              />
              {jumpMode === "summarize" && <PiDialogNote variant={v}>会先让模型总结要离开的分支，可能要几十秒；总结失败时不会跳转。</PiDialogNote>}
            </div>
            <PiSegments
              variant={v}
              label="会话树筛选"
              options={[...filterOptions]}
              value={filter}
              className="w-full"
              onValueChange={isStatic ? undefined : onFilterChange}
            />
            <div className="rounded-(--cw-radius-card) border border-solid border-(--cw-border)">
              <MenuSearch
                placeholder="搜索书签、预览、类型、角色或 id"
                aria-label="搜索会话树"
                value={query}
                readOnly={isStatic}
                onValueChange={isStatic ? undefined : onQueryChange}
                // 手机：输入框 44 高、16px（防 iOS 聚焦放大，§4.2 第 8 条）
                className={phone ? "h-11 text-[16px]" : undefined}
              />
            </div>
          </>
        )}
        <PiDialogStatus
          variant={v}
          phase={phase}
          error={loadError}
          onRetry={onRetry}
          empty={phase === "ready" && nodes.length === 0 ? (treeEmpty ? "这条会话还没有可跳的节点" : "没有匹配的节点") : null}
        >
          <div role="list" aria-label="会话树节点" className="-mx-2 flex flex-col">
            {nodes.map((n) => (
              <div role="listitem" key={`${n.id}-${n.depth}`}>
                <PiDialogListRow
                  variant={v}
                  title={n.label}
                  subtitle={n.id}
                  indent={n.depth}
                  current={n.current}
                  mark={pendingId === n.id ? (jumpMode === "summarize" ? "总结并跳转…" : "跳转中…") : n.current ? "当前叶" : undefined}
                  disabled={!!pendingId}
                  onClick={isStatic ? undefined : () => onJump?.(n.id)}
                />
              </div>
            ))}
          </div>
        </PiDialogStatus>
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
