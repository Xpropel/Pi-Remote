/**
 * composer Enter 的共享接线（无视觉）：读发送键偏好，把按键变成 send / 换行 / 放行。
 *
 * 纯决策在 ./composerSendKey.ts；本 hook 只负责三类副作用：
 *  - send：preventDefault，满足可发送条件时调用 send()；
 *  - newline：preventDefault，在 textarea 当前选区插入换行并把光标放到换行之后
 *    （Chrome 的 Ctrl/Cmd+Enter 不会原生换行，必须自己插）；
 *  - native / ignore：什么都不做（手机软键盘 Enter 原生换行、组字中、Alt 组合）。
 *
 * Shift+Enter 也走 newline：浏览器只在裸 Shift+Enter 时原生换行，Ctrl/Cmd+Shift+Enter
 * 不会；统一自己插可保证三套外壳 / 三种浏览器行为一致。
 *
 * 光标恢复用 useLayoutEffect：setValue 触发父级重渲染后，再把 selection 放回插入点；
 * 已有自己光标管理的调用方可以传 restoreCaret: false。
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react"
import { decideComposerEnter, insertComposerNewline } from "./composerSendKey"
import { usePiSendKey } from "./sendKeyContext"

export interface PiComposerEnterOptions {
  /** 当前草稿（受控值）。 */
  value: string
  /** 写回草稿；caret = 插入换行后的光标位置。 */
  setValue: (value: string, caret: number) => void
  /** 发送动作（与点发送钮同一入口）。 */
  send: () => void
  /** 不可发送时仍吞掉 Enter，但不调用 send（与旧 composer 行为一致）。 */
  canSend?: boolean
  /** 手机外壳：无 Ctrl/Cmd 的 Enter 保持原生换行；Ctrl/Cmd+Enter 按桌面偏好（外接键盘）。 */
  mobile?: boolean
  /** S7 / 启动中：不发送、不改草稿。 */
  disabled?: boolean
  /** 审批阻塞等只读态：不发送、不改草稿。 */
  readOnly?: boolean
  /** false = 调用方自己恢复光标（例如已有 pendingCaret 的 PiFollowUpComposer）。默认 true。 */
  restoreCaret?: boolean
}

/** 返回 true = 这个事件已被 composer 处理（调用方不要再走自己的 Enter 分支）。 */
export function useComposerEnter(options: PiComposerEnterOptions): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const { value, setValue, send, canSend = true, mobile = false, disabled = false, readOnly = false, restoreCaret = true } = options
  const sendKey = usePiSendKey()
  const target = useRef<HTMLTextAreaElement | null>(null)
  const pendingCaret = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (!restoreCaret) return
    const el = target.current
    if (!el || pendingCaret.current == null) return
    const at = Math.min(pendingCaret.current, el.value.length)
    pendingCaret.current = null
    el.setSelectionRange(at, at)
  })

  return (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const decision = decideComposerEnter(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        mobile,
      },
      sendKey,
    )
    if (decision === "send") {
      event.preventDefault()
      if (!disabled && !readOnly && canSend) send()
      return true
    }
    if (decision === "newline") {
      event.preventDefault()
      if (disabled || readOnly) return true
      const el = event.currentTarget
      const start = el.selectionStart ?? value.length
      const end = el.selectionEnd ?? start
      const next = insertComposerNewline(value, start, end)
      if (restoreCaret) {
        target.current = el
        pendingCaret.current = next.caret
      }
      setValue(next.draft, next.caret)
      return true
    }
    return false
  }
}
