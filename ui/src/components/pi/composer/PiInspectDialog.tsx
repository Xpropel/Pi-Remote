import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiDialogNote, PiDialogStatus, PiTextBlock } from "./PiDialogParts"
import type { PiJsonDialogData } from "./PiHostSettingsDialog"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiInspectDialogProps extends PiFamilyDialogProps, PiJsonDialogData {
  /** 分类页签（dialogsData.INSPECT_PAGES：工具全表、Provider 认证、MCP …） */
  pages?: readonly { id: string; label: string }[]
  active?: string
  onActiveChange?: (id: string) => void
  /** 当前页签的补充说明（扩展 flags 要按名字读） */
  note?: string | null
  onRefresh?: () => void
}

/**
 * 检视本机信息（G18，design §2 H：PiDialog + 分类页签 + JSON；开发向，入口放在命令面板"检视本机信息"）。
 * 页签用 role=tablist 的一排小按钮（design 写 kit PaneTabBar；它是右 pane 的页签条，带 + / 分屏，这里不合用，推断）。
 * 桌面 PiDialog 560；手机全高 sheet，页签横向滚动。
 */
export function PiInspectDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  pages = [],
  active,
  onActiveChange,
  note,
  json = "",
  clipped,
  phase = "ready",
  loadError,
  onRetry,
  onRefresh,
}: PiInspectDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const current = active ?? pages[0]?.id
  return (
    <PiDialog
      title="本机信息"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        <PiButton kind="outline" variant={v} className={cn(phone && "flex-1")} disabled={phase === "loading"} onClick={isStatic ? undefined : onRefresh}>
          刷新
        </PiButton>
      }
    >
      <div data-slot="pi-inspect-dialog" className="flex flex-col gap-3 pt-1">
        {/* 手机：页签条横向滚动；页签本身 44 高（§4.4；滚动容器会裁掉 ::after 外扩，所以不用外扩） */}
        <div role="tablist" aria-label="检视分类" className={cn("flex gap-1.5", phone ? "-mx-4 overflow-x-auto px-4" : "flex-wrap")}>
          {pages.map((p) => {
            const on = p.id === current
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={isStatic ? undefined : () => onActiveChange?.(p.id)}
                className={cn(
                  "inline-flex shrink-0 items-center rounded-(--cw-radius-pill) border border-solid px-2.5 whitespace-nowrap",
                  phone ? "h-11 px-3 text-[13px]" : "h-7 text-(length:--cw-text-sm)",
                  on ? "border-transparent bg-(--cw-row-selected) font-(--cw-weight-medium) text-(--cw-text)" : "border-(--cw-border) text-(--cw-text-2) hover:bg-(--cw-row-hover)",
                )}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        {note && <PiDialogNote variant={v}>{note}</PiDialogNote>}
        <div role="tabpanel" aria-label={pages.find((p) => p.id === current)?.label ?? "检视"}>
          <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry}>
            <PiTextBlock variant={v} text={json} clipped={clipped} label="本机信息（JSON）" maxHeight={phone ? 440 : 320} />
          </PiDialogStatus>
        </div>
      </div>
    </PiDialog>
  )
}
