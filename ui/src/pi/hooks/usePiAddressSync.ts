import { useEffect, useRef } from "react"
import { usePiStatic } from "@/components/pi/shared"
import type { PiAppProps } from "@/pi/containers/types"
import { desktopAddressOf } from "@/pi/model/phoneRoute"

/*
 * 桌面外壳的地址栏跟着当前会话（DesktopApp 调一次）：换房间时 history.replaceState 写一次 ?device=&session=（同手机深链），不新增历史项。
 * 不写的话地址栏停在旧会话 id：窗口缩到手机宽度、复制地址分享出去，phoneNavInit 打开的都是那个旧会话。
 * 静态态（画廊对图）不碰 history；history.state 原样带上（手机导航的 __piMobile 标记还要用）。
 */
export function usePiAddressSync(relay: PiAppProps["relay"]): void {
  const isStatic = usePiStatic()
  const roomId = relay.roomId
  const deviceId = relay.rooms.find((r) => r.id === roomId)?.deviceId ?? relay.lazySession?.deviceId ?? relay.selectedDeviceId ?? undefined
  const lastRoomRef = useRef<string | null>(null)
  useEffect(() => {
    if (isStatic) return
    const moved = lastRoomRef.current !== null && lastRoomRef.current !== roomId
    lastRoomRef.current = roomId
    const url = desktopAddressOf(window.location, roomId, deviceId, moved)
    if (url != null) window.history.replaceState(window.history.state, "", url)
  }, [isStatic, roomId, deviceId])
}
