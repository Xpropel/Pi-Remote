import type { PiContainerProps } from "./types"
import { CursorUnifiedSidebar } from "./CursorUnifiedSidebar"

/**
 * Cursor 桌面侧栏容器（P11）：产品 active 路径唯一实现 = 共享 UnifiedSidebar（style=cursor，272）。
 * 旧 `components/pi/shared/PiSidebar` 仅保留给 dev 画廊静态屏；手机列表页已由 `MobileNavShell` 托管，
 * 本容器不再有 phone 分支 / PhoneAccountFooter（Cursor 手机壳 phone 分支已删除）。
 */
export function SidebarContainer(props: PiContainerProps) {
  return <CursorUnifiedSidebar p={props} />
}
