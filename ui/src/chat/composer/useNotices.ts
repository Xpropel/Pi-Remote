/** 第 5 章通知栈的 React 外壳：全局单例 + 响应式可见上限。
 *
 *  生命周期/合并/顶替/优先级/ttl 全部由 noticeCore.ts 的纯 reducer 决定；
 *  存储与到期定时器在 noticeStore.ts（所有页面共享）。这里只做：
 *  - useSyncExternalStore 订阅
 *  - 桌面 / 移动都 1 张的 set-max-visible（V2；保留响应式入口给后续调整）
 */

import { useEffect, useRef, useSyncExternalStore } from "react"
import { NOTICE_MAX_VISIBLE } from "../noticeCore.ts"
import { getNoticeSnapshot, noticeStore, subscribeNotices, type NoticesApi } from "./noticeStore.ts"

function subscribeNarrow(listener: () => void) {
  const query = window.matchMedia("(max-width: 767.98px)")
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

function narrowSnapshot() {
  return window.matchMedia("(max-width: 767.98px)").matches
}

function useNarrow() {
  return useSyncExternalStore(subscribeNarrow, narrowSnapshot, () => false)
}

/** 任意组件都可订阅；只有 useNotices 会设置 1 张上限（App 里始终挂着一份）。 */
export function useNoticeSnapshot() {
  return useSyncExternalStore(subscribeNotices, getNoticeSnapshot, getNoticeSnapshot)
}

export function useNotices(): NoticesApi {
  const state = useNoticeSnapshot()
  // 桌面和移动端都是 1 张：保留窄屏订阅只为兼容旧的调用形状，不再改上限。
  useNarrow()
  const lastMax = useRef<number | null>(null)

  useEffect(() => {
    if (lastMax.current === NOTICE_MAX_VISIBLE) return
    lastMax.current = NOTICE_MAX_VISIBLE
    noticeStore.setMaxVisible(NOTICE_MAX_VISIBLE)
  }, [])

  return { ...noticeStore, visible: state.visible, queue: state.queue }
}
