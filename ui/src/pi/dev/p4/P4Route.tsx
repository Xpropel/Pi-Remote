/**
 * `#/p4/<surface>`（P4.2 M2）：P4 场景画廊。
 *
 * `#/p4/CL-CHAT-07?ui=claude&vp=1440x900&theme=light&caps=all&fixture=conversation`
 * - 同等 LiveRoute 的真实容器树 + 假 relay（可交互），再包 mock provider（`caps=`，缺省 none）与场景驱动；
 * - 驱动按 `scenarios.ts` 点稳定选择器到达目标 surface，完成后写 `data-p4-ready="<surface>"`；
 * - `caps=none` 用于**禁用态**截图（能力 unavailable + 变体统一禁用态），`caps=all` 用于**模拟态**截图；
 * - 失败写 `data-p4-error`（选择器/目标缺失），脚本据此 SKIP/FAIL（变体 W3 未落地时 SKIP）。
 *
 * 只进画廊（`PI_GALLERY=1` / dev server）；生产入口不 import 本文件，也不 import mock。
 */
import { Suspense, useEffect, useMemo, type CSSProperties } from "react"
import { PiLayerProvider } from "@/components/pi/shared/layers"
import { piLayoutOf } from "@/components/pi/shared/viewport"
import { installPiUiExtensionMock, parsePiUiMockCaps, piUiDemoStore, uninstallPiUiExtensionMock } from "@/pi/extensions/mock"
import { PiNowProvider } from "@/pi/hooks/useNow"
import { usePiUiState, type PiUiSeed } from "@/pi/hooks/usePiUiState"
import { PiVariantLoading, piVariantDefOf } from "@/pi/variants"
import { isPiUiVariant, piUiVariantOf, type PiUiVariant } from "@/pi/variants/types"
import type { PiVariant } from "@/pi/containers/types"
import { ErrorBoundary } from "../ErrorBoundary"
import { makeFakeRelay } from "../fakeRelay"
import { liveRelayOf } from "../fixtures/derive"
import type { PiLiveFixture } from "../fixtures/types"
import { LIVE_SEEDS, type PiLiveSeed } from "../live/seeds"
import { LIVE_SEEDS_A } from "../live/seeds-a"
import { LIVE_SEEDS_B } from "../live/seeds-b"
import { LIVE_SEEDS_C } from "../live/seeds-c"
import { PI_STAGE, PI_THEMES, PI_VIEWPORTS, type PiStageSize, type PiTheme } from "../registry"
import { stageVars, useReady, useStageHtml } from "../stage"
import { useP4ScenarioDriver } from "./driver"
import { useP4ModelDriver } from "./modelDriver"
import { p4ScenarioOf, p4VariantOfSurface } from "./scenarios"

const FIXTURES = import.meta.glob<PiLiveFixture>("../fixtures/live/*.ts", { eager: true, import: "default" })
const BY_ID = new Map(Object.values(FIXTURES).map((fixture) => [fixture.id, fixture]))

function seedOf(fixtureId: string, variant: PiVariant, uiVariant: PiUiVariant): PiUiSeed {
  const layers: (PiLiveSeed | undefined)[] = [LIVE_SEEDS[fixtureId], LIVE_SEEDS_A[fixtureId], LIVE_SEEDS_B[fixtureId], LIVE_SEEDS_C[fixtureId]]
  const seed: PiUiSeed = {}
  for (const layer of layers) Object.assign(seed, layer?.ui, layer?.[variant])
  return { ...seed, prefs: { ...seed.prefs, ui: uiVariant } }
}

function P4Missing({ message }: { message: string }) {
  return (
    <div data-p4-missing="" className="p-8 text-(--cw-text-2)">
      <p className="mt-0 font-semibold">{message}</p>
      <a className="text-(--cw-link) underline" href="#/pi">
        回索引
      </a>
    </div>
  )
}

export interface P4RouteProps {
  id: string
  vp: string | null
  theme: string | null
  ui: string | null
  caps: string | null
  fixture: string | null
  /** mock model 场景 id（&model=cowork-plan）；仅 caps 非 none 时生效 */
  model: string | null
}

declare global {
  interface Window {
    /** P4 画廊 mock store（e2e 读状态/事件；仅 dev/gallery 注入时存在） */
    __PI_DEMO_STORE__?: ReturnType<typeof piUiDemoStore>
  }
}

export function P4Route({ id, vp, theme, ui, caps, fixture: fixtureOverride, model }: P4RouteProps) {
  const scenario = p4ScenarioOf(id)
  const viewport = (vp ?? "1440x900") as PiStageSize
  const layout = piLayoutOf(viewport)
  const variantLayout: PiVariant = layout
  const th = (theme ?? "light") as PiTheme
  const uiVariant: PiUiVariant = scenario?.variant ?? p4VariantOfSurface(id) ?? piUiVariantOf(ui)
  const fixtureId = fixtureOverride ?? scenario?.fixture ?? "conversation"
  const fixture = BY_ID.get(fixtureId) ?? BY_ID.get("conversation")
  const ok = (PI_VIEWPORTS as readonly string[]).includes(viewport) && (PI_THEMES as readonly string[]).includes(th) && (ui == null || isPiUiVariant(ui))
  const interactive = true
  const relay = useMemo(() => (fixture ? makeFakeRelay(liveRelayOf(fixture, { mobile: variantLayout === "phone" })) : null), [fixture, variantLayout])
  const [uiState, act] = usePiUiState({ seed: { ...seedOf(fixtureId, variantLayout, uiVariant), ...(scenario?.seed ?? {}) }, persist: false })
  const capsActive = !!caps && caps !== "none" && caps !== "off"
  const modelState = useP4ModelDriver(model, capsActive)
  const driver = useP4ScenarioDriver(scenario, interactive)
  const ready = useReady()
  useStageHtml(ok, viewport, th, false)

  // caps=：URL 优先（none / all / csv）。卸载时清掉 mock，避免 gallery 路由间泄漏。
  useEffect(() => {
    const raw = caps?.trim()
    if (!raw) {
      // 无 API 参数：保留 dev 入口 auto-install（query ?caps= / localStorage flag），只暴露 store
      if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = piUiDemoStore()
      return () => {
        if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = null
      }
    }
    if (raw === "none" || raw === "off") {
      uninstallPiUiExtensionMock()
      if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = null
      return () => {
        uninstallPiUiExtensionMock()
        if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = null
      }
    }
    const parsed = parsePiUiMockCaps(raw)
    if (parsed && parsed.length) {
      installPiUiExtensionMock({ caps: parsed, mode: "simulated", source: "url" })
      if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = piUiDemoStore()
    } else {
      uninstallPiUiExtensionMock()
      if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = null
    }
    return () => {
      uninstallPiUiExtensionMock()
      if (typeof window !== "undefined") window.__PI_DEMO_STORE__ = null
    }
  }, [caps])

  if (!ok) return <P4Missing message={`${id}：参数不对（vp=${PI_VIEWPORTS.join(" | ")}；theme=${PI_THEMES.join(" | ")}；ui=cursor | claude | codex）`} />
  if (!scenario) return <P4Missing message={`${id}：scenarios.ts 没有这个 surface（已登记 ${[...BY_ID.keys()].length} 个 fixture）`} />
  if (!fixture || !relay) return <P4Missing message={`${id}：fixture "${fixtureId}" 不存在`} />

  const size = PI_STAGE[viewport]
  const variantDef = piVariantDefOf(uiVariant)
  const Variant = variantDef.Component
  return (
    <div
      data-pi-stage={id}
      data-pi-ui={uiVariant}
      data-pi-live="interactive"
      data-p4-scenario={id}
      data-p4-caps={caps ?? "none"}
      data-p4-driver-status={driver.status}
      data-p4-model={modelState.scenario ?? undefined}
      data-p4-model-status={modelState.status}
      data-p4-model-steps={modelState.steps}
      data-p4-model-events={modelState.events}
      data-p4-ready={driver.status === "ready" ? id : undefined}
      data-p4-error={driver.status === "blocked" ? (driver.error ?? "blocked") : undefined}
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
      <ErrorBoundary where={`p4:${id}`}>
        <Suspense fallback={<PiVariantLoading variant={uiVariant} />}>
          <PiNowProvider now={fixture.now}>
            <PiLayerProvider>
              <Variant relay={relay} ui={uiState} act={act} keyboardOpen={false} theme={th} layout={variantLayout} />
            </PiLayerProvider>
          </PiNowProvider>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}
