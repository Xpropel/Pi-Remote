import { useEffect, useRef } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { purgeSignalDecision } from "./purgeSignal"
import { DesktopApp } from "./DesktopApp"
import { LoginContainer } from "./LoginContainer"
import { PhoneApp } from "./PhoneApp"
import type { PiAppProps, PiVariant } from "./types"

/**
 * 容器树的根（plan P5.3「无 token → LoginContainer，否则按断点进 DesktopApp / PhoneApp」）。
 * 产品入口 PiApp 和开发画廊的 #/live（LiveRoute）共用这一个分支，两边看到的是同一棵树。本文件归 p5-base。
 *
 * P9 B（spec §4.7.1 第 5 条）：正在看的会话被删、同一台设备上又没有别的会话可切时，useRelay 只发一次性
 * 信号 `relay.purgedRoom`（它不碰界面状态），由这里把界面切到新建会话页（桌面 / 手机都经过这个根）。
 * 只在信号变化时触发一次；普通"还没选会话"（初始 roomId 为空）没有信号，不会误触发。
 */
export function PiAppBody(props: PiAppProps & { variant: PiVariant; theme?: PiTheme }) {
  const { variant, theme, ...app } = props
  const { relay, ui, act } = app
  /** 已处理过的信号（at 去重）：同一帧只跳一次；StrictMode 双跑 effect 也不会重复 newSession */
  const handledPurgeAt = useRef(0)
  // 过期信号只记账、不导航（UI 低危：延迟处理误弹新建页）。必须先于下面的导航 effect 执行：
  // 用户已离开会话视图或已打开别的会话时，把 at 标记为已处理，避免它晚些时候再抢界面。
  useEffect(() => {
    const purge = relay.purgedRoom
    if (!purge) return
    const decision = purgeSignalDecision({ purge, handledAt: handledPurgeAt.current, roomId: relay.roomId, view: ui.view })
    if (decision === "consume") handledPurgeAt.current = purge.at
  }, [relay.purgedRoom, relay.roomId, ui.view])
  useEffect(() => {
    const purge = relay.purgedRoom
    if (!purge || purge.at === handledPurgeAt.current) return
    // 房还没清完（roomId 还指着被删的房间）→ 等 clearRoom 落地的那次 effect 再跳
    if (relay.roomId) return
    // 用户不在会话视图（设置 / 新建页）：先不抢，等他回到会话视图时再处理（依赖里含 ui.view）
    if (ui.view !== "session") return
    handledPurgeAt.current = purge.at
    act.newSession()
  }, [relay.purgedRoom, relay.roomId, ui.view, act])
  // Room-scoped notice dismissal on leaving the session view lives in
  // PiApp (the one root every variant shares); this container only serves
  // the cursor tree and the dev gallery, so the hook is not repeated here.
  if (!app.relay.token) return <LoginContainer {...props} />
  return variant === "desktop" ? <DesktopApp {...app} theme={theme} /> : <PhoneApp {...app} theme={theme} />
}
