/**
 * 开发画廊「对图舞台」外框（R5 P1 修复，仅 dev 工装，不进产品包）。
 *
 * 背景：`#/pi` `#/play` `#/p4` `#/live` 的对图舞台固定 1440×900 / 390×844（设计规格的 CSS 像素）。
 * 浏览器窗口放大时，舞台不随窗口变宽 → 周围出现大片空白；用户误以为是产品响应式坏了。
 * 这里只改「舞台怎么展示」：窗口比舞台大时把舞台居中、加中性网格背景 + 尺寸/用途标注 + 提示；
 * 窗口正好等于舞台尺寸时（截图线 1440×900 / 390×844）**不显示任何外框/标注**，保证对图产物与原来逐像素一致。
 * 产品 UI 是响应式的，走 `index.html`（dev server `/`），与本舞台无关。
 */
import { useSyncExternalStore, type ReactNode } from "react"
import { PI_STAGE, type PiStageSize } from "./registry"

const STAGE_NOTE = "非产品响应式"

function vpLabelOf(vp: string | null | undefined): string {
  return vp && vp in PI_STAGE ? vp : "1440x900"
}

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb)
  return () => window.removeEventListener("resize", cb)
}

function viewportSize(): number {
  return window.innerWidth * 100000 + window.innerHeight
}

/** 舞台外框：窗口大于舞台（任一方向多 1px）才显示背景/标注；正好等于舞台时渲染成原来的裸舞台。 */
export function PiDevStageFrame({ vp, children }: { vp: string | null | undefined; children: ReactNode }) {
  const label = vpLabelOf(vp)
  const size = PI_STAGE[label as PiStageSize]
  const vpCode = useSyncExternalStore(subscribeResize, viewportSize, () => 0)
  const winW = Math.floor(vpCode / 100000)
  const winH = vpCode % 100000
  const hasViewport = vpCode !== 0
  // 正好等于舞台尺寸（截图线 1440×900 / 390×844）→ 原样裸舞台，保证对图逐像素不变
  const chromeShown = hasViewport && (winW !== size.width || winH !== size.height)
  const fits = hasViewport && winW >= size.width && winH >= size.height
  return (
    <div
      data-pi-stage-frame=""
      data-pi-stage-frame-chrome={chromeShown ? "" : undefined}
      className={`relative flex w-full overflow-auto ${chromeShown ? "min-h-screen bg-neutral-300/70 p-10" : "min-h-screen p-0"} ${fits ? "items-center justify-center" : "items-start justify-start"}`}
      style={
        chromeShown
          ? {
              backgroundImage: "radial-gradient(circle at 1px 1px, rgba(0,0,0,0.16) 1px, transparent 0)",
              backgroundSize: "24px 24px",
            }
          : undefined
      }
    >
      <div
        data-pi-stage-holder=""
        className={`relative shrink-0 bg-(--cw-bg) ${chromeShown ? "rounded-md shadow-[0_24px_80px_rgba(0,0,0,0.35)] ring-1 ring-black/20" : ""}`}
        style={{ width: size.width, height: size.height }}
      >
        {children}
      </div>
      {chromeShown ? (
        <>
          <div
            data-pi-stage-chrome="size"
            className="pointer-events-none fixed top-4 right-4 z-50 rounded-md bg-neutral-900/85 px-3 py-1.5 font-mono text-[12px] leading-4 text-white shadow-lg"
          >
            对图舞台 {size.width}×{size.height} · {STAGE_NOTE}
          </div>
          <div
            data-pi-stage-chrome="hint"
            className="pointer-events-none fixed inset-x-0 bottom-0 z-50 bg-neutral-900/80 px-4 py-2 text-center text-[12px] leading-4 text-white"
          >
            这里是对图工装：舞台固定 {size.width}×{size.height}（设计规格 CSS 像素），窗口放大时的空白 = 舞台外围背景。
            <span className="mx-1 opacity-60">·</span>
            产品 UI 是响应式的，请开 <span className="font-mono">index.html</span>（dev server <span className="font-mono">/</span>）。
          </div>
        </>
      ) : null}
    </div>
  )
}
