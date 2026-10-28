import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { CONVO_ERRORS, NOW } from "@/pi/dev/fixtures/gallery/b"
import { PiStreamTopLine } from "@/components/pi/conversation/PiStreamLines"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "stream-errors",
  area: "b",
  title: "对话里的错误",
  states: [
    "已停止生成（灰字「已停止生成」）",
    "达到长度上限",
    "没有文字回复",
    "压缩失败（「压缩上下文失败：…」）",
    "extension_error（PiTurnError「扩展出错：…」）",
    "自动重试中（「自动重试 2/3 · 5 秒后」+ Spinner）",
    "8 秒未确认（PiNoticeCard warning「发送确认超时」）",
    "停止失败（PiNoticeCard error + 重试）",
  ],
  notes:
    "D02 D18 F11 F12 F13。r-s6（Mac Studio/billing-service）一屏放下各种出错：补拉失败、终端卡失败（展开，stderr 红字）、已拒绝 / 超时两条灰字行、自动重试收据、回合出错（overloaded_error）+ 重新回答、用户卡发送失败 + 重试。进入会话即清掉它的出错红点。重试收据写最终态「3/3 都没成功」（瞬时的「2/3 · 5 秒后」进 states）。终端卡失败态推断（run-brief ⑦）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock variant={variant} state="S0" model={C_MODEL_LABEL} status={{ device: "Mac Studio" }} />
  )
  const transcript = (
    <PiTranscript
      static
      items={CONVO_ERRORS}
      variant={variant}
      now={NOW}
      expanded={["toolu_03Bs1a"]}
      topLine={<PiStreamTopLine lines={[{ text: "更早的消息加载失败", action: "重试" }]} />}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhoneChat roomId="r-s6" dock={dock}>
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="r-s6" dock={dock}>
          {transcript}
        </BDesktop>
      )}
    </PiRoot>
  )
}
