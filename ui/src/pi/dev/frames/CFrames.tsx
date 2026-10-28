import type { ReactNode } from "react"
import { CONVO_DONE, NOW } from "@/pi/dev/fixtures/gallery/b"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
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
import type { CVariant } from "@/components/pi/composer/styles"

/**
 * c 区屏幕的外框（只排版，不含 c 区自己的部件）：桌面 = 左栏 + 顶栏 + 正文 + dock；手机 = 对话页。
 * 背景里的对话流用 b 区导出的 PiTranscript + CONVO_DONE（r-s1 最后一个回合，design §6.4）。
 */

/** 当前会话 r-s1 的标题与设备（shared mock 里查） */
export function sessionHead(roomId: string): { title: string; platform?: string; device?: string } {
  const s = mockSession(roomId)
  const d = mockDevice(s?.deviceId)
  return { title: s?.title ?? roomId, platform: d?.platform, device: d?.name }
}

/** 背景里的对话流：r-s1 已完成的回合，贴底 */
export function CTranscript({ variant }: { variant: CVariant }) {
  return <PiTranscript items={CONVO_DONE} variant={variant} now={NOW} />
}

export interface CDesktopProps {
  /** 当前会话：左栏选中、顶栏标题；不传 = 没有选中会话（新建会话页） */
  roomId?: string
  children?: ReactNode
  dock?: ReactNode
  overlay?: ReactNode
  notice?: ReactNode
  /** 不画顶栏（新建会话、设置页自己排） */
  noTopBar?: boolean
  navSelected?: "new" | "search" | null
  footerPressed?: "options" | "settings"
}

/** 1440：左栏（全部设备、需要处理组）+ 顶栏（标题 + 设备图标）+ 正文 + dock */
export function CDesktop({ roomId, children, dock, overlay, notice, noTopBar, navSelected, footerPressed }: CDesktopProps) {
  const head = roomId ? sessionHead(roomId) : null
  return (
    <PiDesktopShell
      sidebar={
        <PiSidebar
          variant="expanded"
          groups={piSessionGroups()}
          attention={MOCK_ATTENTION}
          selectedId={roomId}
          link={piLinkSummary(MOCK_LINK)}
          navSelected={navSelected}
          footerPressed={footerPressed}
          now={MOCK_NOW}
          devices={MOCK_DEVICES}
        />
      }
      topBar={head && !noTopBar ? <PiTopBar variant="desktop" title={head.title} platform={head.platform} /> : undefined}
      notice={notice}
      dock={dock}
      overlay={overlay}
    >
      {children}
    </PiDesktopShell>
  )
}

export interface CPhoneChatProps {
  roomId: string
  children?: ReactNode
  dock?: ReactNode
  sheet?: ReactNode
  keyboardOpen?: boolean
  /** 默认贴底 */
  scrollTop?: number | "bottom"
}

/** 390 对话页：‹ 返回（带其他会话的注意力计数）+ 标题 + 设备图标 + …；流贴底；dock 左右 16 */
export function CPhoneChat({ roomId, children, dock, sheet, keyboardOpen, scrollTop = "bottom" }: CPhoneChatProps) {
  const head = sessionHead(roomId)
  return (
    <PiPhonePage
      topBar={
        <PiTopBar variant="phone-chat" title={head.title} platform={head.platform} backCount={piOtherAttentionCount(roomId)} />
      }
      dock={dock != null ? <div className="px-4 pt-2">{dock}</div> : undefined}
      sheet={sheet}
      keyboardOpen={keyboardOpen}
      scrollTop={scrollTop}
    >
      {children}
    </PiPhonePage>
  )
}
