/**
 * P11 桌面统一侧栏 dev 预览（task-37 M1，dev-only）。
 * 数据来自 ./fixtures.ts（PiSidebarData + 纯 reducer actions），组件为共享 UnifiedSidebar。
 *
 * URL 参数（search/hash 均可）：
 * - `view=board`（默认，六套合板）| `single`（单套，可交互）
 * - `skin=cursor|claude|codex`、`theme=dark|light`
 * - `scenario=base|states-all|devices-3|long-titles|widths|pin-archive|empty|busy-many|menu|search|hover|folders|identity-long`
 * - `width=220|272|360`、`collapsed=1`、`deviceMenuOpen=1`、`searchOpen=1`、`hoverRow=<index>`（初始悬停行，dev 预览用 DOM 事件模拟）
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { UnifiedSidebar } from "../../sidebar/UnifiedSidebar.tsx"
import { PI_SIDEBAR_GALLERY_PRESETS, p11DevActions, p11SidebarDataOf, type P11PreviewParams } from "./fixtures.ts"

const noopActions = p11DevActions(() => {})

function hoverRow(rowIndex: number | null): void {
  if (rowIndex == null || typeof document === "undefined") return
  let tries = 0
  const apply = () => {
    tries += 1
    const rows = document.querySelectorAll("[data-pi-sidebar] .sb-rowwrap")
    const target = rows[rowIndex]
    if (!target) {
      if (tries < 20) window.setTimeout(apply, 50)
      return
    }
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
  }
  window.requestAnimationFrame(apply)
}

/** 单套侧栏（可交互：pin/archive/group/device/search/width/collapse 走 dev reducer） */
export function SidebarPreviewSingle({ params }: { params: P11PreviewParams }) {
  const [data, setData] = useState(() => p11SidebarDataOf(params))
  const actions = useMemo(() => p11DevActions((updater) => setData(updater)), [])
  const boxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    hoverRow(params.hoverRow)
  }, [params.hoverRow, data.groups])
  return (
    <div
      ref={boxRef}
      className="p11-preview"
      data-p11-preview="sidebar"
      data-p11-preview-scenario={params.scenario}
      data-p11-preview-preset={`${params.style}-${params.theme}`}
      data-p11-preview-width={data.collapsed ? 56 : data.width}
      style={{ width: data.collapsed ? 56 : data.width, height: "100%", background: params.theme === "dark" ? "#101012" : "#e8e8eb" }}
    >
      <UnifiedSidebar data={data} actions={actions} />
    </div>
  )
}

/** 六套合板（D1 默认态）：每套独立固定数据，不交互 */
export function SidebarPreviewBoard({ params }: { params: P11PreviewParams }) {
  const panels = useMemo(
    () =>
      PI_SIDEBAR_GALLERY_PRESETS.map((preset) => ({
        preset,
        data: p11SidebarDataOf(params, { style: preset.style, theme: preset.theme }),
      })),
    [params],
  )
  return (
    <div className="p11-board" data-p11-preview="sidebar-board" style={{ display: "grid", gridTemplateColumns: "repeat(3, 272px)", gap: 22, padding: 22, background: "#101012" }}>
      {panels.map(({ preset, data }) => (
        <section key={preset.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, color: "#8f8b82", font: "11px/16px -apple-system, sans-serif" }}>{preset.label}</p>
          <div style={{ height: 700, overflow: "hidden", borderRadius: 12, outline: "1px solid rgba(255,255,255,.06)" }}>
            <UnifiedSidebar data={data} actions={noopActions} />
          </div>
        </section>
      ))}
    </div>
  )
}

export function SidebarPreview({ params }: { params: P11PreviewParams }) {
  return params.view === "single" ? <SidebarPreviewSingle params={params} /> : <SidebarPreviewBoard params={params} />
}
