import { FileTypeIcon, GhostIconButton, MenuItem, MenuSurface, PaneTabBar, TextSelector, type FileKind, type PaneTab } from "@/components/kit"
import { PiMenu, usePiMenuSurface, usePiStatic } from "@/components/pi/shared"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { ChevronsLeft, Diff, File, GitCompareArrows, SquareTerminal, Terminal, X } from "@/components/kit/icons"
import { cn } from "@/lib/utils"

export type PiPaneKind = "terminal" | "shell" | "changes" | "file"

export interface PiPaneTabsProps {
  active: PiPaneKind
  /** 改动页签上的统计（本会话编辑记录合计） */
  changes?: { added: number; removed: number }
  /** 有命令在跑：终端页签带半圆 spinner */
  terminalRunning?: boolean
  /** 显示交互 Shell 页签（产品运行时开；静态画廊默认不加） */
  showShell?: boolean
  /** 打开着的文件：文件页签 = 文件图标 + 截断的文件名；没打开就写"文件" */
  file?: { name: string; kind: FileKind }
  /** 可交互（P4）：点页签切换视图（§1.8：一次只开一个视图）；不传 = 页签只切高亮（静态画廊） */
  onSelect?: (kind: PiPaneKind) => void
  /** 可交互（P4）：右端 ×「关闭面板」 */
  onClose?: () => void
  className?: string
}

const PANE_LABEL: Record<PiPaneKind, string> = { terminal: "终端", shell: "Shell", changes: "改动", file: "文件" }

/**
 * 右 pane 顶部的视图页签（PiPaneTabs；kit PaneTabBar）：终端 / Shell / 改动 +N −M / 文件 + 右端 ×（§1.8：一次只开一个视图）。
 * 高度与主区顶栏对齐（--cw-pi-topbar-h 44）。
 */
export function PiPaneTabs({ active, changes, terminalRunning, showShell, file, onSelect, onClose, className }: PiPaneTabsProps) {
  const tabs: PaneTab[] = [
    {
      id: "terminal",
      icon: SquareTerminal,
      label: "终端",
      suffix: terminalRunning ? <PiSpinner size={11} tone="muted" arc={0.5} label="有命令在运行" /> : undefined,
      cwId: "pi-pane-tab-terminal",
    },
    ...(showShell || active === "shell"
      ? [
          {
            id: "shell",
            icon: Terminal,
            label: "Shell",
            cwId: "pi-pane-tab-shell",
          } satisfies PaneTab,
        ]
      : []),
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

export interface PiPaneTitleProps {
  active: PiPaneKind
  changes?: { added: number; removed: number }
  showShell?: boolean
  file?: { name: string; kind: FileKind }
  onSelect?: (kind: PiPaneKind) => void
}

function PaneTitleMenu({
  active,
  changes,
  showShell,
  file,
  onSelect,
}: PiPaneTitleProps & { onSelect: (kind: PiPaneKind) => void }) {
  const surface = usePiMenuSurface()
  const hasDiff = !!changes && (changes.added > 0 || changes.removed > 0)
  return (
    <MenuSurface {...surface} className="w-[196px]">
      <MenuItem icon={<SquareTerminal />} checked={active === "terminal"} onSelect={() => onSelect("terminal")}>
        终端
      </MenuItem>
      {(showShell || active === "shell") && (
        <MenuItem icon={<Terminal />} checked={active === "shell"} onSelect={() => onSelect("shell")}>
          Shell
        </MenuItem>
      )}
      <MenuItem
        icon={<GitCompareArrows />}
        detail={hasDiff ? `+${changes.added} −${changes.removed}` : undefined}
        checked={active === "changes"}
        onSelect={() => onSelect("changes")}
      >
        改动
      </MenuItem>
      <MenuItem
        icon={<FileTypeIcon kind={file?.kind ?? "file"} className="size-4 text-(--cw-icon-fg)" />}
        checked={active === "file"}
        onSelect={() => onSelect("file")}
      >
        {file?.name ?? "文件"}
      </MenuItem>
    </MenuSurface>
  )
}

/** 手机推入页的页名：可切换的"改动 ∨"（TextSelector，不画框；可交互时接入 PiMenu 切换面板） */
export function PiPaneTitle({ active, changes, showShell, file, onSelect }: PiPaneTitleProps) {
  const isStatic = usePiStatic()
  const trigger = (
    <TextSelector
      data-pi-part="pane-title"
      label={PANE_LABEL[active]}
      tone="primary"
      size="lg"
      // 视觉 17/22 不变；按钮本身高 44（顶栏里的 truncate 槽会裁掉 ::after，所以不靠外扩）、左右各外扩 8（§4.4 文字选择器；B3）
      className="relative h-11 text-[17px] leading-[22px] font-semibold text-(--cw-text) after:absolute after:-inset-x-2 after:inset-y-0 after:content-[''] [&>svg]:size-4"
    />
  )
  if (isStatic || !onSelect) return trigger
  return (
    <PiMenu kind="dropdown" trigger={trigger} side="bottom" align="center">
      <PaneTitleMenu active={active} changes={changes} showShell={showShell} file={file} onSelect={onSelect} />
    </PiMenu>
  )
}

export interface PiPaneRailProps {
  hasChanges?: boolean
  changesStat?: { added: number; removed: number }
  terminalRunning?: boolean
  showShell?: boolean
  fileName?: string
  onExpand: () => void
  onSelect: (kind: PiPaneKind) => void
  className?: string
}

/**
 * 桌面对话右上角悬浮快速入口：右侧边栏关闭时浮在正文右上角，
 * 依次提供「展开右侧栏」「Changes (±)」「Terminal (>_)」「Shell」「Files」入口。
 */
export function PiPaneRail({
  hasChanges,
  changesStat,
  terminalRunning,
  showShell = true,
  fileName,
  onExpand,
  onSelect,
  className,
}: PiPaneRailProps) {
  const btnCls =
    "relative inline-flex size-[30px] items-center justify-center text-(--cw-icon-fg) transition-colors hover:bg-(--cw-row-hover) hover:text-(--cw-text) active:bg-(--cw-row-selected)"
  const changesTitle =
    hasChanges && changesStat ? `Changes (+${changesStat.added} −${changesStat.removed})` : "Changes"
  return (
    <nav
      aria-label="Workspace panels"
      data-pi-part="pane-rail"
      className={cn("flex flex-col items-center gap-0.5 p-1", className)}
    >
      <button
        type="button"
        data-cw-id="pi-pane-rail-expand"
        aria-label="Open right sidebar"
        title="Open right sidebar"
        onClick={onExpand}
        className={btnCls}
      >
        <ChevronsLeft size={16} strokeWidth={1.6} aria-hidden />
      </button>
      <button
        type="button"
        data-cw-id="pi-pane-rail-changes"
        aria-label="Open changes"
        title={changesTitle}
        onClick={() => onSelect("changes")}
        className={btnCls}
      >
        <Diff size={16} strokeWidth={1.6} aria-hidden />
        {hasChanges && <span data-pi-part="pane-rail-dot" aria-hidden />}
      </button>
      <button
        type="button"
        data-cw-id="pi-pane-rail-terminal"
        aria-label="Open terminal"
        title={terminalRunning ? "Terminal (running)" : "Terminal"}
        onClick={() => onSelect("terminal")}
        className={btnCls}
      >
        <SquareTerminal size={16} strokeWidth={1.6} aria-hidden />
        {terminalRunning && <span data-pi-part="pane-rail-dot" data-running="" aria-hidden />}
      </button>
      {showShell !== false && (
        <button
          type="button"
          data-cw-id="pi-pane-rail-shell"
          aria-label="Open interactive shell"
          title="Interactive shell"
          onClick={() => onSelect("shell")}
          className={btnCls}
        >
          <Terminal size={16} strokeWidth={1.6} aria-hidden />
        </button>
      )}
      <button
        type="button"
        data-cw-id="pi-pane-rail-file"
        aria-label="Open files"
        title={fileName ? `Files (${fileName})` : "Files"}
        onClick={() => onSelect("file")}
        className={btnCls}
      >
        <File size={16} strokeWidth={1.6} aria-hidden />
      </button>
    </nav>
  )
}
