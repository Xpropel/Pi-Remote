import type { ComponentPropsWithoutRef } from "react"
import { Atom, Braces, CodeXml, File, TextAlignStart } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import type { FileKind } from "./types"

/**
 * 文件类型小图标（kit/diff 内部子件，InlineDiffCard 与 DiffFileRow 共用；不进 catalog）。
 * 14px 盒，glyph 9–10（specs/ch3 §1.8）。颜色 tokens.css 里还没有，先用已有 token 兜底：
 * json 金棕（兜底 --cw-orange）、html 橙棕（兜底 --cw-syntax-func → --cw-orange）、
 * ts / tsx 蓝灰 / 青灰（兜底 --cw-syntax-property）、txt 与其他 --cw-icon-fg。
 */
const COLOR: Record<FileKind, string> = {
  json: "text-[color:var(--cw-file-icon-json,var(--cw-orange))]",
  html: "text-[color:var(--cw-file-icon-html,var(--cw-syntax-func,var(--cw-orange)))]",
  ts: "text-[color:var(--cw-file-icon-ts,var(--cw-syntax-property))]",
  tsx: "text-[color:var(--cw-file-icon-tsx,var(--cw-syntax-property))]",
  txt: "text-(--cw-icon-fg)",
  file: "text-(--cw-icon-fg)",
}

export interface FileTypeIconProps extends ComponentPropsWithoutRef<"span"> {
  kind: FileKind
}

export function FileTypeIcon({ kind, className, ...rest }: FileTypeIconProps) {
  return (
    <span
      aria-hidden
      data-slot="file-type-icon"
      data-kind={kind}
      className={cn("inline-grid size-3.5 shrink-0 place-items-center", COLOR[kind], className)}
      {...rest}
    >
      {kind === "ts" ? (
        // 文字徽 "TS"（9px / 700），#13 #14 的卡头
        <span className="font-(family-name:--cw-font-sans) text-[9px] leading-none font-bold tracking-[-0.02em]">TS</span>
      ) : (
        <Glyph kind={kind} />
      )}
    </span>
  )
}

function Glyph({ kind }: { kind: Exclude<FileKind, "ts"> }) {
  const props = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const
  switch (kind) {
    case "json":
      return <Braces {...props} />
    case "html":
      return <CodeXml {...props} />
    case "tsx":
      // React 原子（文档叫"齿轮"，放大看是原子形）
      return <Atom {...props} strokeWidth={1.5} />
    case "txt":
      // 不等长横线 ≡
      return <TextAlignStart {...props} strokeWidth={1.5} />
    case "file":
      return <File {...props} strokeWidth={1.5} />
  }
}
