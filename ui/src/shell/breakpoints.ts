/**
 * 第 2 章断点：与 design-tokens.css 的 --bp-* 同值（test/shell.test.mjs 会比对两份）。
 *
 * P11 起布局断点 = **768**（设计册：≤767 移动 / ≥768 桌面）；`bpOf` 的 768/1024/1280…
 * 档位保留用于调宽/弹窗等细分。旧手机页/旧 mobile model 的 1023 常量不再代表产品布局。
 */
import { useCallback, useSyncExternalStore } from "react"

export const BREAKPOINTS = [768, 1024, 1280, 1600, 1920] as const

export type Breakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "2xl"
export type DesktopBreakpoint = Extract<Breakpoint, "md" | "lg" | "xl" | "2xl">

export function bpOf(width: number): Breakpoint {
  if (width < 768) return "xs"
  if (width < 1024) return "sm"
  if (width < 1280) return "md"
  if (width < 1600) return "lg"
  if (width < 1920) return "xl"
  return "2xl"
}

/** P11 产品布局断点：≥768 桌面、≤767 移动（设计册口径；供测试/文档引用）。 */
export const PI_LAYOUT_BREAKPOINT = 768

/** 桌面壳的最小服务宽度：768（P11 起；原 1024 已按设计册迁移）。 */
export function isDesktop(width: number): boolean {
  return width >= PI_LAYOUT_BREAKPOINT
}

export function isDesktopBreakpoint(bp: Breakpoint): bp is DesktopBreakpoint {
  return bp === "md" || bp === "lg" || bp === "xl" || bp === "2xl"
}

const WIDTH_SUBSCRIBE = (listener: () => void) => {
  window.addEventListener("resize", listener)
  return () => window.removeEventListener("resize", listener)
}

const COMPACT_HEIGHT_QUERY = "(max-height: 559px)"

const HEIGHT_SUBSCRIBE = (listener: () => void) => {
  const query = window.matchMedia(COMPACT_HEIGHT_QUERY)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

/**
 * 视口宽度 + 紧凑高度（<560px）。宽度用视口宽度（含滚动条），与 matchMedia
 * 的宽度断点同一口径；高度用一条 matchMedia，避免每次 resize 都触发两次订阅。
 */
export function useViewport(): { width: number; bp: Breakpoint; desktop: boolean; compactHeight: boolean } {
  const width = useSyncExternalStore(
    WIDTH_SUBSCRIBE,
    () => window.innerWidth,
    () => 1280,
  )
  const compactHeight = useSyncExternalStore(
    HEIGHT_SUBSCRIBE,
    () => window.matchMedia(COMPACT_HEIGHT_QUERY).matches,
    () => false,
  )
  const bp = bpOf(width)
  return { width, bp, desktop: isDesktop(width), compactHeight }
}

/** 只关心“现在是不是桌面壳”时用，比 useViewport 少一次高度订阅。 */
export function useDesktop(): boolean {
  const desktop = useSyncExternalStore(
    WIDTH_SUBSCRIBE,
    () => isDesktop(window.innerWidth),
    () => true,
  )
  return desktop
}

/** 一段只依赖宽度的派生值；依赖变化时重新取快照。 */
export function useWidthValue<T>(read: (width: number) => T): T {
  const getSnapshot = useCallback(() => read(window.innerWidth), [read])
  return useSyncExternalStore(WIDTH_SUBSCRIBE, getSnapshot, () => read(1280))
}
