import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"
import { PiRoot } from "@/components/pi/shared"
import { PiLayerProvider, PiStaticProvider } from "@/components/pi/shared/layers"
import { piLayoutOf } from "@/components/pi/shared/viewport"
import { noticeStore } from "@/chat/composer/noticeStore"
import { useNoticeSnapshot } from "@/chat/composer/useNotices"
import { installPiUiExtensionMock, parsePiUiMockCaps, uninstallPiUiExtensionMock } from "@/pi/extensions/mock"
import { PiAppBody } from "@/pi/containers/PiAppBody"
import type { PiVariant } from "@/pi/containers/types"
import { PiSettingsHost } from "@/pi/hooks/PiSettingsHost"
import { usePiDevice } from "@/pi/hooks/usePiDevice"
import { PiNowProvider } from "@/pi/hooks/useNow"
import { usePiUiState, type PiUiSeed } from "@/pi/hooks/usePiUiState"
import { PiVariantLoading, piVariantDefOf, type VariantAppProps } from "@/pi/variants"
import { isPiUiVariant, piUiVariantOf, type PiUiVariant } from "@/pi/variants/types"
import "@/pi/styles/privacy.css"
import { ErrorBoundary } from "./ErrorBoundary"
import { makeFakeRelay } from "./fakeRelay"
import { liveRelayOf } from "./fixtures/derive"
import type { PiLiveFixture } from "./fixtures/types"
import { KeyboardPlaceholder } from "./KeyboardPlaceholder"
import { LIVE_SEEDS, type PiLiveSeed } from "./live/seeds"
import { LIVE_SEEDS_A } from "./live/seeds-a"
import { LIVE_SEEDS_B } from "./live/seeds-b"
import { LIVE_SEEDS_C } from "./live/seeds-c"
import { findPiScreen, PI_STAGE, PI_THEMES, PI_VIEWPORTS, type PiTheme, type PiStageSize } from "./registry"
import { stageVars, useReady, useStageHtml } from "./stage"

/*
 * #/live/<id>?vp=1440x900|390x844&theme=light|dark（plan P5.2、§8.2 L2）：真实容器树 + 假 relay。
 * fixture（fixtures/live/<id>.ts，只有 relay 的原始字段）→ liveRelayOf（用真实函数补 useRelay 的派生字段）→ makeFakeRelay → PiAppBody，
 * 和产品入口 PiApp 走同一个分支（没有 token → 登录，否则按视口进 DesktopApp / PhoneApp）。
 * now 钉在 fixture 的 now（PiNowProvider）；界面起始状态来自 live/seeds*.ts（usePiUiState 的 seed，不读写存储）。
 * 舞台和 #/pi 一样（贴在 (0,0)、data-pi-stage / data-pi-ready、键盘屏在 390 下叠键盘占位），另有 data-pi-live；
 * L2 比的是静态样子，所以默认整棵树包在 PiStaticProvider 里（P4 契约 §1.1）。截图：ui-pi-shots --route live。
 * 带 &interactive 时不包 PiStaticProvider、改包 PiLayerProvider（同 #/play）：部件走可交互分支，给 ui-interact 在真实容器上点
 * （例如 plan 5.4 的灯箱用例）；假 relay 的动作都是 no-op，只有界面状态会变。data-pi-live="interactive"，不参加对图。本文件归 p5-base。
 * 唯一的例外是草稿（P5 第 2 轮）：可交互时 draft / setDraft 存在这里（composer 跟着按真实函数重算 S0 / S1），
 * 输入框能打字、↑ / ↓ 提示词历史（K04）能换草稿；其余函数成员仍是 fixture / 假 relay 的同一份（引用不变，取数不会每打一个字重跑）。
 * P6（p6-base）：vp=device 是设备模式——不画固定尺寸的舞台，PiRoot 走产品模式（和 PiApp 同一个 usePiDevice：1024 断点、
 * useMobileViewport 的键盘、env() 安全区、100dvh），总是可交互；给 R2/tools/ui-device.mjs 在 Chrome 设备模拟里量（平板 820×1180 等）。
 * data-pi-live="device"，不参加对图。
 * P1 架构线（PI-UI-REFS）：&ui=cursor|claude|codex 按变体渲染（缺省 cursor = 下面的原树）。
 *   - cursor：PiRoot + PiAppBody，和 P1 之前完全一样；
 *   - claude / codex：variants/index.ts 的 React.lazy 入口（骨架由 P1 提供，P2 两条线替换），舞台写 data-pi-ui，
 *     界面状态用 usePiUiState 的 seed（persist: false，不写存储）把 prefs.ui 预置成该变体。
 * 这是 P2 / 验证线给两套设计出整屏对图的入口：#/live/<fixture>?vp=1440x900&theme=light&ui=claude。
 */

const FIXTURES = import.meta.glob<PiLiveFixture>("./fixtures/live/*.ts", { eager: true, import: "default" })

const BY_ID = new Map(Object.values(FIXTURES).map((fx) => [fx.id, fx]))

/** 外壳的起始状态 + 三条线各自的（同 id 时线的覆盖外壳的；每层先 ui 再叠当前视口的） */

/** dev-only：`?mobileNav=drawer|list` 预置起始偏好（gallery seed persist:false，localStorage 不生效），仅预览层。 */
function liveSeedWithDevPrefs(id: string, variant: PiVariant, ui: PiUiVariant): PiUiSeed {
  const seed = liveSeedOf(id, variant, ui)
  // gallery 常见形态是 `?caps=all#/live/…?mobileNav=…`：search 与 hash query 都要读，hash 覆盖 search
  const params = new URLSearchParams(window.location.search)
  const hashQuery = window.location.hash.includes("?") ? window.location.hash.slice(window.location.hash.indexOf("?") + 1) : ""
  for (const [key, value] of new URLSearchParams(hashQuery)) params.set(key, value)
  const mobileNav = params.get("mobileNav")
  if (mobileNav !== "drawer" && mobileNav !== "list") return seed
  return { ...seed, prefs: { ...seed.prefs, mobileNav } }
}

/**
 * dev-only：`&notify=done|error|waiting` 给假 relay 注入一条真实形状的通知信号。
 * done / error = 当前房间的一条 turnEnd；waiting = 挂载 600ms 后新开一个 ui_prompt，
 * 让宿主走「等待条目新增」的动态路径（不是预先存在的等待）。
 * 只给可交互态用（静态对图不跑通知副作用）；验证设置 v2 的通知开关时用它代替真实回合。
 */
function liveDevNotificationKind(interactive: boolean): "done" | "error" | "waiting" | null {
  if (!interactive) return null
  const params = new URLSearchParams(window.location.search)
  const hashQuery = window.location.hash.includes("?") ? window.location.hash.slice(window.location.hash.indexOf("?") + 1) : ""
  for (const [key, value] of new URLSearchParams(hashQuery)) params.set(key, value)
  const kind = params.get("notify")
  return kind === "done" || kind === "error" || kind === "waiting" ? kind : null
}

function liveSeedOf(id: string, variant: PiVariant, ui: PiUiVariant): PiUiSeed {
  const layers: (PiLiveSeed | undefined)[] = [LIVE_SEEDS[id], LIVE_SEEDS_A[id], LIVE_SEEDS_B[id], LIVE_SEEDS_C[id]]
  const seed: PiUiSeed = {}
  for (const layer of layers) Object.assign(seed, layer?.ui, layer?.[variant])
  // PI-UI-REFS：?ui= 选中的变体写进起始偏好 prefs.ui（这个 usePiUiState 是 persist: false，不读不写存储）
  return { ...seed, prefs: { ...seed.prefs, ui } }
}

/**
 * fixture → 假 relay；可交互时草稿 / 设备选择存在这里（见文件头）。
 * 设备选择必须回写为可渲染状态，否则设置 v2 的「默认设备自动选中」在画廊里点了也看不出来。
 */
function useLiveRelay(fixture: PiLiveFixture | undefined, variant: PiVariant, interactive: boolean) {
  const notify = liveDevNotificationKind(interactive)
  // waiting 走「挂载后新开弹窗」的动态路径，避免把预置等待误当成新事件。
  const [waitingEvent, setWaitingEvent] = useState(false)
  useEffect(() => {
    setWaitingEvent(false)
    if (notify !== "waiting") return
    const timer = window.setTimeout(() => setWaitingEvent(true), 600)
    return () => window.clearTimeout(timer)
  }, [notify, fixture?.id])
  const noticeState = useNoticeSnapshot()
  const fake = useMemo(() => {
    if (!fixture) return null
    const derived = liveRelayOf(fixture, { mobile: variant === "phone" })
    // dev-only 通知信号：真实产品由 useRelay 消费真实回合 / 真实 dialog。
    const turnEnd =
      notify === "done" || notify === "error"
        ? { turnEnd: { seq: 1, at: fixture.now, roomId: derived.roomId ?? fixture.relay.roomId ?? "", error: notify === "error" } }
        : {}
    const waiting =
      notify === "waiting" && waitingEvent
        ? { uiPrompt: { kind: "confirm", title: "等你确认（画廊受控事件）", startedAt: fixture.now } }
        : {}
    return makeFakeRelay({ ...derived, ...turnEnd, ...waiting })
  }, [fixture, variant, notify, waitingEvent])
  // 可交互时的草稿（null = 还没打过字，用 fixture 的）；静态对图不碰它
  const [draft, setDraft] = useState<string | null>(null)
  const [devicePick, setDevicePick] = useState<string | null>(null)
  /** 画廊里模拟 selectDevice：改 selectedDeviceId / selectedDevice，保持 fixture 其它字段不动 */
  const selectDevice = useCallback((id: string) => {
    setDevicePick(id)
  }, [])
  const noticeOverrides = interactive
    ? {
        notices: noticeState.visible,
        noticeQueue: noticeState.queue.length,
        pushNotice: noticeStore.push,
        dismissNotice: noticeStore.dismiss,
        pauseNotice: noticeStore.pause,
        resumeNotice: noticeStore.resume,
      }
    : null
  return useMemo(() => {
    if (!fake || !fixture) return fake
    const selectedDeviceId = devicePick ?? fake.selectedDeviceId
    const selectedDevice = fake.devices.find((device) => device.id === selectedDeviceId) ?? fake.selectedDevice
    const withDevice = { ...fake, selectedDeviceId, selectedDevice, selectDevice }
    if (!interactive) return withDevice
    const withNotices = noticeOverrides ? { ...withDevice, ...noticeOverrides } : withDevice
    if (draft === null) return { ...withNotices, setDraft }
    const composer = liveRelayOf({ ...fixture, relay: { ...fixture.relay, draft } }, { mobile: variant === "phone" }).composer ?? fake.composer
    return { ...withNotices, draft, setDraft, composer }
  }, [fixture, fake, interactive, draft, variant, devicePick, selectDevice, noticeOverrides])
}

function LiveMissing({ id, ui }: { id: string; ui?: string | null }) {
  return (
    <div data-pi-missing="" className="p-8 text-(--cw-text-2)">
      <p className="mt-0 font-semibold">
        #/live/{id}：没有这个 fixture，或参数不对（vp = {PI_VIEWPORTS.join(" | ")} | device；theme = {PI_THEMES.join(" | ")}
        {ui != null ? `；ui = ${ui} 不是 cursor / claude / codex` : ""}）。可用：
        {[...BY_ID.keys()].sort().join("、")}
      </p>
      <a className="text-(--cw-link) underline" href="#/pi">
        回索引
      </a>
    </div>
  )
}

/**
 * live 路由的 mock 注入（P4.2，与 #/p4 同口径）：hash 内 `&caps=all|csv|none`。
 * 生产入口不 import 本文件；卸载时清掉 mock 避免路由间泄漏。
 */
export function useLiveCaps(caps: string | null | undefined): void {
  useEffect(() => {
    const raw = caps?.trim()
    // 无 API 参数：保留 dev 入口的 auto-install（query ?caps= / localStorage flag），不要清掉
    if (!raw) return
    if (raw === "none" || raw === "off") {
      uninstallPiUiExtensionMock()
      return () => {
        uninstallPiUiExtensionMock()
      }
    }
    const parsed = parsePiUiMockCaps(raw)
    if (parsed && parsed.length) installPiUiExtensionMock({ caps: parsed, mode: "simulated", source: "url" })
    else uninstallPiUiExtensionMock()
    return () => {
      uninstallPiUiExtensionMock()
    }
  }, [caps])
}

export function LiveRoute(props: { id: string; vp: string | null; theme: string | null; ui?: string | null; interactive?: boolean; caps?: string | null }) {
  return props.vp === "device" ? <LiveDeviceRoute id={props.id} theme={props.theme} ui={props.ui ?? null} caps={props.caps ?? null} /> : <LiveStageRoute {...props} ui={props.ui ?? null} caps={props.caps ?? null} />
}

function LiveStageRoute({ id, vp, theme, ui, interactive = false, caps = null }: { id: string; vp: string | null; theme: string | null; ui: string | null; interactive?: boolean; caps?: string | null }) {
  useLiveCaps(caps)
  const fixture = BY_ID.get(id)
  const viewport = (vp ?? "1440x900") as PiStageSize
  const layout = piLayoutOf(viewport)
  const th = (theme ?? "light") as PiTheme
  const uiVariant: PiUiVariant = piUiVariantOf(ui)
  const ok = !!fixture && (PI_VIEWPORTS as string[]).includes(viewport) && (PI_THEMES as string[]).includes(th) && (ui == null || isPiUiVariant(ui))
  const variant: PiVariant = layout
  const keyboard = ok && !!findPiScreen(id)?.meta.keyboard && variant === "phone"
  const relay = useLiveRelay(fixture, variant, interactive)
  const [uiState, act] = usePiUiState({ seed: liveSeedWithDevPrefs(id, variant, uiVariant), persist: false })
  const ready = useReady()
  useStageHtml(ok, viewport, th, keyboard)
  if (!ok || !fixture || !relay) return <LiveMissing id={id} ui={ui} />
  const size = PI_STAGE[viewport]
  const variantDef = piVariantDefOf(uiVariant)
  const Variant = variantDef.Component
  const variantApp: VariantAppProps = { relay, ui: uiState, act, keyboardOpen: keyboard, theme: th, layout: variant }
  const body = (
    <PiNowProvider now={fixture.now}>
      <PiAppBody relay={relay} ui={uiState} act={act} variant={variant} keyboardOpen={keyboard} theme={th} />
    </PiNowProvider>
  )
  return (
    <PiSettingsHost
      relay={relay}
      ui={uiState}
      act={act}
      keyboardOpen={keyboard}
      notifications={interactive}
      shortcuts={interactive}
      defaultDevice={interactive}
    >
      <div
        data-pi-stage={id}
        data-pi-ui={uiVariant}
        data-pi-live={interactive ? "interactive" : ""}
        data-p4-caps={caps ?? "none"}
        data-pi-layout={layout}
        data-pi-theme={th}
        data-pi-keyboard={keyboard ? "" : undefined}
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
            ...stageVars(viewport, keyboard),
          } as CSSProperties
        }
      >
        <ErrorBoundary where={`live:${id}`}>
          {uiVariant === "cursor" ? (
            <PiRoot viewport={layout} theme={th} keyboard={keyboard}>
              {interactive ? <PiLayerProvider>{body}</PiLayerProvider> : <PiStaticProvider>{body}</PiStaticProvider>}
            </PiRoot>
          ) : (
            <Suspense fallback={<PiVariantLoading variant={uiVariant} />}>
              <PiNowProvider now={fixture.now}>
                <Variant {...variantApp} />
              </PiNowProvider>
            </Suspense>
          )}
        </ErrorBoundary>
        {keyboard ? <KeyboardPlaceholder viewport={viewport} theme={th} /> : null}
      </div>
    </PiSettingsHost>
  )
}

/**
 * 设备模式（vp=device，P6）：外层只是一个不占位的标记盒（data-pi-stage / data-pi-ready 照旧，ui-device 的就绪选择器不用改）；
 * 不设 contain、不挂舞台变量，PiRoot（产品模式，fixed）直接铺满窗口。桌面 / 手机随窗口宽度切换（≥ 1024 桌面）。
 */
function LiveDeviceRoute({ id, theme, ui, caps = null }: { id: string; theme: string | null; ui: string | null; caps?: string | null }) {
  useLiveCaps(caps)
  const fixture = BY_ID.get(id)
  const th = (theme ?? "light") as PiTheme
  const uiVariant: PiUiVariant = piUiVariantOf(ui)
  const ok = !!fixture && (PI_THEMES as string[]).includes(th) && (ui == null || isPiUiVariant(ui))
  const device = usePiDevice()
  const variant: PiVariant = device.desktop ? "desktop" : "phone"
  const relay = useLiveRelay(fixture, variant, true)
  const [uiState, act] = usePiUiState({ seed: liveSeedWithDevPrefs(id, variant, uiVariant), persist: false })
  const ready = useReady()
  if (!ok || !fixture || !relay) return <LiveMissing id={id} ui={ui} />
  const variantDef = piVariantDefOf(uiVariant)
  const Variant = variantDef.Component
  const variantApp: VariantAppProps = {
    relay,
    ui: uiState,
    act,
    keyboardOpen: device.frame.keyboard,
    theme: th,
    layout: variant,
    device: device.frame,
  }
  return (
    <PiSettingsHost relay={relay} ui={uiState} act={act} keyboardOpen={device.frame.keyboard}>
      <div
        data-pi-stage={id}
        data-pi-ui={uiVariant}
        data-pi-live="device"
        data-p4-caps={caps ?? "none"}
        data-pi-device-mode=""
        data-pi-layout={device.viewport}
        data-pi-theme={th}
        data-pi-ready={ready ? "" : undefined}
        data-frame-ready={ready ? "" : undefined}
      >
        <ErrorBoundary where={`live:${id}`}>
          {uiVariant === "cursor" ? (
            <PiRoot viewport={device.viewport} theme={th} device={device.frame}>
              <PiLayerProvider>
                <PiNowProvider now={fixture.now}>
                  <PiAppBody relay={relay} ui={uiState} act={act} variant={variant} keyboardOpen={device.frame.keyboard} theme={th} />
                </PiNowProvider>
              </PiLayerProvider>
            </PiRoot>
          ) : (
            <Suspense fallback={<PiVariantLoading variant={uiVariant} />}>
              <PiNowProvider now={fixture.now}>
                <Variant {...variantApp} />
              </PiNowProvider>
            </Suspense>
          )}
        </ErrorBoundary>
      </div>
    </PiSettingsHost>
  )
}
