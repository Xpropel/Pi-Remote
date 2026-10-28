import { FileTypeIcon, GhostIconButton, PaneTabBar, TextSelector, type FileKind, type PaneTab } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { GitCompareArrows, SquareTerminal, X } from "@/components/kit/icons"
import { cn } from "@/lib/utils"

export type PiPaneKind = "terminal" | "changes" | "file"

export interface PiPaneTabsProps {
  active: PiPaneKind
  /** 改动页签上的统计（本会话编辑记录合计） */
  changes?: { added: number; removed: number }
  /** 有命令在跑：终端页签带半圆 spinner */
  terminalRunning?: boolean
  /** 打开着的文件：文件页签 = 文件图标 + 截断的文件名；没打开就写"文件" */
  file?: { name: string; kind: FileKind }
  /** 可交互（P4）：点页签切换视图（§1.8：一次只开一个视图）；不传 = 页签只切高亮（静态画廊） */
  onSelect?: (kind: PiPaneKind) => void
  /** 可交互（P4）：右端 ×「关闭面板」 */
  onClose?: () => void
  className?: string
}

const PANE_LABEL: Record<PiPaneKind, string> = { terminal: "终端", changes: "改动", file: "文件" }

/**
 * 右 pane 顶部的视图页签（PiPaneTabs；kit PaneTabBar）：终端 / 改动 +N −M / 文件 + 右端 ×（§1.8：一次只开一个视图）。
 * 高度与主区顶栏对齐（--cw-pi-topbar-h 44）。
 */
export function PiPaneTabs({ active, changes, terminalRunning, file, onSelect, onClose, className }: PiPaneTabsProps) {
  const tabs: PaneTab[] = [
    {
      id: "terminal",
      icon: SquareTerminal,
      label: "终端",
      suffix: terminalRunning ? <PiSpinner size={11} tone="muted" arc={0.5} label="有命令在运行" /> : undefined,
      cwId: "pi-pane-tab-terminal",
    },
    {
      id: "changes",
      icon: GitCompareArrows,
      label: "改动",
      stat: changes && (changes.added > 0 || changes.removed > 0) ? { added: changes.added, removed: changes.removed } : undefined,
      cwId: "pi-pane-tab-changes",
    },
    {
      id: "file",
      // 文件类型图标（kit-requests pi b5：PaneTab.iconNode）；颜色照 kit 页签图标：选中 --cw-text-2，否则 --cw-icon-fg。
      // 带字母的类型徽标（"TS""JSON"，9px 粗体字）没选中时也用 --cw-text-2：--cw-icon-fg 在 pane 底上只有 4.18（P4 ui-a11y），
      // 字要 4.5；通用文件图标（没打开文件时的"文件"页签）照旧
      iconNode: (
        <FileTypeIcon
          kind={file?.kind ?? "file"}
          className={cn("size-3.5", active === "file" || (file != null && file.kind !== "file") ? "text-(--cw-text-2)" : "text-(--cw-icon-fg)")}
        />
      ),
      label: file?.name ?? "文件",
      labelMaxWidth: 150,
      title: file?.name,
      cwId: "pi-pane-tab-file",
    },
  ]
  return (
    <PaneTabBar
      data-pi-part="pane-tabs"
      tabs={tabs}
      selectedId={active}
      onSelectedIdChange={onSelect ? (id) => onSelect(id as PiPaneKind) : undefined}
      className={cn("h-(--cw-pi-topbar-h) bg-(--cw-surface-pane) pl-2", className)}
      actions={<GhostIconButton label="关闭面板" icon={<X />} onClick={onClose} />}
    />
  )
}

/** 手机推入页的页名：可切换的"改动 ∨"（TextSelector，不画框） */
export function PiPaneTitle({ active }: { active: PiPaneKind }) {
  return (
    <TextSelector
      data-pi-part="pane-title"
      label={PANE_LABEL[active]}
      tone="primary"
      size="lg"
      // 视觉 17/22 不变；按钮本身高 44（顶栏里的 truncate 槽会裁掉 ::after，所以不靠外扩）、左右各外扩 8（§4.4 文字选择器；B3）
      className="relative h-11 text-[17px] leading-[22px] font-semibold text-(--cw-text) after:absolute after:-inset-x-2 after:inset-y-0 after:content-[''] [&>svg]:size-4"
    />
  )
}
