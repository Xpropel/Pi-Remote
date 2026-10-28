import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

/**
 * Claude v2 自有 hooks / 上下文（从 primitives 拆出，保持组件文件只导出组件 —— 让 Fast Refresh 警告归零）。
 * 全部行为只服务本变体，不依赖 cursor 的任何模块。
 */

/** 每 interval 毫秒重渲染一次的时钟 */
export function useNow(interval = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(id)
  }, [interval])
  return now
}

/**
 * 滚动容器贴底：内容变高时若本来就在底部附近（或 force）就滚到底。
 */
export function useStickToBottom(deps: unknown): { atBottom: boolean; scrollToBottom: () => void; newCount: number } {
  const ref = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    setNewCount(0)
  }, [])
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom
      setAtBottom(bottom)
      if (bottom) setNewCount(0)
    }
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => measure()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [measure])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (atBottomRef.current) {
      const el = ref.current
      if (el) el.scrollTop = el.scrollHeight
    } else {
      setNewCount((n) => n + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps])
  return { atBottom, scrollToBottom, newCount }
}

/* ---------------------------------------------------------------- 菜单上下文 / Esc */

export const MenuCloseContext = createContext<() => void>(() => {})

export function useMenuClose(): () => void {
  return useContext(MenuCloseContext)
}

export function useEscClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [open, onClose])
}

/** 字标（组件的 ClaudeMark 用它） */
export const MARK_TEXT = "✳"
