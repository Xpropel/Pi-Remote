import type { ReactNode } from "react"
import {
  MOCK_ATTENTION,
  MOCK_DEVICES,
  MOCK_LINK,
  MOCK_NOW,
  mockDevice,
  mockSession,
  piLinkSummary,
  piOtherAttentionCount,
  piSessionGroups,
} from "@/pi/dev/fixtures/gallery/shared"
import {
  PiDesktopShell,
  PiPhonePage,
  PiSidebar,
  PiTopBar,
} from "@/components/pi/shared"

/** 会话标题与设备平台（shared mock 里查；查不到就用传入的兜底） */
export function sessionHead(roomId: string): { title: string; platform?: string; device?: string } {
  const s = mockSession(roomId)
  const d = mockDevice(s?.deviceId)
  return { title: s?.title ?? roomId, platform: d?.platform, device: d?.name }
}

export interface BDesktopProps {
  /** 当前会话（左栏选中、顶栏标题） */
  roomId: string
  children: ReactNode
  dock?: ReactNode
  pane?: ReactNode
  overlay?: ReactNode
  statusLine?: ReactNode
  notice?: ReactNode
}

/**
 * 进入会话即清除它的"完成 / 出错"注意力（§5）；"等你回答"要等回答了才清，所以保留。
 */
export function attentionFor(roomId: string) {
  return MOCK_ATTENTION.filter((a) => !(a.roomId === roomId && a.kind !== "waiting"))
}

/** 1440：左栏（全部设备、需要处理组）+ 顶栏（标题 + 设备图标）+ 正文 + dock（+ 右 pane） */
export function BDesktop({ roomId, children, dock, pane, overlay, statusLine, notice }: BDesktopProps) {
  const head = sessionHead(roomId)
  const attention = attentionFor(roomId)
  return (
    <PiDesktopShell
      sidebar={
        <PiSidebar
          variant="expanded"
          groups={piSessionGroups({ attention })}
          attention={attention}
          selectedId={roomId}
          link={piLinkSummary(MOCK_LINK)}
          now={MOCK_NOW}
          devices={MOCK_DEVICES}
        />
      }
      topBar={<PiTopBar variant="desktop" title={head.title} platform={head.platform} paneOpen={pane != null} />}
      statusLine={statusLine}
      notice={notice}
      dock={dock}
      pane={pane}
      overlay={overlay}
    >
      {children}
    </PiDesktopShell>
  )
}

export interface BPhoneChatProps {
  roomId: string
  children: ReactNode
  dock?: ReactNode
  sheet?: ReactNode
  statusLine?: ReactNode
  /** 默认贴底 */
  scrollTop?: number | "bottom"
}

/** 390 对话页：‹ 返回（带其他会话的注意力计数）+ 标题 + 设备图标 + …；流贴底；dock 左右 16 */
export function BPhoneChat({ roomId, children, dock, sheet, statusLine, scrollTop = "bottom" }: BPhoneChatProps) {
  const head = sessionHead(roomId)
  return (
    <PiPhonePage
      topBar={
        <PiTopBar
          variant="phone-chat"
          title={head.title}
          platform={head.platform}
          backCount={piOtherAttentionCount(roomId)}
        />
      }
      statusLine={statusLine}
      dock={dock != null ? <div className="px-4 pt-2">{dock}</div> : undefined}
      sheet={sheet}
      scrollTop={scrollTop}
    >
      {children}
    </PiPhonePage>
  )
}

/**
 * 390 推入页（终端 / 改动 / 文件）：‹ + 可切换的页名；工具行（PiTerminalToolbar / PiFileToolbar）放进
 * PiPhonePage.subHeader 钉在顶栏下，不随正文滚走（M-10）；正文顺着页面唯一的滚动区往下排（§4.5）
 */
export function BPhonePushed({ title, subHeader, children }: { title: ReactNode; subHeader?: ReactNode; children: ReactNode }) {
  return (
    <PiPhonePage
      topBar={<PiTopBar variant="phone-page" title={title} className="border-b border-(--cw-divider)" />}
      subHeader={subHeader}
    >
      {children}
    </PiPhonePage>
  )
}
