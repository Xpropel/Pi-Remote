import { useEffect, useRef, useState } from "react"
import type { ITheme, Terminal as XTerm } from "@xterm/xterm"
import "./pi-xterm.css"
import { GhostIconButton } from "@/components/kit"
import { Check, Copy, Eraser, RotateCcw, Square, Terminal } from "@/components/kit/icons"
import { piCopyText, PI_COPIED_MS } from "./clipboard"
import { T_SECONDARY, TOUCH_44 } from "./styles"
import { cn } from "@/lib/utils"
import type { ShellStreamEvent } from "@/relay/useRelay"

export interface PiShellPaneProps {
  roomId: string
  variant: "desktop" | "phone"
  online: boolean
  unloaded?: boolean
  runCommand: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  subscribeShellEvents: (fn: (ev: ShellStreamEvent) => void) => () => void
  onNotify?: (text: string, tone?: "warn" | "bad") => void
  className?: string
}

type ShellOpenResult = {
  shellId: string
  pty: boolean
  shell: string
  cwd: string
  cols: number
  rows: number
  buffer: string
  reused?: boolean
}

type ShellStatus = "connecting" | "running" | "exited" | "error"

function cssVar(style: CSSStyleDeclaration, name: string): string | undefined {
  const val = style.getPropertyValue(name).trim()
  return val || undefined
}

function termTheme(el: HTMLElement): ITheme {
  const s = getComputedStyle(el)
  return {
    background: cssVar(s, "--cw-pi-shell-bg"),
    foreground: cssVar(s, "--cw-pi-shell-fg"),
    cursor: cssVar(s, "--cw-pi-shell-cursor"),
    cursorAccent: cssVar(s, "--cw-pi-shell-cursor-accent"),
    selectionBackground: cssVar(s, "--cw-pi-shell-selection"),
    selectionForeground: cssVar(s, "--cw-pi-shell-selection-fg"),
    black: cssVar(s, "--cw-pi-shell-black"),
    red: cssVar(s, "--cw-pi-shell-red"),
    green: cssVar(s, "--cw-pi-shell-green"),
    yellow: cssVar(s, "--cw-pi-shell-yellow"),
    blue: cssVar(s, "--cw-pi-shell-blue"),
    magenta: cssVar(s, "--cw-pi-shell-magenta"),
    cyan: cssVar(s, "--cw-pi-shell-cyan"),
    white: cssVar(s, "--cw-pi-shell-white"),
    brightBlack: cssVar(s, "--cw-pi-shell-bright-black"),
    brightRed: cssVar(s, "--cw-pi-shell-bright-red"),
    brightGreen: cssVar(s, "--cw-pi-shell-bright-green"),
    brightYellow: cssVar(s, "--cw-pi-shell-bright-yellow"),
    brightBlue: cssVar(s, "--cw-pi-shell-bright-blue"),
    brightMagenta: cssVar(s, "--cw-pi-shell-bright-magenta"),
    brightCyan: cssVar(s, "--cw-pi-shell-bright-cyan"),
    brightWhite: cssVar(s, "--cw-pi-shell-bright-white"),
  }
}

function termFont(el: HTMLElement, phone: boolean): { fontFamily: string; fontSize: number } {
  const s = getComputedStyle(el)
  const fontFamily = cssVar(s, "--cw-font-mono") || "ui-monospace, SFMono-Regular, Menlo, monospace"
  const tokenPx = Number.parseFloat(cssVar(s, "--cw-text-code-block") ?? "")
  if (Number.isFinite(tokenPx) && tokenPx > 0) {
    return { fontFamily, fontSize: Math.max(10, tokenPx - (phone ? 1 : 0.5)) }
  }
  const sizeAttr = el.closest("[data-pi-font-size]")?.getAttribute("data-pi-font-size") ?? document.documentElement.getAttribute("data-pi-font-size")
  const delta = sizeAttr === "small" ? -1 : sizeAttr === "large" ? 1 : 0
  return { fontFamily, fontSize: (phone ? 12 : 12.5) + delta }
}

function shellBaseName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx >= 0 ? normalized.slice(idx + 1) || p : p
}

function readTerminalCopyText(term: XTerm): string {
  const selected = term.getSelection()
  if (selected) return selected
  const buf = term.buffer.active
  const start = Math.max(0, buf.length - 500)
  const lines: string[] = []
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) lines.push(line.translateToString(true))
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

/**
 * Interactive PTY shell pane (zsh / OS default shell on macOS/Linux, PowerShell on Windows).
 * Streams live I/O over existing relay commands + shell_output / shell_exit events, and preserves
 * the running shell session across pane collapse/reopen until the user restarts or switches sessions.
 */
export function PiShellPane({
  roomId,
  variant,
  online,
  unloaded,
  runCommand,
  subscribeShellEvents,
  onNotify,
  className,
}: PiShellPaneProps) {
  const phone = variant === "phone"
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const shellIdRef = useRef<string | null>(null)
  const resetNextRef = useRef(false)
  const copyTimerRef = useRef<number | undefined>(undefined)
  const phoneRef = useRef(phone)
  phoneRef.current = phone
  const onNotifyRef = useRef(onNotify)
  onNotifyRef.current = onNotify

  const [restartNonce, setRestartNonce] = useState(0)
  const [status, setStatus] = useState<ShellStatus>("connecting")
  const [shellMeta, setShellMeta] = useState<{ shell: string; cwd: string; pty: boolean } | null>(null)
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(null)
  const [errorMsg, setErrorMsg] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), [])

  useEffect(() => {
    if (!roomId || !online || unloaded) return
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let openedShellId: string | null = null
    let lastCols = 80
    let lastRows = 24
    let term: XTerm | null = null
    let dataSub: { dispose(): void } | null = null
    let resizeObs: ResizeObserver | null = null
    let themeObs: MutationObserver | null = null
    let resizeTimer: number | undefined
    let rafId: number | undefined
    const pendingEvents: ShellStreamEvent[] = []

    const applyEvent = (ev: ShellStreamEvent) => {
      if (!term || ev.shellId !== openedShellId) return
      if (ev.type === "shell_output") {
        if (ev.data) term.write(ev.data)
      } else if (ev.type === "shell_exit") {
        setStatus("exited")
        setExitInfo({ code: ev.code, signal: ev.signal })
        const label = ev.code !== null ? `code ${ev.code}` : ev.signal ? `signal ${ev.signal}` : "closed"
        term.write(`\r\n\r\n[Process exited: ${label}]\r\n`)
      }
    }

    const unsubscribe = subscribeShellEvents((ev) => {
      if (disposed || (ev.roomId && ev.roomId !== roomId)) return
      if (!openedShellId) {
        pendingEvents.push(ev)
        return
      }
      applyEvent(ev)
    })

    const start = async () => {
      setStatus("connecting")
      setExitInfo(null)
      setErrorMsg("")
      shellIdRef.current = null

      try {
        const [{ Terminal: XTermCtor }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ])
        if (disposed || !hostRef.current) return

        const hostEl = hostRef.current
        const initialFont = termFont(hostEl, phoneRef.current)
        term = new XTermCtor({
          cursorBlink: true,
          fontSize: initialFont.fontSize,
          lineHeight: 1.35,
          scrollback: 5000,
          convertEol: false,
          allowProposedApi: true,
          fontFamily: initialFont.fontFamily,
          theme: termTheme(hostEl),
        })
        const fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(hostEl)
        termRef.current = term

        const safeFit = (): boolean => {
          if (!term || disposed || !hostRef.current) return false
          if (hostRef.current.clientWidth <= 0 || hostRef.current.clientHeight <= 0) return false
          try {
            fitAddon.fit()
            return true
          } catch {
            return false
          }
        }
        safeFit()
        lastCols = Math.max(20, term.cols || 80)
        lastRows = Math.max(8, term.rows || 24)

        const syncResize = () => {
          if (!term || disposed || !openedShellId) return
          const nextCols = Math.max(20, term.cols || lastCols)
          const nextRows = Math.max(8, term.rows || lastRows)
          if (nextCols === lastCols && nextRows === lastRows) return
          lastCols = nextCols
          lastRows = nextRows
          void runCommand("shell_resize", { shellId: openedShellId, cols: nextCols, rows: nextRows }).catch(() => {})
        }

        const fitAndResize = () => {
          if (!safeFit()) return
          syncResize()
        }

        const syncAppearance = () => {
          if (!term || disposed || !hostRef.current) return
          const el = hostRef.current
          term.options.theme = termTheme(el)
          const nextFont = termFont(el, phoneRef.current)
          if (term.options.fontFamily !== nextFont.fontFamily || term.options.fontSize !== nextFont.fontSize) {
            term.options.fontFamily = nextFont.fontFamily
            term.options.fontSize = nextFont.fontSize
            fitAndResize()
            term.refresh(0, Math.max(0, term.rows - 1))
          }
        }
        const attrFilter = ["data-pi-theme", "data-pi-accent", "data-pi-mono-font", "data-pi-font-size"]
        themeObs = new MutationObserver(syncAppearance)
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: attrFilter })
        const piRoot = hostEl.closest("[data-pi-root]")
        if (piRoot) themeObs.observe(piRoot, { attributes: true, attributeFilter: attrFilter })

        if (typeof document !== "undefined" && document.fonts?.ready) {
          void document.fonts.ready.then(() => {
            if (disposed) return
            fitAndResize()
          })
        }

        if (typeof ResizeObserver !== "undefined") {
          let wasVisible = hostEl.clientWidth > 0 && hostEl.clientHeight > 0
          let pendingRefresh = false
          resizeObs = new ResizeObserver((entries) => {
            const entry = entries[0]
            const width = entry ? entry.contentRect.width : hostEl.clientWidth
            const height = entry ? entry.contentRect.height : hostEl.clientHeight
            const nowVisible = width > 0 && height > 0
            if (!wasVisible && nowVisible) pendingRefresh = true
            wasVisible = nowVisible
            if (!nowVisible) return
            window.clearTimeout(resizeTimer)
            resizeTimer = window.setTimeout(() => {
              if (disposed || !term) return
              fitAndResize()
              if (pendingRefresh) {
                pendingRefresh = false
                term.refresh(0, Math.max(0, term.rows - 1))
              }
            }, pendingRefresh ? 0 : 60)
          })
          resizeObs.observe(hostEl)
        }

        const shouldReset = resetNextRef.current
        resetNextRef.current = false
        const res = (await runCommand("shell_open", {
          cols: lastCols,
          rows: lastRows,
          ...(shouldReset ? { reset: true } : {}),
        })) as ShellOpenResult

        if (disposed || !res || !res.shellId) return
        openedShellId = res.shellId
        shellIdRef.current = res.shellId
        term.options.convertEol = !res.pty
        setShellMeta({ shell: res.shell || "shell", cwd: res.cwd || "", pty: !!res.pty })
        setStatus("running")

        if (res.buffer) term.write(res.buffer)
        while (pendingEvents.length > 0) {
          const ev = pendingEvents.shift()
          if (ev) applyEvent(ev)
        }

        dataSub = term.onData((data) => {
          if (disposed || !openedShellId) return
          void runCommand("shell_input", { shellId: openedShellId, data }).catch((err: unknown) => {
            if (disposed) return
            const msg = err instanceof Error ? err.message : "Shell input failed"
            onNotifyRef.current?.(msg, "bad")
          })
        })

        rafId = window.requestAnimationFrame(() => {
          fitAndResize()
          if (!phoneRef.current && term && !disposed) term.focus()
        })
      } catch (err: unknown) {
        if (disposed) return
        const msg = err instanceof Error ? err.message : "Failed to start interactive shell"
        setStatus("error")
        setErrorMsg(msg)
        term?.write(`\r\n[Failed to open shell: ${msg}]\r\n`)
      }
    }

    void start()

    return () => {
      disposed = true
      unsubscribe()
      window.clearTimeout(resizeTimer)
      if (rafId !== undefined) window.cancelAnimationFrame(rafId)
      resizeObs?.disconnect()
      themeObs?.disconnect()
      dataSub?.dispose()
      termRef.current = null
      shellIdRef.current = null
      term?.dispose()
    }
  }, [roomId, online, unloaded, restartNonce, runCommand, subscribeShellEvents])

  if (unloaded) {
    return (
      <div data-pi-part="shell-pane" data-empty="unloaded" className={cn("flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center", className)}>
        <div className="text-(length:--cw-text-md) text-(--cw-text-2)">Session not loaded</div>
        <div className={cn("mt-1 text-(length:--cw-text-sm)", T_SECONDARY)}>
          Send a message or load this session first to open an interactive shell
        </div>
      </div>
    )
  }

  if (!online) {
    return (
      <div data-pi-part="shell-pane" data-empty="offline" className={cn("flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center", className)}>
        <div className="text-(length:--cw-text-md) text-(--cw-text-2)">Device offline</div>
        <div className={cn("mt-1 text-(length:--cw-text-sm)", T_SECONDARY)}>
          Connect the host device to open an interactive shell
        </div>
      </div>
    )
  }

  const shellLabel = shellMeta ? `${shellBaseName(shellMeta.shell)}${shellMeta.pty ? " (PTY)" : ""}` : "Shell"
  const statusText =
    status === "connecting"
      ? "Starting shell…"
      : status === "error"
        ? errorMsg || "Shell error"
        : status === "exited"
          ? `${shellLabel} · Exited${exitInfo?.code !== null && exitInfo?.code !== undefined ? ` (${exitInfo.code})` : ""}`
          : shellMeta?.cwd
            ? `${shellLabel} · ${shellMeta.cwd}`
            : shellLabel

  const onSigint = () => {
    const sid = shellIdRef.current
    if (!sid || status !== "running") return
    void runCommand("shell_input", { shellId: sid, data: "\x03" }).catch(() => {})
    termRef.current?.focus()
  }

  const onClear = () => {
    const term = termRef.current
    if (term) {
      term.clear()
      term.focus()
    }
  }

  const onCopy = () => {
    const term = termRef.current
    if (!term) return
    const text = readTerminalCopyText(term)
    if (!text) return
    void piCopyText(text).then((ok) => {
      if (!ok) {
        onNotify?.("Copy failed: clipboard access is unavailable in this browser context", "bad")
        return
      }
      setCopied(true)
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), PI_COPIED_MS)
    })
  }

  const onRestart = () => {
    resetNextRef.current = true
    setRestartNonce((n) => n + 1)
  }

  return (
    <div data-pi-part="shell-pane" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div
        data-pi-part="shell-toolbar"
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-(--cw-divider) bg-(--cw-bg)",
          phone ? "h-11 gap-3 pr-2.5 pl-4" : "h-9 pr-2 pl-3.5",
        )}
      >
        <Terminal size={13} strokeWidth={1.7} className="shrink-0 text-(--cw-text-3)" aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate text-(length:--cw-text-sm)", T_SECONDARY)} title={statusText}>
          {statusText}
        </span>
        <GhostIconButton
          data-cw-id="pi-shell-sigint"
          label="Send Ctrl+C"
          title="Interrupt (Ctrl+C)"
          icon={<Square />}
          disabled={status !== "running"}
          className={cn(phone && TOUCH_44)}
          onClick={onSigint}
        />
        <GhostIconButton
          data-cw-id="pi-shell-clear"
          label="Clear terminal"
          title="Clear"
          icon={<Eraser />}
          className={cn(phone && TOUCH_44)}
          onClick={onClear}
        />
        <GhostIconButton
          data-cw-id="pi-shell-copy"
          data-copied={copied ? "true" : undefined}
          label={copied ? "Copied" : "Copy output"}
          title={copied ? "Copied" : "Copy selection or buffer"}
          icon={copied ? <Check /> : <Copy />}
          className={cn(phone && TOUCH_44, copied && "text-(--cw-green) hover:text-(--cw-green)")}
          onClick={onCopy}
        />
        <GhostIconButton
          data-cw-id="pi-shell-restart"
          label="Restart shell"
          title="Restart shell"
          icon={<RotateCcw />}
          className={cn(phone && TOUCH_44)}
          onClick={onRestart}
        />
      </div>
      <div
        ref={hostRef}
        data-pi-part="shell-viewport"
        data-cw-id="pi-shell-viewport"
        className="relative min-h-0 flex-1 overflow-hidden p-2"
        onClick={() => termRef.current?.focus()}
        onKeyDown={(e) => {
          if (e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation()
        }}
      />
    </div>
  )
}
