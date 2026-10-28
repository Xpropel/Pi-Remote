/**
 * 对话流的吸底（PLAN 4.3；design §5 流式一行「贴底跟随，上滑停止跟随并出现回到底部钮」、§4.7 减少动效）。
 *
 * 直接用依赖里已有的 use-stick-to-bottom（ui/package.json 本来就有，旧界面 components/ui/chat-container.tsx 也在用），
 * 但不用它的 <StickToBottom> 组件：滚动容器是现成的——桌面是 kit ChatColumn 的 [data-cw-scroller]，手机是 PiPhonePage 唯一的
 * [data-pi-scroller]（对话页只留一个滚动容器，overscroll-behavior 已是 contain）。所以只把库的 scrollRef / contentRef 接到这两个元素上：
 *   - 内容变高（流式长字、新消息）时，在底部就跟着贴底；用户上滑（滚轮、触摸、键盘、拖选文字）就松开，不再强拉；
 *   - 用户自己滚回底部附近（70px 内）又重新贴住；scrollToBottom() =「回到底部」钮。
 * 减少动效（usePiMotion().scrollBehavior === "auto"）：库自己的弹簧动画也关掉（initial / resize / 回到底部都用 "instant"）。
 *
 * P6.3（design §4.2 规则 2，清单 C9；c 线单项许可，只加这一条）：手机键盘弹出时滚动容器变矮、内容不变，库不管（它只看内容盒）。
 * 弹出前离底部 ≤ 80 就继续贴底（键盘开着期间容器再变矮——键盘动画的后几帧、composer 长成两层——也跟着贴，用户上滑就停）；
 * 否则不动 scrollTop，正在读的位置不跳。键盘状态取 PiRoot 的视口帧（usePiFrame().keyboardOpen）。
 */
import { useCallback, useLayoutEffect, useRef } from "react"
import { useStickToBottom } from "use-stick-to-bottom"
import { usePiFrame } from "@/pi/headless"
import { usePiMotion } from "./useReducedMotion"

/** 键盘弹出前离底部多近算"停在底部"（design §4.2 规则 2） */
export const PI_KEYBOARD_STICK_PX = 80

export interface PiStickToBottom {
  /** 接上滚动容器和它的内容盒（ResizeObserver 看内容盒的高度）；传 null 解开 */
  attach: (scroller: HTMLElement | null, content: HTMLElement | null) => void
  /** 在底部（含 70px 以内的"接近底部"） */
  atBottom: boolean
  /** 回到底部并重新贴住（正常动效 = 库的弹簧滚动，减少动效或 instant = 直接跳） */
  scrollToBottom: (instant?: boolean) => void
  /** 松开贴底（初始滚动位置是一个数字、不是"bottom"时用） */
  release: () => void
}

/**
 * 键盘贴底的记录：el = 滚动容器（attach(null) 时解开监听）；gap = 键盘收起时最后一次滚动（或接上 / 收起键盘）时离底部多远——
 * 只在滚动时记，不跟容器变矮更新：点输入框时 composer 先长成两层、流区先矮一截，这一截不算"离开底部"；
 * stick = 这次键盘开着期间要贴底；top = 上一次的 scrollTop（认用户上滑）
 */
type KeyboardStick = { el: HTMLElement | null; open: boolean; gap: number; stick: boolean; top: number; off: (() => void) | null }

const gapOf = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

export function usePiStickToBottom(): PiStickToBottom {
  const { scrollBehavior } = usePiMotion()
  const instant = scrollBehavior === "auto"
  // initial 总是 instant：第一次贴底不做动画（打开会话时直接在底部）；resize 不传 = 库默认的弹簧（平滑跟随）
  const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom } = useStickToBottom({
    initial: "instant",
    resize: instant ? "instant" : undefined,
  })
  const keyboardOpen = usePiFrame().keyboardOpen
  const kb = useRef<KeyboardStick>({ el: null, open: keyboardOpen, gap: 0, stick: false, top: 0, off: null })
  const attach = useCallback(
    (scroller: HTMLElement | null, content: HTMLElement | null) => {
      scrollRef(scroller)
      contentRef(content)
      const k = kb.current
      k.off?.()
      k.off = null
      k.el = scroller
      k.stick = false
      if (!scroller) return
      k.gap = gapOf(scroller)
      k.top = scroller.scrollTop
      // 键盘开着、要贴底时容器再变矮（键盘动画的后几帧、composer 长高）：接着贴
      const ro = new ResizeObserver(() => {
        if (!k.open || !k.stick) return
        scroller.scrollTop = scroller.scrollHeight
        k.top = scroller.scrollTop
      })
      ro.observe(scroller)
      // 键盘收起时记下离底部多远；开着时用户往上滑就松开（不再跟着容器变矮去贴底）
      const onScroll = () => {
        if (!k.open) k.gap = gapOf(scroller)
        else if (k.stick && scroller.scrollTop < k.top - 1) k.stick = false
        k.top = scroller.scrollTop
      }
      scroller.addEventListener("scroll", onScroll, { passive: true })
      k.off = () => {
        ro.disconnect()
        scroller.removeEventListener("scroll", onScroll)
      }
    },
    [scrollRef, contentRef],
  )
  // 键盘弹出（这次提交里 PiPhonePage 已经让出键盘高度，容器已经变矮、scrollTop 还没动）：按弹出前记下的离底距离决定贴不贴
  useLayoutEffect(() => {
    const k = kb.current
    const was = k.open
    k.open = keyboardOpen
    const el = k.el
    if (!el) return
    if (keyboardOpen && !was) {
      k.stick = k.gap <= PI_KEYBOARD_STICK_PX
      if (k.stick) {
        el.scrollTop = el.scrollHeight
        k.top = el.scrollTop
      }
    } else if (!keyboardOpen) {
      k.stick = false
      k.gap = gapOf(el)
    }
  }, [keyboardOpen])
  const toBottom = useCallback(
    (jump?: boolean) => {
      void scrollToBottom(instant || jump ? "instant" : "smooth")
    },
    [scrollToBottom, instant],
  )
  return { attach, atBottom: isAtBottom, scrollToBottom: toBottom, release: stopScroll }
}
