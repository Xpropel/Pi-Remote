import { useEffect, useState } from "react"
import { nextUnseen, pageTitle } from "@/relay/presence"
import { roomTitle, type Relay } from "@/relay/useRelay"

/** 手机软键盘弹起时可视区的位置和高度（iOS 不缩布局视口，要自己把页面框到可视区里）；键盘收起为 null */
export function useKeyboardFrame() {
  const [frame, setFrame] = useState<{ top: number; height: number } | null>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => {
      const layout = document.documentElement.clientHeight
      const gap = Math.max(0, Math.round(layout - viewport.offsetTop - viewport.height))
      if (gap > 80) {
        setFrame({ top: viewport.offsetTop, height: viewport.height })
        window.scrollTo(0, 0)
      } else {
        setFrame(null)
      }
    }
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
    }
  }, [])
  return frame
}

function pageHidden() {
  return document.visibilityState === "hidden"
}

export interface UsePageTitleOptions {
  /** 是否使用「后台完成 ✓」前缀（设置 › 通知：任务完成时 / 角标）。默认 true，保持旧行为。 */
  completion?: boolean
  /** 隐私模式：不把会话标题写进 document.title（标记前缀保留）。 */
  privacy?: boolean
  /** 设置 › 通知「总是提醒」：页面在场也打完成前缀；回到页面 / 8 秒后清除。 */
  always?: boolean
}

/**
 * 标签页标题跟着会话走：运行中 ●、页面在后台时这一轮跑完了 ✓（回到页面就消失）、断线标「已断开」。
 * P9 修复线 W（review-1 P2-2）：waiting > 0（任意「等你回答」）时前缀「? 」，压过 ● 与 ✓；
 * 「? 」与 favicon 角标都由这里的 waiting 计数驱动，favicon hook（useCompletionBadge）只画图不写标题。
 * P13 设置页 v2：completion / privacy / always 由宿主按 prefs.notifications 与 prefs.privacyMode 传入；
 * 不传时行为与旧界面完全一致。
 */
export function usePageTitle(relay: Relay, waiting = 0, options: UsePageTitleOptions = {}) {
  const { completion = true, privacy = false, always = false } = options
  const room = relay.rooms.find((item) => item.id === relay.roomId) || null
  const [hidden, setHidden] = useState(pageHidden)
  const [track, setTrack] = useState({ busy: relay.busy, roomId: relay.roomId, unseen: false })
  if (track.busy !== relay.busy || track.roomId !== relay.roomId) {
    setTrack({
      busy: relay.busy,
      roomId: relay.roomId,
      unseen: completion ? nextUnseen(track, { busy: relay.busy, roomId: relay.roomId, hidden: hidden || always }) : false,
    })
  }
  useEffect(() => {
    const onChange = () => {
      const now = pageHidden()
      setHidden(now)
      // 「总是提醒」不因回到页面而丢掉刚出现的完成标记，交给下面的 8 秒 / 交互清理。
      if (!now && !always) setTrack((prev) => (prev.unseen ? { ...prev, unseen: false } : prev))
    }
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [always])
  useEffect(() => {
    if (!always || hidden || !track.unseen) return
    const clear = () => setTrack((prev) => (prev.unseen ? { ...prev, unseen: false } : prev))
    const timer = window.setTimeout(clear, 8000)
    window.addEventListener("pointerdown", clear)
    window.addEventListener("keydown", clear)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("pointerdown", clear)
      window.removeEventListener("keydown", clear)
    }
  }, [always, hidden, track.unseen])
  const title = pageTitle({
    room: privacy ? "" : room ? roomTitle(room) : "",
    busy: relay.busy && relay.online,
    unseenDone: completion && track.unseen,
    linkLost: !!relay.token && relay.everConnected && !relay.authed,
    waiting: waiting > 0,
  })
  useEffect(() => {
    document.title = title
  }, [title])
  useEffect(() => () => {
    document.title = "pi"
  }, [])
}
