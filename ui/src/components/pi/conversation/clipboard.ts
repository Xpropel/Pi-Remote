/**
 * 复制到剪贴板（P5.4：代码块复制钮、回复操作行的"复制回复"真的写剪贴板，P4 交接）。
 * navigator.clipboard 只在安全上下文（HTTPS / localhost）里有；局域网 http、file:// 下退回 execCommand("copy")，再不行返回 false，
 * 由调用方决定怎么提示。口径同旧界面 chat/slash.tsx 的 copyText（P7 删旧文件，这里是新界面的那一份）。
 */
export async function piCopyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 没有权限：走兜底
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** "已复制"✓ 停留多久（design §3.4 conversation states："代码复制成功（✓ 1.2 秒）"） */
export const PI_COPIED_MS = 1200
