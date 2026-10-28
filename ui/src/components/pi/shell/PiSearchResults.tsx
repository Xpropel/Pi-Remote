import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { SidebarGroup } from "@/components/kit"
import { PiSessionRow, usePiStatic, type PiSessionRowData } from "@/components/pi/shared"

export interface PiSearchSection {
  key: string
  /** 分组名："标题匹配 2"、"内容匹配 2 · MacBook Pro" */
  label: ReactNode
  rows: PiSessionRowData[]
  /** 分组末尾的一行（"只搜了最近 50 个会话"、Spinner 搜索中、错误文案） */
  note?: ReactNode
}

export interface PiSearchResultsProps {
  variant: "desktop" | "phone"
  sections: PiSearchSection[]
  selectedId?: string
  /** P4：点一行结果 / Enter（打开会话）。静态态不接 */
  onOpenRow?: (row: PiSessionRowData) => void
  /** P4 契约：静态态（画廊截图）。不传时取 PiStaticContext */
  static?: boolean
  className?: string
}

/**
 * 搜索结果（design C10 / C11；compose from kit: SidebarGroup(section 头) + PiSessionRow）。
 * 放进 PiSidebar 的 body 槽：标题匹配（本地过滤）在上，内容匹配（search_session_bodies，点了"在正文中搜索"才有）在下。
 * 命中片段加粗（row.highlight），不用底色（推断）。
 */
export function PiSearchResults({ variant, sections, selectedId, onOpenRow, static: staticProp, className }: PiSearchResultsProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = variant === "phone"
  const header = phone
    ? "h-9 pt-[13px] pb-[7px] pl-2"
    : "h-9 pt-[11px] pb-[9px]"
  return (
    <div data-pi-search-results="" className={cn("flex flex-col", className)}>
      {sections.map((section) => (
        <SidebarGroup
          key={section.key}
          data-pi-search-section={section.key}
          label={<span className="text-(--cw-pi-text-secondary)">{section.label}</span>}
          actions={false}
          headerClassName={header}
        >
          {section.rows.map((row) => (
            <PiSessionRow
              key={row.id}
              row={row}
              variant={variant}
              selected={row.id === selectedId}
              static={isStatic}
              onOpen={!isStatic && onOpenRow ? () => onOpenRow(row) : undefined}
            />
          ))}
          {section.note}
        </SidebarGroup>
      ))}
    </div>
  )
}
