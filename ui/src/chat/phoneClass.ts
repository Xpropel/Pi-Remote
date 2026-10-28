import { useSyncExternalStore } from "react"

/**
 * <html class="phone">（App 在 <1024 的手机页和 /m 上加）的订阅。原样从 chat/ui.tsx 挪出来（P5 整合）：
 * relay/useRelay.ts → chat/composer/useComposerUi.ts 只要这一个 hook，从 chat/ui.tsx 引会把 NoticeStack 和它的样式表
 * 一起带进新界面入口（P7 B1 起是 index.html）。chat/ui.tsx 已在 P7 B3c 随旧界面删除。
 */
function subscribePhone(listener: () => void) {
  const obs = new MutationObserver(listener)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => obs.disconnect()
}

function phoneSnapshot() {
  return document.documentElement.classList.contains("phone")
}

export function usePhoneClass() {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
}
