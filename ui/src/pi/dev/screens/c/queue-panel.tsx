import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
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
import { PiComposerDock, type PiTrayItem } from "@/components/pi/composer"
import { CDesktop, CPhoneChat } from "@/pi/dev/frames/CFrames"
import { C_HOST_QUEUE, C_MODEL_LABEL, C_NOW, C_REMOTE_QUEUE, queueWaitingCount } from "@/pi/dev/fixtures/gallery/c"
import { PiQueuePanel } from "@/components/pi/composer/PiQueuePanel"
import { PiRoot, PiSheet } from "@/components/pi/shared"

export const piScreen: PiScreenMeta = {
  id: "queue-panel",
  area: "c",
  title: "排队面板",
  states: [
    "编辑中（就地文本框 + 「保存 / 取消」；被截断的条目先「正在拉取全文…」）",
    "冲突（「这条刚在别处改过 · 用我的 / 用新的」）",
    "立即发送（按设置走「打断当前操作」或「等当前工具结束」）",
    "发送失败（红字「发送失败 · 重试」）",
    "离线 outbox（面板第一段「本页待发 · 等重连」，每行带「取消」；回放失败的行红字「发送失败 · 重试 / 取消」；tray pill 写「排队 N · 等重连」，N 含 outbox）",
    "编辑中的手机 sheet 遇到键盘（PiSheet keyboardOpen，按 sheetLayout（pi/model/phoneDock.ts）贴可视视口：sheet 高 ≤ 508 − 47 − 24 = 437，「保存 / 取消」钉在键盘上沿，底部内边距 8，内容区内滚动）",
  ],
  notes:
    "F08 F09。运行中的 r-s1：remote_queue_state rev 12（q1 等这轮结束、q2 已插入当前回合）+ 本机 queue_update（followUp 1 条，只读）；tray「排队 2」= 仍在等的条目（q1 + 本机 1）。排队消息编辑 / 取消属 run-brief ⑦ 未核实项，面板版式整套推断。mock 改动：q1 正文、q2 时间（见 c/mock.ts 注释）。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const queuePill: PiTrayItem = { kind: "queue", label: `排队 ${queueWaitingCount()}`, active: true }
  const dock = (
    <PiComposerDock static
      variant={variant}
      state="S3"
      model={C_MODEL_LABEL}
      tray={[TRAY_TASKS, queuePill, TRAY_TERMINAL, TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main", delivery: "steer", running: true }}
      panel={phone ? undefined : <PiQueuePanel static variant="desktop" remote={C_REMOTE_QUEUE} host={C_HOST_QUEUE} now={C_NOW} />}
    />
  )
  const transcript = (
    <PiTranscript
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
        <CPhoneChat
          roomId="r-s1"
          dock={dock}
          sheet={
            <PiSheet static title="排队" subtitle={`${queueWaitingCount()} 条在等`} size="half" bodyClassName="px-4">
              <PiQueuePanel static variant="phone" remote={C_REMOTE_QUEUE} host={C_HOST_QUEUE} now={C_NOW} bare />
            </PiSheet>
          }
        >
          {transcript}
        </CPhoneChat>
      ) : (
        <CDesktop roomId="r-s1" dock={dock}>
          {transcript}
        </CDesktop>
      )}
    </PiRoot>
  )
}
