import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { A_NOTICE } from "@/pi/dev/fixtures/gallery/a"
import { ADesktop, APhoneChat } from "@/pi/dev/frames/AFrames"
import { ADock, ATranscript } from "@/pi/dev/frames/AConversation"
import { PiNoticeCard, PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "background-alerts",
  area: "a",
  title: "通知与后台提醒",
  states: [
    "info（「「整理 README 的配对步骤」完成了 · 查看」，5 秒）",
    "success（4 秒）",
    "error（不自动消失）",
    "同 key 合并（标题后「×3」）",
    "标签页标题（「● 修复手机键盘… · pi」运行中、「✓ …」后台跑完、「已断开 · …」）",
    "favicon（灰底 PiMark + 蓝点 = 完成 / 红色『!』圆 = 出错）",
    "提示音（无画面，设置里开关）",
  ],
  notes:
    "F10 A05 I01 I02 C09。从后台回到页面：relay 重启过（boot 变了），一条有副作用的命令（压缩上下文）结果未知，不自动重发；后面还排着 2 条通知（右上「+2」）。桌面通知卡在主区顶栏下 12px 居中、宽 420，不压 dock；手机在顶栏下整宽减 32，返回键「‹ 4」= 其他会话的注意力条数。需要处理组照常在左栏。推断：通知卡样式（Cursor 帧里没有通知卡）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const notice = (
    <PiNoticeCard
      level={A_NOTICE.level}
      title={A_NOTICE.title}
      body={A_NOTICE.body}
      actions={A_NOTICE.actions}
      count={A_NOTICE.count}
      variant={phone ? "phone" : "desktop"}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <APhoneChat roomId="r-s1" notice={notice} dock={<ADock variant="phone" />}>
          <ATranscript variant="phone" />
        </APhoneChat>
      ) : (
        <ADesktop selectedId="r-s1" notice={notice} dock={<ADock variant="desktop" />}>
          <ATranscript variant="desktop" />
        </ADesktop>
      )}
    </PiRoot>
  )
}
