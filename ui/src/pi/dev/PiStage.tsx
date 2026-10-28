import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { PiStaticProvider } from "@/components/pi/shared/layers"
import { piLayoutOf } from "@/components/pi/shared/viewport"
import { isPiUiVariant, PI_UI_VARIANT_LIST, piUiVariantOf, type PiUiVariant } from "@/pi/variants/types"
import {
  findPiScreen,
  PI_AREAS,
  PI_STAGE,
  PI_THEMES,
  PI_VIEWPORTS,
  piErrors,
  piScreens,
  type PiTheme,
  type PiStageSize,
  type RegisteredPiScreen,
} from "./registry"
import { ErrorBoundary } from "./ErrorBoundary"
import { KeyboardPlaceholder } from "./KeyboardPlaceholder"
import { LiveRoute } from "./LiveRoute"
import { PlayRoute } from "./play/PlayRoute"
import { PiDevStageFrame } from "./StageFrame"
import { P4Route } from "./p4/P4Route"
import { usagePreviewParamsOf } from "./usage/UsagePreview.tsx"
import { stageVars, useReady, useStageHtml } from "./stage"

/*
 * 开发画廊的舞台与索引（实施计划 P2.4、D7）。照 replica 的 src/app/PiRoute.tsx 写，舞台契约不变（R/pi/shell-changes.md §3–§4）：
 *   #/ 或 #/pi                                       设计屏索引（含开发屏）
 *   #/pi/<id>?vp=1440x900|390x844&theme=light|dark  一个设计屏：舞台贴在页面左上角 (0,0)，正好是该视口的 CSS 尺寸
 *   ?ui=cursor|claude|codex                          （PI-UI-REFS 架构线）变体：舞台写 data-pi-ui，屏幕经 props.ui 拿到；
 *                                                    索引页顶部有变体切换链接，链接带着当前变体
 *   #/play/<id>?vp=…&theme=…                        P4：同一批部件的可交互版（PlayRoute，R2/p4-lanes.md §4），不参加对图
 *   #/live/<id>?vp=…&theme=…[&interactive][&ui=…]    P5：真实容器树 + 假 relay（LiveRoute，plan P5.2），L2 对图；ui= 时按该变体渲染
 *                                                    （claude / codex = 各自入口组件，cursor = 现有树）
 * 另外搬了 replica 的 useReady（字体就绪 + 两帧 rAF）和 ErrorBoundary（渲染错误留 [data-render-error]），P4 起放在 ./stage。
 * 设计屏一律是静态态（P4 契约）：舞台用 PiStaticProvider 包住整屏，部件不接 Radix、不可交互，L1 像素不变。
 * replica 画廊里的章节分区、组件目录、token 页不搬。
 */

// ------------------------------------------------------------------ 路由（hash，不引 react-router）

type Route =
  | { kind: "index"; ui: string | null }
  | { kind: "pi"; id: string; vp: string | null; theme: string | null; ui: string | null }
  | { kind: "play"; id: string; vp: string | null; theme: string | null; ui: string | null }
  | { kind: "live"; id: string; vp: string | null; theme: string | null; ui: string | null; interactive: boolean; caps: string | null }
  | { kind: "p4"; id: string; vp: string | null; theme: string | null; ui: string | null; caps: string | null; fixture: string | null; model: string | null }
  | { kind: "usage"; vp: string | null; theme: string | null; host: string | null; fixture: string | null; usage: string | null; metric: string | null; view: string | null }
  | { kind: "p11"; surface: "sidebar" | "sidebar-mobile"; query: string; vp: string | null }
  | { kind: "not-found"; hash: string }

function parseHash(rawHash: string): Route {
  const hash = rawHash.replace(/^#/, "")
  const [pathPart, query = ""] = hash.split("?")
  const params = new URLSearchParams(query)
  const ui = params.get("ui")
  const parts = pathPart
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p))
  if (parts.length === 0) return { kind: "index", ui }
  if (parts[0] === "pi") {
    if (parts.length === 1) return { kind: "index", ui }
    // P11 统一侧栏 / 移动双模式预览：`#/pi/sidebar?...`、`#/pi/sidebar-mobile?...`（dev-only iframe 宿主）
    if (parts.length === 2 && (parts[1] === "sidebar" || parts[1] === "sidebar-mobile")) {
      return { kind: "p11", surface: parts[1], query, vp: params.get("vp") }
    }
    // P10「使用活动」模式 H 整窗预览：`#/pi/usage-activity?fixture=&usage=&theme=&vp=&host=&metric=&view=`
    if (parts.length === 2 && parts[1] === "usage-activity") {
      return {
        kind: "usage",
        vp: params.get("vp"),
        theme: params.get("theme"),
        host: params.get("host"),
        fixture: params.get("fixture"),
        usage: params.get("usage"),
        metric: params.get("metric"),
        view: params.get("view"),
      }
    }
    if (parts.length === 2) return { kind: "pi", id: parts[1], vp: params.get("vp"), theme: params.get("theme"), ui }
  }
  if (parts[0] === "play" && parts.length === 2) return { kind: "play", id: parts[1], vp: params.get("vp"), theme: params.get("theme"), ui }
  if (parts[0] === "live" && parts.length === 2) {
    return { kind: "live", id: parts[1], vp: params.get("vp"), theme: params.get("theme"), ui, interactive: params.has("interactive"), caps: params.get("caps") }
  }
  // P4.2 mock/验证线：`#/p4/<surface>?ui=&vp=&theme=&caps=&fixture=`（真实树 + mock provider + 场景驱动）
  if (parts[0] === "p4" && parts.length === 2) {
    return { kind: "p4", id: parts[1], vp: params.get("vp"), theme: params.get("theme"), ui, caps: params.get("caps"), fixture: params.get("fixture"), model: params.get("model") }
  }
  return { kind: "not-found", hash: rawHash }
}

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb)
  return () => window.removeEventListener("hashchange", cb)
}

function useHash() {
  return useSyncExternalStore(subscribeHash, () => window.location.hash)
}

/** 变体参数只在不是默认 cursor 时写进 URL（cursor 链接保持原来的样子） */
function uiQuery(ui: string | null | undefined): string {
  return isPiUiVariant(ui) && ui !== "cursor" ? `&ui=${ui}` : ""
}

const href = {
  piIndex: (ui?: string | null) => `#/pi${isPiUiVariant(ui) ? `?ui=${ui}` : ""}`,
  pi: (id: string, vp: string, theme: string, ui?: string | null) => `#/pi/${encodeURIComponent(id)}?vp=${vp}&theme=${theme}${uiQuery(ui)}`,
}

// ------------------------------------------------------------------ 舞台

const THEME_LABEL: Record<PiTheme, string> = { light: "浅色", dark: "深色" }

function PiMessage({ kind, children }: { kind: "missing" | "bad-param"; children: ReactNode }) {
  return (
    <div
      data-pi-missing={kind === "missing" ? "" : undefined}
      data-pi-bad-param={kind === "bad-param" ? "" : undefined}
      className="p-8 text-(--cw-text-2)"
    >
      <p className="mt-0 text-(length:--cw-text-lg) font-semibold">{children}</p>
      <p>
        <a className="text-(--cw-link) underline" href={href.piIndex()}>
          Pi-Remote 设计屏索引
        </a>
      </p>
    </div>
  )
}

/** P10：`#/pi/usage-activity` 用 iframe 装 dev 预览（独立 document，420 媒体查询按 iframe 视口生效） */
function UsageActivityRoute({ route }: { route: Extract<Route, { kind: "usage" }> }) {
  const [ready, setReady] = useState(false)
  const inner = new URLSearchParams()
  for (const key of ["fixture", "usage", "theme", "host", "metric", "view"] as const) {
    const value = route[key]
    if (value) inner.set(key, value)
  }
  const params = usagePreviewParamsOf(inner)
  const [width, height] = params.vp.split("x").map(Number)
  return (
    <div
      data-pi-usage-route=""
      data-pi-ready={ready ? "" : undefined}
      data-pi-usage-host={params.host}
      style={{ position: "relative", width, height, overflow: "hidden", background: params.theme === "light" ? "#f6f4f1" : "#0e0e10" }}
    >
      <iframe
        title="P10 usage-activity dev preview"
        src={`/src/pi/dev/usage/dev-preview.html?${inner.toString()}`}
        onLoad={() => setReady(true)}
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
      />
    </div>
  )
}

/** P11：`#/pi/sidebar` / `#/pi/sidebar-mobile` 用 iframe 装 dev 预览（独立 document，媒体查询/视口一致） */
function P11PreviewRoute({ route }: { route: Extract<Route, { kind: "p11" }> }) {
  const [ready, setReady] = useState(false)
  const base = route.surface === "sidebar" ? "/src/pi/dev/sidebar/dev-preview.html" : "/src/pi/dev/sidebar/mobile-dev-preview.html"
  const fallbackVp = route.surface === "sidebar" ? "1440x900" : "390x844"
  const vp = route.vp && /^\d{3,4}x\d{3,4}$/.test(route.vp) ? route.vp : fallbackVp
  const [width, height] = vp.split("x").map(Number)
  const src = `${base}?${route.query}`
  return (
    <div data-pi-p11-route="" data-pi-p11-surface={route.surface} data-pi-ready={ready ? "" : undefined} style={{ width, height, overflow: "hidden", background: "#101012" }}>
      <iframe title={`P11 ${route.surface} dev preview`} src={src} onLoad={() => setReady(true)} style={{ width: "100%", height: "100%", border: 0, display: "block" }} />
    </div>
  )
}

/**
 * #/pi/<id>?vp=…&theme=…：舞台贴在页面左上角 (0,0)，正好是该视口的 CSS 尺寸，超出部分裁掉（也是 fixed 定位后代的包含块）。
 * 字体就绪后设 data-pi-ready（截图脚本等它；同时设 data-frame-ready，和 replica 一样）。
 * 主题和 --cw-pi-* 变量同时挂到 <html> 上（data-pi-theme / data-pi-layout），portal 出去的弹层也能拿到。
 */
function PiStageRoute({ id, vp, theme, ui }: { id: string; vp: string | null; theme: string | null; ui: string | null }) {
  const s = findPiScreen(id)
  const viewport = (vp ?? "1440x900") as PiStageSize
  const layout = piLayoutOf(viewport)
  const th = (theme ?? "light") as PiTheme
  const uiVariant: PiUiVariant = piUiVariantOf(ui)
  const ok = !!s && (PI_VIEWPORTS as string[]).includes(viewport) && (PI_THEMES as string[]).includes(th) && (ui == null || isPiUiVariant(ui))
  const keyboard = ok && !!s?.meta.keyboard && layout === "phone"
  const ready = useReady()
  useStageHtml(ok, viewport, th, keyboard)

  if (!s) return <PiMessage kind="missing">没有 id 为 “{id}” 的 Pi-Remote 设计屏</PiMessage>
  if (!ok) {
    return (
      <PiMessage kind="bad-param">
        {id}：参数不对（vp = {PI_VIEWPORTS.join(" | ")}；theme = {PI_THEMES.join(" | ")}；ui = cursor | claude | codex）
      </PiMessage>
    )
  }
  const size = PI_STAGE[viewport]
  const { Component: Screen } = s
  return (
    <div
      data-pi-stage={id}
      data-pi-ui={uiVariant}
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
      <ErrorBoundary where={`pi:${id}`}>
        <PiStaticProvider>
          <Screen viewport={layout} theme={th} ui={uiVariant} />
        </PiStaticProvider>
      </ErrorBoundary>
      {keyboard ? <KeyboardPlaceholder viewport={viewport} theme={th} /> : null}
    </div>
  )
}

// ------------------------------------------------------------------ 索引

function ScreenLinks({ s, ui }: { s: RegisteredPiScreen; ui: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {PI_VIEWPORTS.map((vp) =>
        s.meta.themes.map((th) => (
          <a
            key={`${vp}/${th}`}
            data-gallery-pi-link={`${s.meta.id}/${vp}/${th}`}
            className="text-(--cw-link) underline"
            href={href.pi(s.meta.id, vp, th, ui)}
          >
            {vp.replace("x", "×")} · {THEME_LABEL[th]}
          </a>
        )),
      )}
    </div>
  )
}

/** #/pi：按区域分组，每屏每个视口 × 主题一个链接；开发屏（路径里有 _ 开头的段）也列出，标「开发屏」 */
function PiIndex({ ui }: { ui: string | null }) {
  const main = piScreens.filter((s) => !s.meta.hidden).length
  const dev = piScreens.length - main
  const current = piUiVariantOf(ui)
  return (
    <div data-pi-index="" className="min-h-screen bg-(--cw-bg) text-(--cw-text)">
      <header className="sticky top-0 z-10 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-(--cw-divider) bg-(--cw-bg) px-8 py-3">
        <h1 className="m-0 text-(length:--cw-text-xl) font-semibold">Pi-Remote 设计屏（开发画廊）</h1>
        {/* PI-UI-REFS 架构线：变体切换（静态屏的 ?ui= 只影响舞台 data-pi-ui 与屏幕 props.ui；整棵树的变体对图走 #/live?ui=） */}
        <div data-pi-ui-selector="" className="flex items-baseline gap-2 text-(length:--cw-text-sm)">
          <span className="text-(--cw-text-3)">变体</span>
          {PI_UI_VARIANT_LIST.map((v) => (
            <a
              key={v.id}
              data-gallery-ui-link={v.id}
              className={v.id === current ? "font-semibold text-(--cw-text) underline" : "text-(--cw-link) underline"}
              href={href.piIndex(v.id)}
            >
              {v.label}
            </a>
          ))}
        </div>
        <div className="ml-auto text-(length:--cw-text-sm) text-(--cw-text-3)">
          {main} 屏 + 开发屏 {dev} 个 · 路由 #/pi/&lt;id&gt;?vp=1440x900|390x844&amp;theme=light|dark[&amp;ui=cursor|claude|codex]
        </div>
      </header>
      <p
        data-pi-stage-note=""
        className="m-0 border-b border-(--cw-divider) bg-(--cw-chip-bg) px-8 py-2 text-(length:--cw-text-sm) text-(--cw-text-2)"
      >
        对图舞台固定 <span className="font-mono">1440×900</span> / <span className="font-mono">390×844</span>（设计规格 CSS 像素），
        <strong>非产品响应式</strong>；窗口放大时舞台居中、空白是舞台外围背景。产品 UI 是响应式的，请打开
        <a className="mx-1 text-(--cw-link) underline" href="/index.html">index.html</a>（dev server <span className="font-mono">/</span>）。
      </p>
      <main className="px-8 py-6">
        {piErrors.length ? (
          <div data-gallery-pi-errors="" className="mb-4 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-(length:--cw-text-sm)">
            <p className="m-0 font-semibold">注册问题 {piErrors.length} 个</p>
            <ul className="mb-0">
              {piErrors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono">{e.where}</span>：{e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-6">
          {PI_AREAS.map((area) => {
            const rows = piScreens.filter((s) => s.meta.area === area)
            return (
              <div key={area} data-gallery-pi-area={area}>
                <h3 className="mt-0 mb-2 text-(length:--cw-text-md) font-semibold text-(--cw-text-3)">
                  区域 {area} · {rows.filter((s) => !s.meta.hidden).length} 屏
                </h3>
                {rows.length === 0 ? (
                  <p className="m-0 text-(length:--cw-text-sm) text-(--cw-text-3)">还没有屏幕</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {rows.map((s) => (
                      <li key={s.meta.id} data-gallery-pi-screen={s.meta.id} className="grid grid-cols-[minmax(0,18rem)_1fr] gap-x-6">
                        <div>
                          <div className="text-(length:--cw-text-base) font-medium">{s.meta.title}</div>
                          <div className="font-mono text-(length:--cw-text-sm) text-(--cw-text-3)">
                            {s.meta.id}
                            {s.meta.keyboard ? " · 键盘" : ""}
                            {s.meta.hidden ? " · 开发屏（不计入 32 屏）" : ""}
                          </div>
                        </div>
                        <div className="text-(length:--cw-text-md)">
                          <ScreenLinks s={s} ui={ui} />
                          {s.meta.states.length ? (
                            <p className="mt-1 mb-0 text-(length:--cw-text-sm) text-(--cw-text-2)">状态：{s.meta.states.join("、")}</p>
                          ) : null}
                          {s.meta.notes ? <p className="mt-1 mb-0 text-(length:--cw-text-sm) text-(--cw-text-3)">{s.meta.notes}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}

/** 画廊根组件：按 hash 路由到索引或单个设计屏 */
export function PiGallery() {
  const route = parseHash(useHash())
  switch (route.kind) {
    case "index":
      return <PiIndex ui={route.ui} />
    case "pi":
      return (
        <PiDevStageFrame vp={route.vp} key={`${route.id}?${route.vp}&${route.theme}&${route.ui}`}>
          <PiStageRoute id={route.id} vp={route.vp} theme={route.theme} ui={route.ui} />
        </PiDevStageFrame>
      )
    case "p11":
      return <P11PreviewRoute route={route} />
    case "usage":
      return <UsageActivityRoute route={route} />
    case "play":
      return (
        <PiDevStageFrame vp={route.vp} key={`${route.id}?${route.vp}&${route.theme}`}>
          <PlayRoute id={route.id} vp={route.vp} theme={route.theme} />
        </PiDevStageFrame>
      )
    case "p4":
      return (
        <PiDevStageFrame vp={route.vp} key={`p4:${route.id}?${route.vp}`}>
          <P4Route
          key={`p4:${route.id}?${route.vp}&${route.theme}&${route.ui}&${route.caps}&${route.fixture}`}
          id={route.id}
          vp={route.vp}
          theme={route.theme}
          ui={route.ui}
          caps={route.caps}
          fixture={route.fixture}
            model={route.model}
          />
        </PiDevStageFrame>
      )
    case "live":
      if (route.vp === "device") {
        return (
          <LiveRoute
            key={`${route.id}?${route.vp}&${route.theme}&${route.interactive}&${route.ui}`}
            id={route.id}
            vp={route.vp}
            theme={route.theme}
            ui={route.ui}
            interactive={route.interactive}
            caps={route.caps}
          />
        )
      }
      return (
        <PiDevStageFrame vp={route.vp} key={`live:${route.id}?${route.vp}`}>
          <LiveRoute
            id={route.id}
            vp={route.vp}
            theme={route.theme}
            ui={route.ui}
            interactive={route.interactive}
            caps={route.caps}
          />
        </PiDevStageFrame>
      )
    default:
      return (
        <div className="p-8">
          未知路由 {route.hash}。
          <a className="underline" href={href.piIndex()}>
            回索引
          </a>
        </div>
      )
  }
}
