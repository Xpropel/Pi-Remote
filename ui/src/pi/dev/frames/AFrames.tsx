import type { ReactNode } from "react"
import {
  MOCK_ATTENTION,
  MOCK_DEVICES,
  MOCK_LINK,
  MOCK_NOW,
  mockDevice,
  mockSession,
  piAttentionOnOpen,
  piLinkSummary,
  piOtherAttentionCount,
  piSessionGroups,
} from "@/pi/dev/fixtures/gallery/shared"
import {
  PiAccountFooter,
  PiDesktopShell,
  PiPhonePage,
  PiSidebar,
  PiTopBar,
  type PiAttentionItem,
  type PiDevice,
  type PiLinkSummary,
  type PiSessionGroup,
} from "@/components/pi/shared"

/** 会话标题与设备（在 shared mock 里查） */
export function aHead(roomId: string | undefined): { title?: string; platform?: string; device?: PiDevice } {
  const s = roomId ? mockSession(roomId) : undefined
  const device = mockDevice(s?.deviceId)
  return { title: s?.title, platform: device?.platform, device }
}

/** 左栏 / 手机列表共用的选项（都有默认值：全部设备、MOCK_ATTENTION、已连接） */
export interface ASidebarOptions {
  selectedId?: string
  hoverId?: string
  contextId?: string
  groups?: PiSessionGroup[]
  /** 不传 = MOCK_ATTENTION；桌面有当前会话时再按 piAttentionOnOpen 清掉它的完成 / 出错条目（同 b 的 BFrames） */
  attention?: PiAttentionItem[]
  link?: PiLinkSummary
  /** 替换分组区（搜索结果） */
  sidebarBody?: ReactNode
  loading?: boolean
  listNote?: string
  footerPressed?: "options" | "settings"
  navSelected?: "new" | "search" | null
  filter?: string | null
  devices?: PiDevice[]
}

export interface ADesktopProps extends ASidebarOptions {
  /** 不传 = 当前会话（selectedId）的标题 + 设备图标 */
  topBar?: ReactNode
  statusLine?: ReactNode
  notice?: ReactNode
  children?: ReactNode
  dock?: ReactNode
  overlay?: ReactNode
}

/** 1440：PiDesktopShell + PiSidebar(expanded) + PiTopBar(desktop) */
export function ADesktop({
  selectedId,
  hoverId,
  contextId,
  groups,
  attention: attentionProp,
  link,
  sidebarBody,
  loading,
  listNote,
  footerPressed,
  navSelected,
  filter,
  devices = MOCK_DEVICES,
  topBar,
  statusLine,
  notice,
  children,
  dock,
  overlay,
}: ADesktopProps) {
  const head = aHead(selectedId)
  // 进入会话即清掉它的「完成 / 出错」注意力（design §5）；分组行的行首标记与需要处理组用同一份
  const attention = attentionProp ?? piAttentionOnOpen(selectedId, MOCK_ATTENTION)
  return (
    <PiDesktopShell
      sidebar={
        <PiSidebar
          variant="expanded"
          groups={groups ?? piSessionGroups({ devices, attention })}
          attention={attention}
          selectedId={selectedId}
          hoverId={hoverId}
          contextId={contextId}
          filter={filter}
          body={sidebarBody}
          loading={loading}
          listNote={listNote}
          link={link ?? piLinkSummary(MOCK_LINK, devices)}
          footerPressed={footerPressed}
          navSelected={navSelected}
          now={MOCK_NOW}
          devices={devices}
        />
      }
      topBar={topBar ?? <PiTopBar variant="desktop" title={head.title} platform={head.platform} />}
      statusLine={statusLine}
      notice={notice}
      dock={dock}
      overlay={overlay}
    >
      {children}
    </PiDesktopShell>
  )
}

/** 主区没有会话时的顶栏：空的 44 高条（不放标题和右端按钮） */
export function AEmptyTopBar() {
  return <PiTopBar variant="desktop" showActions={false} />
}

export interface APhoneListProps extends ASidebarOptions {
  /** 不传 = 列表页顶栏（PiMark + Pi-Remote，右侧搜索 / 新建） */
  topBar?: ReactNode
  statusLine?: ReactNode
  notice?: ReactNode
  sheet?: ReactNode
  /** 替换整个列表正文（no-devices 的居中块） */
  children?: ReactNode
  contentClassName?: string
  /** 账户栏：不传 = PiAccountFooter(phone)；null = 不要（搜索态） */
  footer?: ReactNode | null
}

/** 390 列表页：PiPhonePage + PiTopBar(phone-list) + PiSidebar(phone) + PiAccountFooter(phone) */
export function APhoneList({
  selectedId,
  hoverId,
  contextId,
  groups,
  attention = MOCK_ATTENTION,
  link,
  sidebarBody,
  loading,
  listNote,
  footerPressed,
  filter,
  devices = MOCK_DEVICES,
  topBar,
  statusLine,
  notice,
  sheet,
  children,
  contentClassName,
  footer,
}: APhoneListProps) {
  const summary = link ?? piLinkSummary(MOCK_LINK, devices)
  return (
    <PiPhonePage
      topBar={topBar ?? <PiTopBar variant="phone-list" />}
      statusLine={statusLine}
      notice={notice}
      footer={footer === undefined ? <PiAccountFooter link={summary} variant="phone" pressed={footerPressed} /> : footer}
      sheet={sheet}
      contentClassName={contentClassName}
    >
      {children ?? (
        <PiSidebar
          variant="phone"
          groups={groups ?? piSessionGroups({ devices, attention })}
          attention={attention}
          selectedId={selectedId}
          hoverId={hoverId}
          contextId={contextId}
          filter={filter}
          body={sidebarBody}
          loading={loading}
          listNote={listNote}
          link={summary}
          now={MOCK_NOW}
          devices={devices}
        />
      )}
    </PiPhonePage>
  )
}

export interface APhoneChatProps {
  roomId: string
  attention?: PiAttentionItem[]
  statusLine?: ReactNode
  notice?: ReactNode
  sheet?: ReactNode
  children?: ReactNode
  dock?: ReactNode
}

/** 390 对话页：‹ 返回（其他会话的注意力计数）+ 标题 + 设备图标 + …；流贴底；dock 左右 16 */
export function APhoneChat({ roomId, attention = MOCK_ATTENTION, statusLine, notice, sheet, children, dock }: APhoneChatProps) {
  const head = aHead(roomId)
  return (
    <PiPhonePage
      topBar={
        <PiTopBar
          variant="phone-chat"
          title={head.title}
          platform={head.platform}
          backCount={piOtherAttentionCount(roomId, attention, head.device?.id)}
        />
      }
      statusLine={statusLine}
      notice={notice}
      dock={dock != null ? <div className="px-4 pt-2">{dock}</div> : undefined}
      sheet={sheet}
      scrollTop="bottom"
    >
      {children}
    </PiPhonePage>
  )
}
