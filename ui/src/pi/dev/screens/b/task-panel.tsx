import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import {
  CONVO_STREAMING,
  LIVE_EXPANDED,
  LIVE_RUNNING,
  LIVE_SUBAGENTS,
  NOW,
  TASKS,
  TRAY_CHANGES,
  TRAY_TASKS,
  TRAY_TERMINAL,
} from "@/pi/dev/fixtures/gallery/b"
import { PiTaskPanel, PiTaskRows, taskProgress } from "@/components/pi/conversation/PiTaskPanel"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import { PiRoot, PiSheet } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "task-panel",
  area: "b",
  title: "任务面板",
  states: ["全部完成（pill 短暂高亮一次后保留）", "回合结束后（面板仍可看）", "空数组（不出现 pill）"],
  notes:
    "F02 D13。运行中的 r-s1，task_list_state 4 项（2 完成 / 1 进行中 / 1 待做）→ tray「任务 2/4」选中。桌面：tray 上方浮层宽 360；手机：半高 PiSheet「任务」，行高 48。面板版式整套推断（run-brief ⑦：tray 面板展开态未核实）；去掉了现有的蓝色进度条。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const { done, total } = taskProgress(TASKS)
  const dock = (
    <PiComposerDock
      variant={variant}
      state="S3"
      model={C_MODEL_LABEL}
      tray={[{ ...TRAY_TASKS, active: true }, TRAY_TERMINAL, TRAY_CHANGES]}
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
        <BPhoneChat
          roomId="r-s1"
          dock={dock}
          sheet={
            <PiSheet static title="任务" subtitle={`${done}/${total} 完成`} size="half">
              <PiTaskRows tasks={TASKS} variant="phone" />
            </PiSheet>
          }
        >
          {transcript}
        </BPhoneChat>
      ) : (
        <BDesktop roomId="r-s1" dock={dock}>
          {transcript}
          {/* tray 上方的浮层：与对话列左对齐（tray 第一颗 pill 就是「任务」） */}
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 px-(--cw-pi-chat-gutter)">
            <div className="mx-auto w-full max-w-(--cw-pi-chat-w)">
              <PiTaskPanel tasks={TASKS} className="pointer-events-auto" />
            </div>
          </div>
        </BDesktop>
      )}
    </PiRoot>
  )
}
