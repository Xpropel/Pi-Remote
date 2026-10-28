import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import {
  CONVO_STREAMING,
  LIVE_EXPANDED,
  LIVE_RUNNING,
  LIVE_SUBAGENTS,
  NOW,
  TRAY_CHANGES,
  TRAY_TASKS,
  TRAY_TERMINAL,
} from "@/pi/dev/fixtures/gallery/b"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "conversation-streaming",
  area: "b",
  title: "对话 · 运行中",
  themes: ["light", "dark"],
  states: [
    "S4（已输入：黑圆 ↑ + 左侧裸方块停止）",
    "用户上滑（tray 右端回到底部钮，带「3 条新消息」）",
    "压缩中（流内「正在压缩上下文…」+ Spinner）",
    "自动重试中（「自动重试 2/3 · 5 秒后」）",
    "没有 agent_state（不出现 subagent 行）",
    "Esc 停止（K06）",
    "思考中（live：「思考中 ∨」+ 阶段小标题 + 正文，见说明）",
    "正文流式（与完成态外观相同，无光标竖条）",
  ],
  notes:
    "D06 D10 D13 D21 F01 F03 F04 B13 E03 E04。取「工具执行中」这一刻：pi 执行工具时模型不在生成，所以思考块已结束（思考 5 秒）但运行中保持展开（推断），终端卡运行中、只露最后 4 行；正文写在 bash 之前。subagent 行来自 agent_state（mock 1 条，startedAt NOW−36s）。终端卡状态整套推断（run-brief ⑦）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S3"
      model={C_MODEL_LABEL}
      tray={[TRAY_TASKS, TRAY_TERMINAL, TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main", delivery: "steer", running: true }}
    />
  )
  const transcript = (
    <PiTranscript
      static
      items={CONVO_STREAMING}
      variant={variant}
      now={NOW}
      running={LIVE_RUNNING}
      subagents={LIVE_SUBAGENTS}
      expanded={LIVE_EXPANDED}
    />
  )
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhoneChat roomId="r-s1" dock={dock}>
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="r-s1" dock={dock}>
          {transcript}
        </BDesktop>
      )}
    </PiRoot>
  )
}
