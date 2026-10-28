import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeCommandPalette } from "./ClaudeCommandPalette"
import { ClaudeDeleteDialog, ClaudeRenameDialog, ClaudeSessionMenuSheet } from "./ClaudeSessionDialogs"
import { ClaudePairingDialog } from "./ClaudePairingDialog"
import { ClaudeSessionInfoSheet } from "./ClaudeSessionInfoCard"
import { ClaudeDisplayOptions } from "./ClaudeDisplayOptions"

/**
 * 浮层宿主（§0.3：浮层渲染在变体根内部，不用 body portal，保证 [data-pi-ui] 作用域与深色选择器命中）：
 * 命令面板 / 会话菜单 sheet / 删除 / 改名 / 配对 / 会话信息 / 显示选项。
 */
export function ClaudeOverlayHost({ p }: { p: PiContainerProps }) {
  return (
    <>
      <ClaudeCommandPalette p={p} />
      <ClaudeSessionMenuSheet p={p} />
      <ClaudeDeleteDialog p={p} />
      <ClaudeRenameDialog p={p} />
      <ClaudePairingDialog p={p} />
      <ClaudeSessionInfoSheet p={p} />
      <ClaudeDisplayOptions p={p} />
    </>
  )
}

export { ClaudeDialog, ClaudeSheet } from "../primitives/ClaudePrimitives"
