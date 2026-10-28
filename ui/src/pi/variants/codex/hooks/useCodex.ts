import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { VariantAppProps } from "@/pi/variants/types"

/** 时钟：复用白名单 hook @/pi/hooks/useNow（画廊 PiNowProvider 钉在 fixture.now，产品按 intervalMs 走） */
export { useNow } from "@/pi/hooks/useNow"

/** 对话贴底：内容变高时若此前贴底就继续贴底；上滑后脱离，返回 atBottom / scrollToBottom */
export function useStickToBottom(ref: RefObject<HTMLDivElement | null>) {
  const [atBottom, setAtBottom] = useState(true)
  const stick = useRef(true)
  const read = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stick.current = next
    setAtBottom((prev) => (prev === next ? prev : next))
  }, [ref])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener("scroll", read, { passive: true })
    return () => el.removeEventListener("scroll", read)
  }, [ref, read])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  const scrollToBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    stick.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [ref])
  return { atBottom, scrollToBottom }
}

/** 只读设备命令（换 key 重跑；卸载后晚到的回包丢掉；参数刚变按加载中算） */
export type CodexCommandPhase = "idle" | "loading" | "error" | "ready"

export function useCodexCommand(run: VariantAppProps["relay"]["runCommand"], command: string | null, args?: Record<string, unknown>, key = "") {
  const [state, setState] = useState<{ phase: CodexCommandPhase; data: unknown; error: string; sig: string }>({
    phase: command ? "loading" : "idle",
    data: undefined,
    error: "",
    sig: "",
  })
  const [nonce, setNonce] = useState(0)
  const sig = `${command ?? ""}|${args ? JSON.stringify(args) : ""}|${key}|${nonce}`
  useEffect(() => {
    if (!command) return
    let alive = true
    const current = sig
    run(command, args).then(
      (data: unknown) => {
        if (alive) setState({ phase: "ready", data, error: "", sig: current })
      },
      (error: unknown) => {
        if (alive) setState({ phase: "error", data: undefined, error: error instanceof Error ? error.message : "命令失败", sig: current })
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  if (!command) return { phase: "idle" as CodexCommandPhase, data: undefined as unknown, error: "", reload }
  if (state.sig !== sig) return { phase: "loading" as CodexCommandPhase, data: undefined as unknown, error: "", reload }
  return { ...state, reload }
}

/** 点浮层外 / Esc 关闭（舞台态不挂） */
export function useCloseOnOutside(active: boolean, ref: RefObject<HTMLElement | null>, close: () => void, stage: boolean) {
  useEffect(() => {
    if (!active || stage) return
    const onDown = (event: PointerEvent) => {
      const el = ref.current
      if (el && event.target instanceof Node && el.contains(event.target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [active, ref, close, stage])
}

/** 复制（返回是否成功；不落盘任何东西） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 本变体自己的浮层 id（不依赖 a/c 线的 PI_UI_IDS） */
export const CX_OVERLAY = {
  sessionMenu: "codex:session-menu",
  delete: "codex:delete",
  rename: "codex:rename",
  pairing: "codex:pairing",
  displayOptions: "codex:display-options",
} as const

/** S2 慢 ack（>200ms 才算「发送中…」） */
export function useSlowAck(state: string): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (state !== "S2") {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 200)
    return () => window.clearTimeout(timer)
  }, [state])
  return slow
}
