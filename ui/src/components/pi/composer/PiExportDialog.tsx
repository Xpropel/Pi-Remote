import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiSegments } from "./PiDisplayOptions"
import { PiDialogError, PiDialogNote, PiDialogStatus, PiTextBlock, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiExportDialogProps extends PiFamilyDialogProps {
  /** 导出的文本（export_session / export_session_file 的 text） */
  text?: string
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
  /** 扩展截断了（全文字数在 chars） */
  truncated?: boolean
  chars?: number | null
  /** 未载入会话导出：可选 文本 / JSONL，直接读文件 */
  cold?: boolean
  format?: "text" | "jsonl"
  onFormatChange?: (format: "text" | "jsonl") => void
  /** 大小说明（"共 38 KB / 12,040 字符"）；单次上限 512KB 的说明由弹窗自己写 */
  sizeNote?: string | null
  /** 下载的文件扩展名 */
  ext?: string
  error?: string | null
  onCopy?: () => void
  onDownload?: () => void
}

const FORMAT_OPTIONS = [
  { value: "text", label: "文本（可读）" },
  { value: "jsonl", label: "JSONL（原始）" },
]

/**
 * 导出（G12，design §2 H：PiDialog（文本预览 + 复制 / 下载 .txt）；单次 ≤ 512KB）。桌面 PiDialog 560；手机全高 sheet。版式推断。
 * 已载入：export_session 的文本；未载入（cold）：export_session_file，可选文本 / JSONL，超限报错而不是导出半份。
 */
export function PiExportDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  text = "",
  phase = "ready",
  loadError,
  onRetry,
  truncated,
  chars,
  cold,
  format = "text",
  onFormatChange,
  sizeNote,
  ext = "txt",
  error,
  onCopy,
  onDownload,
}: PiExportDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const footer = (
    <>
      <PiButton kind="outline" variant={v} className={cn(phone && "flex-1")} disabled={!text} onClick={isStatic ? undefined : onCopy}>
        复制
      </PiButton>
      <PiButton variant={v} className={cn(phone && "flex-1")} disabled={!text} onClick={isStatic ? undefined : onDownload}>
        下载 .{ext}
      </PiButton>
    </>
  )
  return (
    <PiDialog
      title={cold ? "导出会话（未载入）" : "导出会话"}
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={footer}
    >
      <div data-slot="pi-export-dialog" className="flex flex-col gap-3 pt-1">
        {cold && (
          <>
            <PiSegments
              variant={v}
              label="导出格式"
              options={FORMAT_OPTIONS}
              value={format}
              className={phone ? "w-full" : "w-[260px]"}
              onValueChange={isStatic ? undefined : (value) => onFormatChange?.(value as "text" | "jsonl")}
            />
            <PiDialogNote variant={v}>直接读会话文件，不需要先载入；单次最多 512 KB，超限会报错而不是导出半份。</PiDialogNote>
          </>
        )}
        <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry} empty={phase === "ready" && !text ? "还没有可导出的内容" : null}>
          {truncated && <PiDialogNote variant={v}>导出已截断{chars != null ? `（全文 ${chars.toLocaleString("zh-CN")} 字符）` : ""}。</PiDialogNote>}
          {sizeNote && <PiDialogNote variant={v}>{sizeNote}</PiDialogNote>}
          <PiTextBlock variant={v} text={text} label="导出的会话文本" maxHeight={phone ? 420 : 300} />
        </PiDialogStatus>
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
