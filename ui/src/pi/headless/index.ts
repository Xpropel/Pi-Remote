/**
 * Headless 基础设施出口（P2.5）：无视觉的根 / 视口 / 隐私 / 发送键 / 公共类型出口。
 * cursor 的 PiRoot 从这里拿布局语义；这里不导出任何视觉组件 / token / CSS。
 */
export * from "./frame"
export * from "./geometry"
export * from "./privacyContext"
export * from "./privacy"
export * from "./root"
export * from "./composerSendKey"
export * from "./sendKeyContext"
export * from "./sendKeyProvider"
export * from "./useComposerEnter"
/** 公共类型出口（checklist D3）：`import type { PiItem, Relay } from "@/pi/headless"` */
export type * from "./types"
