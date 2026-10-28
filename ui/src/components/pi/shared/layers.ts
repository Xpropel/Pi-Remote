import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { MenuKind } from "@/components/kit"
import { createPiLayerStore, PI_LAYERS_EMPTY, type PiLayerKind, type PiLayerSnapshot, type PiLayerStore } from "@/pi/model/layers"

/*
 * P4 交互层的共享契约（R2/p4-lanes.md §1）。只放逻辑、context 和 hook（不写 JSX，免得和部件文件混在一起）：
 *   1. 静态态：部件的 `static` prop 优先；没传时取 PiStaticContext（开发画廊的舞台给整屏提供 true，产品和可交互路由不提供 = false）。
 *      静态态下部件必须和冻结版逐像素一致：不接 Radix、不 portal、不挂监听、不抢焦点。
 *   2. 受控 open：`open` 给了就受控，没给就由部件自己管（usePiControllableOpen）；状态变化一律经 onOpenChange 通知。
 *   3. 浮层登记：可交互的菜单 / 浮层打开时 usePiLayer 登记，外壳（usePiShellShortcuts）据此拼 Esc 分层与 ⌘ 快捷键的开关。
 *   4. 模态的背后：usePiInertOthers 给浮层以外的兄弟节点（沿祖先一路到 body）加 inert（design §4.7「背后加 inert」）。
 *   5. 焦点：打开时进 piInitialFocusOf 选出的元素，关闭后回触发元素；触发元素已不在页面上时回 [data-pi-focus-fallback]（顶栏标题）。
 *   6. 菜单行为层：PiMenu 里的菜单内容用 usePiMenuSurface() 拿 kit MenuSurface 的 kind（dropdown / context），其余为 static。
 */

/* ======================= 1. 静态态 ======================= */

const PiStaticContext = createContext(false)

/** 整棵子树的部件默认按静态态渲染（开发画廊的舞台用）；value = false 可在静态子树里局部恢复可交互 */
export function PiStaticProvider({ value = true, children }: { value?: boolean; children?: ReactNode }) {
  return createElement(PiStaticContext.Provider, { value }, children)
}

/** 部件是否按静态态渲染：显式 prop 优先，否则取 context（默认 false = 可交互） */
export function usePiStatic(explicit?: boolean): boolean {
  const fromContext = useContext(PiStaticContext)
  return explicit ?? fromContext
}

/** 所有浮层部件共用的三个 prop（P4 契约） */
export interface PiOverlayControl {
  /** 受控的打开状态；不传 = 部件自己管（PiSheet / PiDialog 不传时按"渲染即打开"） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** true = 静态态（画廊截图）：和冻结版逐像素一致，不可交互。不传时取 PiStaticContext */
  static?: boolean
}

/* ======================= 2. 受控 / 非受控 ======================= */

/** open 给了就受控；没给就用内部状态（初值 defaultOpen）。返回的 setter 两种情况都会调 onOpenChange */
export function usePiControllableOpen(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
  defaultOpen = false,
): [boolean, (next: boolean) => void] {
  const [inner, setInner] = useState(defaultOpen)
  const controlled = open !== undefined
  const onChange = useRef(onOpenChange)
  useLayoutEffect(() => {
    onChange.current = onOpenChange
  })
  const set = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next)
      onChange.current?.(next)
    },
    [controlled],
  )
  return [controlled ? open : inner, set]
}

/* ======================= 3. 浮层登记 ======================= */

const PiLayerContext = createContext<PiLayerStore | null>(null)

/** 外壳根上放一个；没有 provider 时 usePiLayer 什么都不做、usePiLayerState 恒为空 */
export function PiLayerProvider({ children }: { children?: ReactNode }) {
  const [store] = useState(createPiLayerStore)
  return createElement(PiLayerContext.Provider, { value: store }, children)
}

/** active 期间登记一层；close 是 Esc 落到这一层时的关闭函数（总是调用最新传入的那个） */
export function usePiLayer(active: boolean, kind: PiLayerKind, close?: () => void): void {
  const store = useContext(PiLayerContext)
  const latest = useRef(close)
  useLayoutEffect(() => {
    latest.current = close
  })
  const hasClose = close != null
  useEffect(() => {
    if (!store || !active) return
    const handle = store.open(kind, hasClose ? () => latest.current?.() : undefined)
    return () => handle.dispose()
  }, [store, active, kind, hasClose])
}

const noSubscribe = () => () => {}
const emptySnapshot = () => PI_LAYERS_EMPTY

export interface PiLayerState extends PiLayerSnapshot {
  /** 关掉 kind 类里最后打开的一层；返回是否关了 */
  closeTop: (kind: PiLayerKind) => boolean
}

/** 外壳读：现在有没有菜单 / 浮层开着，以及按层关闭 */
export function usePiLayerState(): PiLayerState {
  const store = useContext(PiLayerContext)
  const snapshot = useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getSnapshot : emptySnapshot, emptySnapshot)
  const closeTop = useCallback((kind: PiLayerKind) => store?.closeTop(kind) ?? false, [store])
  return { ...snapshot, closeTop }
}

/* ======================= 4. 模态背后加 inert ======================= */

/** 不动的节点：脚本样式类、Radix 的焦点哨兵（FocusScope 靠它们把焦点圈在浮层里） */
function keepLive(el: Element): boolean {
  const tag = el.tagName
  return tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "TEMPLATE" || tag === "NOSCRIPT" || el.hasAttribute("data-radix-focus-guard")
}

/** 每个节点被几层模态设了 inert（嵌套模态各自恢复，最后一层关掉才去掉） */
const inertCount = new WeakMap<Element, number>()

/**
 * 给 target 以外的兄弟节点加 inert：从 target 往上，每一级的兄弟都加，直到 boundary（默认 body）。
 * 原本就有 inert、不是这里加的节点不碰。返回恢复函数。
 */
export function piInertOthers(target: Element, boundary: Element = target.ownerDocument.body): () => void {
  const marked: Element[] = []
  let node: Element = target
  while (node !== boundary && node.parentElement) {
    const parent: Element = node.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || keepLive(sibling)) continue
      const n = inertCount.get(sibling) ?? 0
      if (n === 0) {
        if (sibling.hasAttribute("inert")) continue
        sibling.setAttribute("inert", "")
      }
      inertCount.set(sibling, n + 1)
      marked.push(sibling)
    }
    node = parent
  }
  return () => {
    for (const el of marked) {
      const n = (inertCount.get(el) ?? 1) - 1
      if (n > 0) {
        inertCount.set(el, n)
      } else {
        inertCount.delete(el)
        el.removeAttribute("inert")
      }
    }
  }
}

/**
 * active 期间给浮层根加"背后 inert"。传元素本身（用 useState 的 setter 当 callback ref）：
 * Radix Portal 要等挂载后的下一次渲染才把内容放进 body，ref 对象拿不到这个时机。
 */
export function usePiInertOthers(el: Element | null, active: boolean): void {
  useEffect(() => {
    if (!active || !el) return
    return piInertOthers(el)
  }, [el, active])
}

/* ======================= 5. 焦点 ======================= */

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'
const TEXT_INPUT = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), [contenteditable="true"]'

const shown = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest("[inert]")
const first = (root: HTMLElement, selector: string, skip?: (el: HTMLElement) => boolean) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => shown(el) && !skip?.(el)) ?? null

/**
 * 浮层打开时焦点进哪（design §4.7 焦点表）：
 *   [data-pi-autofocus]（调用方点名，如危险确认弹窗的"取消"）→ 第一个输入框 →（弹窗）主按钮 [data-pi-primary]
 *   → 第一个可聚焦元素（弹窗的 × 排到最后）→ null（调用方退回浮层容器本身）
 */
export function piInitialFocusOf(root: HTMLElement, kind: "dialog" | "sheet"): HTMLElement | null {
  const isClose = (el: HTMLElement) => el.hasAttribute("data-pi-dialog-close")
  return (
    first(root, "[data-pi-autofocus]") ??
    first(root, TEXT_INPUT) ??
    (kind === "dialog" ? first(root, "[data-pi-primary]:not([disabled])") : null) ??
    first(root, TABBABLE, isClose) ??
    first(root, "[data-pi-dialog-close]")
  )
}

/** 触发元素已不在页面上时焦点的去处：顶栏标题（PiTopBar 标了 [data-pi-focus-fallback]） */
export function piFocusFallback(doc: Document = document): HTMLElement | null {
  return Array.from(doc.querySelectorAll<HTMLElement>("[data-pi-focus-fallback]")).find(shown) ?? null
}

/** 关闭后焦点回哪：元素，或者打开时才算得出来的元素 */
export type PiReturnFocus = HTMLElement | null | (() => HTMLElement | null)

const usable = (el: HTMLElement | null | undefined): el is HTMLElement => !!el && el.isConnected && !el.closest("[inert]")

/**
 * PiOverlay（PiDialog / PiSheet / 命令面板 / 灯箱）的焦点进出（Radix Dialog 的 onOpenAutoFocus / onCloseAutoFocus）：
 * 打开前记下当时的焦点元素（触发元素）；打开时按 piInitialFocusOf 进（kind = content 时进容器本身）；关闭时回 returnFocus → 记下的元素 → piFocusFallback。
 * 受控打开、没有 Radix Trigger 时 Radix 自己找不到触发元素，所以这里接管。
 */
export function usePiDialogFocus(open: boolean, kind: "dialog" | "sheet" | "content", returnFocus?: PiReturnFocus) {
  const contentRef = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const returnTo = useRef(returnFocus)
  const isOpen = useRef(open)
  useLayoutEffect(() => {
    returnTo.current = returnFocus
    isOpen.current = open
  })
  // 父组件直接卸掉浮层（没先把 open 置 false）时也要能归还焦点
  useLayoutEffect(
    () => () => {
      isOpen.current = false
    },
    [],
  )
  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !contentRef.current?.contains(active)) opener.current = active
  }, [open])
  const onOpenAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault()
      const root = contentRef.current
      if (!root) return
      // content：焦点落在浮层容器本身（灯箱，design §4.7 焦点表）；其余按 piInitialFocusOf，找不到也落在容器上
      ;((kind === "content" ? null : piInitialFocusOf(root, kind)) ?? root).focus({ preventScroll: true })
    },
    [kind],
  )
  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
    // Radix FocusScope 的卸载回调在 setTimeout 里发；开发模式 StrictMode 的模拟卸载会在浮层仍开着时触发它，这时不动焦点
    if (isOpen.current) return
    const given = returnTo.current
    const explicit = typeof given === "function" ? given() : given
    const target = [explicit, opener.current].find(usable) ?? piFocusFallback()
    opener.current = null
    target?.focus({ preventScroll: true })
  }, [])
  return { contentRef, onOpenAutoFocus, onCloseAutoFocus }
}

/* ======================= 6. 菜单行为层 ======================= */

/** 菜单内容拿到的行为层：传给 kit MenuSurface（`<MenuSurface {...usePiMenuSurface()} …>`） */
export interface PiMenuSurfaceOptions {
  kind: MenuKind
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  alignOffset?: number
  /** ↑↓ 到头后绕回（PiMenu 里为 true） */
  loop?: boolean
  onCloseAutoFocus?: (event: Event) => void
}

export const PI_STATIC_SURFACE: PiMenuSurfaceOptions = Object.freeze({ kind: "static" as MenuKind })
export const PiMenuSurfaceContext = createContext<PiMenuSurfaceOptions>(PI_STATIC_SURFACE)

/** 菜单内容部件用它决定 MenuSurface 的 kind：在 PiMenu 里 = dropdown / context，其余（静态态、画廊、sheet 里的同一组项）= static */
export function usePiMenuSurface(): PiMenuSurfaceOptions {
  return useContext(PiMenuSurfaceContext)
}

/** 菜单内容自己不想当 Radix Content 时（例如嵌在别的菜单 / sheet 里的同一组项），用它把子树恢复成 static */
export function PiMenuStatic({ children }: { children?: ReactNode }) {
  return createElement(PiMenuSurfaceContext.Provider, { value: PI_STATIC_SURFACE }, children)
}
