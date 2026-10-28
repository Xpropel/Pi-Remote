import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// 开发画廊入口（实施计划 P2.4、D6）：gallery.html 加载，只在 PI_GALLERY=1 时进构建，不进生产包。
// 样式和新界面（src/pi/main.tsx）同一套，顺序照 replica 的 src/main.tsx：kit 补充 token → 官方 tokens（同名以官方为准）→ Tailwind + 主题映射 + 基础样式
import "../styles/tokens.local.css"
import "../styles/tokens.css"
import "../styles/index.css"
import { installPiUiExtensionMockIfRequested, resolvePiUiMockOptions } from "@/pi/extensions/mock"
import { PiGallery } from "./PiStage"
import { piErrors, piGalleryExpose } from "./registry"

declare global {
  interface Window {
    /** 画廊 mock 接线结果（e2e / 验证线断言；生产入口无此对象） */
    __PI_GALLERY_MOCK__?: { installed: boolean; caps: string[]; source: "url" | "storage" | null }
  }
}

// 给截图脚本（R2/tools/ui-pi-shots.mjs）枚举屏幕；注册问题只警告，由脚本判失败
window.__PI_GALLERY__ = piGalleryExpose()
for (const e of piErrors) console.warn(`[pi registry] ${e.where}: ${e.message}`)

/*
 * P4.2 mock 接线（task-19，E4）：**仅画廊入口**。
 * - dev server：`gallery.html?caps=all#/live/...`（query）或 `gallery.html#/live/...&caps=all`（hash 内）都会自动注入；
 *   规则由 `resolvePiUiMockOptions` 解析（URL 优先，其次 localStorage `pi_dev_ui_mock_caps`），只覆盖 31 项 provider-backed，
 *   builtin/contract-only 保持 available（E1：不冒充注入）。
 * - `PI_GALLERY=1` 静态 build：`import.meta.env.DEV === false`，用 `force: true` 旁路（同一函数，不额外分支）。
 * - 生产入口 `ui/src/pi/main.tsx` 不 import 本文件 / mock 模块 → 生产包无 mock（gate-2 用 sentinel grep 验证）。
 */
const hashQuery = window.location.hash.includes("?") ? (window.location.hash.split("?")[1] ?? "") : ""
const mockSearch = [window.location.search.replace(/^\?/, ""), hashQuery].filter(Boolean).join("&")
const mockOptions = resolvePiUiMockOptions({ search: mockSearch, storage: window.localStorage })
const mockInstalled = installPiUiExtensionMockIfRequested({ force: true, search: mockSearch, storage: window.localStorage })
window.__PI_GALLERY_MOCK__ = { installed: mockInstalled, caps: mockOptions?.caps ?? [], source: mockOptions?.source ?? null }
if (mockOptions) console.info(`[pi mock] simulated ${mockInstalled ? mockOptions.caps.length : 0} provider-backed 能力（source=${mockOptions.source}）`)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PiGallery />
  </StrictMode>,
)
