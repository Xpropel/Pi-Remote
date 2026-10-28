import { Checkbox } from "@/components/kit"
import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiDialogError, PiDialogNote, PiDialogStatus, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"
import { C_SECONDARY, TOUCH_44 } from "./styles"

export interface PiToolsDialogProps extends PiFamilyDialogProps {
  /** 全表 + 已启用（dialogsData.toolRowsOf） */
  rows?: { name: string; description?: string }[]
  /** 勾上的 */
  selected?: string[]
  /** 全表拿不到、只列已启用的 */
  fallback?: boolean
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
  /** 勾选和当前启用的不一样 */
  dirty?: boolean
  working?: boolean
  error?: string | null
  onToggle?: (name: string) => void
  onSave?: () => void
}

/**
 * 工具（G16，design §2 H：PiDialog + 勾选行（kit Checkbox variant=menu）+ 保存）。get_active_tools + get_all_tools → set_active_tools。
 * 改的是当前启用的工具，不是本机注册表。桌面 PiDialog 560；手机全高 sheet。版式推断。
 */
export function PiToolsDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  rows = [],
  selected = [],
  fallback,
  phase = "ready",
  loadError,
  onRetry,
  dirty,
  working,
  error,
  onToggle,
  onSave,
}: PiToolsDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="工具"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        <PiButton variant={v} className={cn(phone && "flex-1")} disabled={!dirty || working || phase !== "ready"} onClick={isStatic ? undefined : onSave}>
          {working ? "保存中…" : "保存"}
        </PiButton>
      }
    >
      <div data-slot="pi-tools-dialog" className="flex flex-col gap-3 pt-1">
        <PiDialogNote variant={v}>改的是这个会话当前启用的工具，不是本机注册表。</PiDialogNote>
        <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry} empty={phase === "ready" && rows.length === 0 ? "没有可管理的工具" : null}>
          {fallback && <PiDialogNote variant={v}>全表拿不到，只列出当前启用的工具。</PiDialogNote>}
          <div role="group" aria-label="启用的工具" className="-mx-2 flex flex-col">
            {rows.map((row) => {
              const on = selected.includes(row.name)
              return (
                <label
                  key={row.name}
                  className={cn("flex min-w-0 items-start gap-3 rounded-[7px] px-2 hover:bg-(--cw-row-hover)", phone ? "min-h-12 py-2.5" : "min-h-8 py-1.5")}
                >
                  <Checkbox
                    variant="menu"
                    checked={on}
                    disabled={working}
                    // 工具名是英文标识符：名称前面加中文动作（§4.7 图标钮名称要中文）
                    aria-label={`启用 ${row.name}`}
                    onCheckedChange={isStatic ? undefined : () => onToggle?.(row.name)}
                    // 手机：整行是 label 也能点，勾选框自己再外扩到 44（§4.4，ui-a11y 按元素量）
                    className={cn("mt-[3px]", phone && cn("mt-1 size-4", TOUCH_44))}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("min-w-0 truncate text-(--cw-text)", phone ? "text-[15px]" : "text-(length:--cw-text-md)")}>{row.name}</span>
                    {row.description && <span className={cn("min-w-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>{row.description}</span>}
                  </span>
                </label>
              )
            })}
          </div>
        </PiDialogStatus>
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
