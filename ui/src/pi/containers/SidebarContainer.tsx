import type { PiTheme } from "@/components/pi/shared/viewport"
import type { SidebarDrawerControl } from "@/pi/hooks/useSidebarDrawer"
import type { PiContainerProps } from "./types"
import { CursorUnifiedSidebar } from "./CursorUnifiedSidebar"

/**
 * Cursor 桌面侧栏容器（P11）：产品 active 路径唯一实现 = 共享 UnifiedSidebar（style=cursor，272）。
 * 旧 `components/pi/shared/PiSidebar` 仅保留给 dev 画廊静态屏；手机列表页已由 `MobileNavShell` 托管，
 * 本容器不再有 phone 分支 / PhoneAccountFooter（Cursor 手机壳 phone 分支已删除）。
 * theme = 宿主解析好的主题（切换主题时侧栏同一帧跟着变，不等 <html> 属性写回）。
 * drawer = 平板档的浮层控制（DesktopApp 只在 768–1023 传）：窄栏 / 展开跟它走，不读写桌面偏好。
 */
export function SidebarContainer(props: PiContainerProps & { theme?: PiTheme; drawer?: SidebarDrawerControl }) {
  const { theme, drawer, ...p } = props
  return <CursorUnifiedSidebar p={p} theme={theme} drawer={drawer} />
}
