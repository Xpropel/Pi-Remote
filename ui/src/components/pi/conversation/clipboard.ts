/**
 * 复制到剪贴板（P5.4：代码块复制钮、回复操作行的"复制回复"真的写剪贴板，P4 交接）。
 * navigator.clipboard 只在安全上下文（HTTPS / localhost）里有；局域网 http、file:// 下退回 execCommand("copy")，再不行返回 false，
 * 由调用方决定怎么提示。口径同旧界面 chat/slash.tsx 的 copyText（P7 删旧文件，这里是新界面的那一份）。
 */
export async function piCopyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof window !== "undefined" && window.isSecureContext && typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // No clipboard permission or blocked by user-gesture policy; fall back to synchronous execCommand.
  }
  if (typeof document === "undefined" || !document.body) return false
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const ta = document.createElement("textarea")
  try {
    ta.value = text
    ta.setAttribute("aria-hidden", "true")
    ta.style.position = "fixed"
    ta.style.left = "-9999px"
    ta.style.top = "0"
    ta.style.opacity = "0"
    ta.style.pointerEvents = "none"
    document.body.appendChild(ta)
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    ta.remove()
    try {
      prevFocus?.focus?.({ preventScroll: true })
    } catch {
      // ignore focus restoration failure
    }
  }
}

/** "Copied" ✓ feedback duration (ms). */
export const PI_COPIED_MS = 1500
