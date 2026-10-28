/** 把 relay 事实折成 ComposerUi 的唯一 Hook。组件不再自己拼 canSend / canType。 */

import { useMemo, useSyncExternalStore } from "react"
import { usePhoneClass } from "@/chat/phoneClass"
import { deriveComposer, type ComposerFacts, type ComposerUi } from "../composerMachine.ts"

function subscribeNarrow(listener: () => void) {
  const query = window.matchMedia("(max-width: 767.98px)")
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

function narrowSnapshot() {
  return window.matchMedia("(max-width: 767.98px)").matches
}

/** 移动端占位永远不出现 Enter 键名。
 *  App 的 .phone 覆盖 <1024 的手机页 + /m；媒体查询兜底 768 以下的窄窗（组件库/独立预览）。 */
export function useComposerMobile(): boolean {
  const phone = usePhoneClass()
  const narrow = useSyncExternalStore(subscribeNarrow, narrowSnapshot, () => false)
  return phone || narrow
}

export function useComposerUi(facts: Omit<ComposerFacts, "mobile">): ComposerUi {
  const mobile = useComposerMobile()
  return useMemo(() => deriveComposer({ ...facts, mobile }), [facts, mobile])
}
