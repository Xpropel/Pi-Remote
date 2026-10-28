import type { CSSProperties } from "react"
import { PiLayerProvider, PiRoot } from "@/components/pi/shared"
import { piLayoutOf } from "@/components/pi/shared/viewport"
import { usePiDevice } from "@/pi/hooks/usePiDevice"
import { PI_STAGE, PI_THEMES, PI_VIEWPORTS, type PiTheme, type PiStageSize } from "../registry"
import { ErrorBoundary } from "../ErrorBoundary"
import { stageVars, useReady, useStageHtml } from "../stage"
import { PlayApp } from "./PlayApp"
import { PLAY_PRESETS_A } from "./presets-a"
import { PLAY_PRESETS_B } from "./presets-b"
import { PLAY_PRESETS_C } from "./presets-c"
import { PlayPrimitives } from "./overlays"
import { PLAY_PRESETS, PLAY_PRIMITIVES_ID, type PlayPreset } from "./state"

/** 外壳的起始状态 + 三条线各自的（同 id 时线的覆盖外壳的） */
const PRESETS: Record<string, PlayPreset> = { ...PLAY_PRESETS, ...PLAY_PRESETS_A, ...PLAY_PRESETS_B, ...PLAY_PRESETS_C }

/**
 * #/play/<id>?vp=1440x900|390x844&theme=light|dark（P4，R2/p4-lanes.md §4）：同一批部件的可交互版，不参加对图。
 * 舞台和 #/pi 一样（贴在 (0,0)、data-pi-stage / data-pi-ready，ui-interact 的默认就绪选择器直接能用），但不提供 PiStaticProvider：
 * 部件走可交互分支（Radix、焦点管理、Esc 分层），外壳在 PiLayerProvider 里接 usePiShellShortcuts。
 * id = 起始状态（state.ts 的 PLAY_PRESETS 和各线的 PLAY_PRESETS_<线>，多数和设计屏同名），另有 overlays = 浮层原语自测页。
 */
export function PlayRoute(props: { id: string; vp: string | null; theme: string | null }) {
  return props.vp === "device" ? <PlayDeviceRoute id={props.id} theme={props.theme} /> : <PlayStageRoute {...props} />
}

/**
 * 设备模式（vp=device，P6，同 #/live 的设备模式）：不画固定尺寸的舞台，PiRoot 走产品模式铺满窗口（usePiDevice），
 * 给 R2/tools/ui-device.mjs 在 Chrome 设备模拟里量浮层原语（overlays 页的改名 sheet 遇到键盘等）。
 */
function PlayDeviceRoute({ id, theme }: { id: string; theme: string | null }) {
  const th = (theme ?? "light") as PiTheme
  const preset = PRESETS[id]
  const known = id === PLAY_PRIMITIVES_ID || preset != null
  const ok = known && (PI_THEMES as string[]).includes(th)
  const device = usePiDevice()
  const ready = useReady()
  if (!ok) {
    return (
      <div data-pi-missing="" className="p-8 text-(--cw-text-2)">
        <p className="mt-0 font-semibold">
          #/play/{id}：没有这个起始状态，或参数不对。可用：{[...Object.keys(PRESETS), PLAY_PRIMITIVES_ID].join("、")}
        </p>
      </div>
    )
  }
  return (
    <div
      data-pi-stage={id}
      data-pi-play="device"
      data-pi-device-mode=""
      data-pi-layout={device.viewport}
      data-pi-theme={th}
      data-pi-ready={ready ? "" : undefined}
      data-frame-ready={ready ? "" : undefined}
    >
      <ErrorBoundary where={`play:${id}`}>
        <PiRoot viewport={device.viewport} theme={th} device={device.frame}>
          <PiLayerProvider>
            {id === PLAY_PRIMITIVES_ID ? (
              <PlayPrimitives viewport={device.viewport} />
            ) : (
              <PlayApp screen={id} preset={preset} viewport={device.viewport} />
            )}
          </PiLayerProvider>
        </PiRoot>
      </ErrorBoundary>
    </div>
  )
}

function PlayStageRoute({ id, vp, theme }: { id: string; vp: string | null; theme: string | null }) {
  const viewport = (vp ?? "1440x900") as PiStageSize
  const layout = piLayoutOf(viewport)
  const th = (theme ?? "light") as PiTheme
  const preset = PRESETS[id]
  const known = id === PLAY_PRIMITIVES_ID || preset != null
  const ok = known && (PI_VIEWPORTS as string[]).includes(viewport) && (PI_THEMES as string[]).includes(th)
  const ready = useReady()
  useStageHtml(ok, viewport, th, false)
  if (!ok) {
    return (
      <div data-pi-missing="" className="p-8 text-(--cw-text-2)">
        <p className="mt-0 font-semibold">
          #/play/{id}：没有这个起始状态，或参数不对。可用：{[...Object.keys(PRESETS), PLAY_PRIMITIVES_ID].join("、")}
        </p>
        <a className="text-(--cw-link) underline" href="#/pi">
          回索引
        </a>
      </div>
    )
  }
  const size = PI_STAGE[viewport]
  return (
    <div
      data-pi-stage={id}
      data-pi-play=""
      data-pi-layout={layout}
      data-pi-theme={th}
      data-pi-ready={ready ? "" : undefined}
      data-frame-ready={ready ? "" : undefined}
      style={
        {
          position: "relative",
          width: size.width,
          height: size.height,
          overflow: "hidden",
          contain: "layout paint",
          colorScheme: th,
          ...stageVars(viewport, false),
        } as CSSProperties
      }
    >
      <ErrorBoundary where={`play:${id}`}>
        <PiRoot viewport={layout} theme={th}>
          <PiLayerProvider>
            {id === PLAY_PRIMITIVES_ID ? <PlayPrimitives viewport={layout} /> : <PlayApp screen={id} preset={preset} viewport={layout} />}
          </PiLayerProvider>
        </PiRoot>
      </ErrorBoundary>
    </div>
  )
}
