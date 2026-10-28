/** 标签页角标：页面失焦/隐藏时的完成角标，以及「等你回答」的常驻提示。
 *  提示音是独立模块（sound.ts），与完成角标共用同一 turnEnd 信号与 pageAway 定义。
 *
 *  完成 = 「● 」+ 蓝点；出错结束 = 「! 」+ 红圈白色 !；等你回答 = 「? 」+ 蓝圈白色 ?（P9 修复线 W，review-1 P2-2）。
 *  标题的「? 」前缀由 usePageTitle 负责（它先写标题），本 hook 在有 waiting 时只画 favicon、不碰标题，
 *  避免 MutationObserver 叠出「? ?」/「? ●」；其它标题先去掉已知前缀再叠加，避免「● ●」。
 *  favicon 用原始 SVG 内联后画角标，恢复时写回原 href，不依赖重新请求。
 *
 *  纯逻辑（角标形状 / 标题前缀 / 优先级）在 ./badgeMarks.ts，零依赖、node --test 直接加载。
 */

import { useEffect, useRef, useState } from "react"
import {
  BADGE_COLOR,
  badgeKindOf,
  badgeTitle,
  completionBadgeSvg,
  stripTitleMark,
  svgDataUri,
  type CompletionBadgeKind,
} from "./badgeMarks"

export * from "./badgeMarks"

export type BadgeRelay = {
  roomId: string
  turnEnd: {
    seq: number
    at: number
    roomId: string
    error: boolean
  } | null
}

/** 页面不在场：标签隐藏，或窗口已失焦。与角标/提示音共用同一口径。 */
export function pageAway(): boolean {
  if (typeof document === "undefined") return false
  if (document.visibilityState === "hidden") return true
  return typeof document.hasFocus === "function" && !document.hasFocus()
}

function faviconLink(): HTMLLinkElement | null {
  return (document.getElementById("app-favicon") as HTMLLinkElement | null) ?? null
}

/** 原始 href / SVG 源只在第一次上角标时抓一次；之后恢复都写回这份原件。 */
let originalFaviconHref: string | null = null
let originalFaviconSource: Promise<string> | null = null
let faviconToken = 0

function rememberFavicon(link: HTMLLinkElement) {
  if (originalFaviconHref !== null) return
  const href = link.getAttribute("href") || link.href || "/favicon.svg"
  originalFaviconHref = href
  originalFaviconSource = fetch(link.href || href)
    .then((response) => (response.ok ? response.text() : ""))
    .catch(() => "")
}

function paintFavicon(kind: CompletionBadgeKind) {
  const link = faviconLink()
  if (!link) return
  rememberFavicon(link)
  const token = ++faviconToken
  const source = originalFaviconSource
  if (!source) return
  void source.then((svg) => {
    // 期间已经恢复或切换了角标：丢弃这次异步结果
    if (token !== faviconToken) return
    if (!svg || !link.isConnected) return
    link.setAttribute("type", "image/svg+xml")
    link.setAttribute("href", svgDataUri(completionBadgeSvg(svg, kind, BADGE_COLOR[kind])))
  })
}

function restoreFavicon() {
  faviconToken += 1
  const link = faviconLink()
  if (!link || originalFaviconHref === null) return
  link.setAttribute("href", originalFaviconHref)
  link.setAttribute("type", "image/svg+xml")
}

/**
 * 标签页角标 hook。必须在 usePageTitle 之后调用：页面标题由 usePageTitle 先写，
 * 这里在它之上加/去标记，并用 MutationObserver 兜住它后续的标题变化。
 *
 *  - 完成角标：页面失焦或隐藏时才生效；可见且重新聚焦后清除；turnEnd 每条只消费一次；
 *  - 等你回答（waiting > 0）：**常驻**（不分页面焦点）在 favicon 上画蓝圈问号，压过完成/出错角标；
 *    标题前缀由 usePageTitle 写「? 」，本 hook 不碰标题，避免重复前缀；
 *  - 已经处于角标状态时又完成一回合：成功/错误互相覆盖，不叠加。
 *
 * @param waiting attentionItemsOf 里 kind==="waiting" 的条数（含别房 waiting / waitingPrompt）
 */
export interface UseCompletionBadgeOptions {
  /** 总开关（设置 › 通知「标签页未读角标」）。false = 不画 favicon、不写完成标题。 */
  enabled?: boolean
  /** 等待你确认时（?" 角标）。 */
  waitingEnabled?: boolean
  /** 任务完成时。 */
  doneEnabled?: boolean
  /** 出错时。 */
  errorEnabled?: boolean
  /** true = 仅当页面不在场；false = 总是提醒（页面在场也点亮，下一次交互 / 聚焦时清除）。 */
  onlyWhenAway?: boolean
}

export function useCompletionBadge(relay: BadgeRelay, waiting = 0, options: UseCompletionBadgeOptions = {}) {
  const { enabled = true, waitingEnabled = true, doneEnabled = true, errorEnabled = true, onlyWhenAway = true } = options
  const [away, setAway] = useState(pageAway)
  const [completionKind, setCompletionKind] = useState<Exclude<CompletionBadgeKind, "waiting"> | null>(null)
  const consumedRef = useRef(0)
  const activeRef = useRef<CompletionBadgeKind | null>(null)
  const baseTitleRef = useRef("")
  /** 最后一次由本 hook 写进 document.title 的完整字符串：恢复时只覆盖自己写的那一版。 */
  const lastAppliedRef = useRef("")

  useEffect(() => {
    const update = () => setAway(pageAway())
    document.addEventListener("visibilitychange", update)
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
    }
  }, [])

  const signal = relay.turnEnd && relay.turnEnd.roomId === relay.roomId ? relay.turnEnd : null

  // 完成信号的状态机放在 effect 里（不在渲染期读 ref）：
  // 失焦/隐藏时点亮；可见时消费掉这一次信号，之后重新失焦不会弹旧角标。
  // P13：「总是提醒」时页面在场也点亮，并当场消费；偏好关闭 / 事件类型关闭则静默消费。
  useEffect(() => {
    if (!signal) {
      setCompletionKind(null)
      return
    }
    if (signal.seq === consumedRef.current) return
    const eventEnabled = signal.error ? errorEnabled : doneEnabled
    const visible = enabled && eventEnabled && (away || !onlyWhenAway)
    if (!visible) {
      consumedRef.current = signal.seq
      setCompletionKind(null)
      return
    }
    setCompletionKind(signal.error ? "error" : "done")
    if (!away) consumedRef.current = signal.seq
  }, [signal, away, enabled, doneEnabled, errorEnabled, onlyWhenAway])

  // 「总是提醒」在页面在场时点亮的角标：下一次点击 / 按键 / 聚焦就清掉（已经看到了）。
  useEffect(() => {
    if (!completionKind || away || onlyWhenAway) return
    const clear = () => setCompletionKind(null)
    window.addEventListener("pointerdown", clear)
    window.addEventListener("keydown", clear)
    window.addEventListener("focus", clear)
    return () => {
      window.removeEventListener("pointerdown", clear)
      window.removeEventListener("keydown", clear)
      window.removeEventListener("focus", clear)
    }
  }, [completionKind, away, onlyWhenAway])

  // 实际角标形态：有 waiting 时恒为 waiting（优先级最高），否则用完成/出错角标的原行为。
  const waitingCount = enabled && waitingEnabled ? waiting : 0
  const kind = badgeKindOf({ waiting: waitingCount, completion: completionKind })

  useEffect(() => {
    if (kind) {
      if (activeRef.current !== kind) {
        // 从干净标题重新取基准：usePageTitle 可能刚写进 ● / ✓ / ? 前缀
        baseTitleRef.current = stripTitleMark(document.title) || "pi"
        paintFavicon(kind)
      }
      activeRef.current = kind
      if (kind === "waiting") {
        // 「? 」前缀由 usePageTitle 负责（它在前面先写）：这里不碰标题，避免「? ?」/「? ●」重复前缀
        lastAppliedRef.current = ""
        return
      }
      const desired = badgeTitle(baseTitleRef.current, kind)
      if (document.title !== desired) {
        document.title = desired
        lastAppliedRef.current = desired
      }
      return
    }
    if (activeRef.current) {
      activeRef.current = null
      const current = document.title
      // 角标还在时 usePageTitle 可能已换成新会话标题：只覆盖自己最后写的那一版，
      // 别把新标题回写成旧房间名。标题已经不是自己写的就原样保留（含新的忙碌标记 / ? 前缀）。
      if (lastAppliedRef.current && current === lastAppliedRef.current) {
        document.title = baseTitleRef.current || stripTitleMark(current) || "pi"
      }
      lastAppliedRef.current = ""
      restoreFavicon()
    }
  }, [kind])

  // usePageTitle 在 busy / waiting 变化时还会重写标题；完成角标生效期间以干净标题为基准重新叠。
  // waiting 期间不观察（标题由 usePageTitle 独占，避免叠加）。
  useEffect(() => {
    if (!kind || kind === "waiting") return
    const titleEl = document.querySelector("title")
    if (!titleEl) return
    const apply = () => {
      const clean = stripTitleMark(document.title)
      if (clean) baseTitleRef.current = clean
      const desired = badgeTitle(baseTitleRef.current, kind)
      if (document.title !== desired) {
        document.title = desired
        lastAppliedRef.current = desired
      }
    }
    const observer = new MutationObserver(apply)
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true })
    apply()
    return () => observer.disconnect()
  }, [kind])

  useEffect(
    () => () => {
      activeRef.current = null
      restoreFavicon()
    },
    [],
  )
}
