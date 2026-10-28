import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { AAnchored, PiSessionMenu, type PiSessionMenuSession } from "@/components/pi/shell"
import { ADesktop, APhoneList } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { PiRoot, PiSheet, piBaseName } from "@/components/pi/shared"
import { mockDevice, mockSession } from "@/pi/dev/fixtures/gallery/shared"

export const piScreen: PiScreenMeta = {
  id: "session-menu",
  area: "a",
  title: "会话菜单",
  states: [
    "未载入会话（首项「启用会话」，「从消息分叉…」换成「分叉会话（未载入）…」）",
    "忙时禁用项（灰字，悬停 tooltip 写原因：pi 正忙，等这一轮结束）",
    "删除武装（「再点一次删除」）",
    "改名弹窗（G11：PiDialog 输入 + 黑色「保存」，去空白后非空）",
    "改名输入框聚焦、键盘弹出（手机 PiDialog = PiSheet keyboardOpen，按 §4.3 sheetLayout（pi/model/phoneDock.ts）贴可视视口：sheet 高 ≤ 508 − 47 − 24 = 437，「保存 / 取消」钉在键盘上沿，底部内边距 8，内容区内滚动；桌面无键盘，不变）",
    "删除确认（G13：PiDialog 危险确认；当前会话不可删，菜单项禁用）",
  ],
  notes:
    "C12 B04 G11 G13 J07。对 r-s4「整理 README 的配对步骤」打开：桌面右键（行保持选中底，菜单从指针处展开，宽 240）；手机长按 → 列表压暗 + PiSheet（头部两行，行 48，红字删除在最后，没有「在新标签页打开」）。顶栏 … 打开的是同一组项 + 「复制工作目录」（B04，未出图）。推断：菜单项图标。",
}

const ROOM = "r-s4"

function menuSession(): PiSessionMenuSession {
  const s = mockSession(ROOM)
  return {
    title: s?.title ?? ROOM,
    messageCount: s?.messageCount ?? 0,
    sessionId: s?.sessionId ?? ROOM,
    openable: s?.openable ?? false,
    current: false,
    busy: s?.busy ?? false,
  }
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const session = menuSession()
  const s = mockSession(ROOM)
  const device = mockDevice(s?.deviceId)
  if (phone) {
    return (
      <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
        <APhoneList
          contextId={ROOM}
          sheet={
            <PiSheet static title={session.title} subtitle={`${device?.name ?? ""}/${piBaseName(s?.cwd ?? "")} · ${session.messageCount} 条`}>
              <PiSessionMenu static variant="phone" session={session} />
            </PiSheet>
          }
        />
      </PiRoot>
    )
  }
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      <ADesktop
        selectedId="r-s1"
        contextId={ROOM}
        dock={<ADock variant="desktop" />}
        overlay={
          <AAnchored
            selector={`[data-pi-row="${ROOM}"][data-context-target]`}
            place={(r) => ({ left: r.left + 128, top: r.top + 17 })}
          >
            <PiSessionMenu static variant="desktop" session={session} />
          </AAnchored>
        }
      >
        <ATranscript variant="desktop" />
      </ADesktop>
    </PiRoot>
  )
}
