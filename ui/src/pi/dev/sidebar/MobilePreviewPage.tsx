/**
 * P11 移动双模式 dev 预览（task-37 M1，dev-only）。
 * 数据同 `PiSidebarData`（与桌面共享），壳为共享 MobileNavShell / MobileNavSetting。
 *
 * URL 参数（search/hash 均可）：
 * - `mode=list|drawer`、`page=list|session`、`drawerOpen=1`
 * - `scenario=drawer-base|drawer-long|list-base|list-long|list-swipe|settings-nav|search|empty|longpress`
 * - `skin=cursor|claude|codex`、`theme=dark|light`、`pref=list|drawer`（settings-nav 默认值）
 */
import { useEffect, useMemo, useState } from "react"
import { MobileNavSetting, MobileNavShell } from "@/pi/mobile"
import { p11DevActions, p11MobileDataOf, p11SelectSession, type P11PreviewParams } from "./fixtures.ts"

function SessionPlaceholder() {
  const line = (width: string) => <span style={{ display: "block", height: 10, borderRadius: 5, background: "rgba(255,255,255,.06)", width }} />
  return (
    <div className="p11-mobile-session" data-p11-preview="mobile-session-placeholder" style={{ display: "flex", flexDirection: "column", gap: 12, padding: "18px 14px" }}>
      {line("72%")}
      {line("86%")}
      {line("54%")}
    </div>
  )
}

/** 设置项「移动端交互 UI」两卡（P11-MOB-10；独立整页预览） */
export function MobileSettingsPreview({ params }: { params: P11PreviewParams }) {
  const [value, setValue] = useState<"list" | "drawer">(params.settingValue)
  return (
    <div
      className="p11-preview-mobile-settings"
      data-p11-preview="mobile-settings"
      data-p11-preview-preset={`${params.style}-${params.theme}`}
      style={{ minHeight: "100vh", padding: "18px 14px 30px", background: params.theme === "dark" ? "#0e0e10" : "#f3f1ea" }}
    >
      <p style={{ margin: "0 0 10px", fontSize: 13, opacity: 0.7 }}>设置</p>
      <p style={{ margin: "18px 0 10px", fontSize: 13, fontWeight: 600 }}>移动端</p>
      <MobileNavSetting value={value} onChange={setValue} />
    </div>
  )
}

export function MobilePreview({ params }: { params: P11PreviewParams }) {
  const [data, setData] = useState(() => p11MobileDataOf(params))
  const [drawerOpen, setDrawerOpen] = useState(params.drawerOpen)
  const actions = useMemo(() => p11DevActions((updater) => setData(updater)), [])
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.dataset.piTheme = params.theme
  }, [params.theme])
  return (
    <div
      className="p11-preview-mobile"
      data-p11-preview="mobile"
      data-p11-preview-scenario={params.scenario}
      data-p11-preview-mode={params.mode}
      data-p11-preview-preset={`${params.style}-${params.theme}`}
      style={{ width: "100%", height: "100vh", minHeight: "100vh", background: params.theme === "dark" ? "#0e0e10" : "#f3f1ea" }}
    >
      <MobileNavShell
        mode={params.mode}
        data={data}
        actions={actions}
        page={params.page}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        onOpenSession={(key) => setData((current) => p11SelectSession(current, key))}
        onBackToList={() => {}}
      >
        <SessionPlaceholder />
      </MobileNavShell>
    </div>
  )
}

export function MobilePreviewEntry({ params }: { params: P11PreviewParams }) {
  return params.scenario === "settings-nav" ? <MobileSettingsPreview params={params} /> : <MobilePreview params={params} />
}
