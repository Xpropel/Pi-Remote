import { useLayoutEffect, type CSSProperties } from "react"
import { PiHeadlessRoot } from "@/pi/headless"
import type { VariantAppProps } from "@/pi/variants/types"
import { CodexFrameContext } from "./root/context"
import { CodexLogin } from "./pages/CodexLogin"
import { CodexApprovalPreview } from "./approval/CodexApprovalPreview"
import { CodexDesktop } from "./shell/CodexDesktop"
import { CodexPhone } from "./shell/CodexPhone"
import "./styles/tokens.css"
import "./styles/codex.css"
import "./styles/dark.css"

/**
 * codex 变体入口 v2（完全自包含；checklist §0/§2.2）：
 * 根 DOM / 类名 / 样式全部自己写，布局语义（产品 fixed/100dvh、舞台 absolute、安全区探针、键盘帧、<html> 主题镜像）
 * 经 `@/pi/headless` 的 `PiHeadlessRoot` 拿；不再 import cursor PiRoot / PiLayerProvider / PiStaticProvider。
 * 数据与状态经 VariantAppProps（relay 唯一一份来自 PiApp；切变体不重连、不丢 room/草稿）。
 */
export function CodexApp(props: VariantAppProps) {
  const { relay, ui, act, layout, theme, device, keyboardOpen } = props
  const phone = layout === "phone"
  const stage = device == null
  const kbH = !phone || !keyboardOpen ? 0 : stage ? 336 : Math.max(0, Math.round(device.layoutHeight - device.offsetTop - device.height))
  const style = {
    "--codex-safe-top": phone ? (stage ? "47px" : "env(safe-area-inset-top, 0px)") : "0px",
    "--codex-safe-bottom": phone ? (stage ? "34px" : "env(safe-area-inset-bottom, 0px)") : "0px",
    "--codex-keyboard-h": `${kbH}px`,
    // R7：产品根高度交给 CSS 的 100vh→100dvh 兜底（键盘打开时保留 headless 的 inline auto）
    ...(device != null && !keyboardOpen ? { height: undefined } : null),
  } as CSSProperties
  useLayoutEffect(() => {
    // 首帧后把 <html> 上的变体标记也写一份（设置页卡片切换 / 浮层与首帧脚本共用；只写自己）
    const el = document.documentElement
    el.setAttribute("data-pi-ui", "codex")
    el.setAttribute("data-codex-ui", "codex")
    return () => {
      // P3-①（v2.1 终审）：卸载时只清**自己设的**值 —— 画廊同页换壳 / 产品切变体时，
      // PiApp/首帧脚本/下一套变体可能已经改写 <html> 属性；值不是本变体的就不动，避免误删别人的接管值。
      if (el.getAttribute("data-pi-ui") === "codex") el.removeAttribute("data-pi-ui")
      if (el.getAttribute("data-codex-ui") === "codex") el.removeAttribute("data-codex-ui")
    }
  }, [])
  const content = !relay.token ? <CodexLogin {...props} /> : layout === "desktop" ? <CodexDesktop {...props} /> : <CodexPhone {...props} />
  // 舞台专属：`&cx-approval=confirm` 时叠一张 confirm 形态审批卡预览（对图用，产品态不进入）
  const confirmPreview = stage && typeof location !== "undefined" && location.hash.includes("cx-approval=confirm")
  return (
    <PiHeadlessRoot ui="codex" viewport={layout} theme={theme} keyboard={keyboardOpen} device={device} className="cx-root" style={style}>
      <CodexFrameContext.Provider value={{ stage, layout, theme, keyboardOpen: phone && keyboardOpen, vvHeight: stage ? 900 - kbH : device.height, safeTop: stage && phone ? 47 : 0, safeBottom: phone ? 34 : 0, keyboardH: kbH }}>
        {content}
        {confirmPreview ? <CodexApprovalPreview phone={phone} /> : null}
      </CodexFrameContext.Provider>
      <span className="cx-p4-marker" aria-hidden data-p4-surface="CX-XCUT-01" data-p4-ready="" />
      {/* ui/act 仅供外壳使用：避免 lint 未使用；不改变任何行为 */}
      {ui && act ? null : null}
    </PiHeadlessRoot>
  )
}
