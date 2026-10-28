import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiSessionStateDialog } from "@/components/pi/composer"
import { sessionStateRowsOf } from "@/pi/model/dialogsData"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-session-state",
  area: "c",
  title: "当前状态（G17，开发屏）",
  themes: ["light", "dark"],
  states: ["加载中", "读取失败 · 重试"],
  notes: "P5 c 线新做，版式推断（design §2 H：键值行，标签灰 / 数值黑右对齐，480）。get_state 的回包是 mock，经 sessionStateRowsOf 排成行。不进 80 张对图。",
}

const STATE = {
  sessionName: "修复手机键盘收起时输入框跳动",
  cwd: "/Users/dev/code/pi-remote",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  thinkingLevel: "medium",
  messageCount: 48,
  pendingMessageCount: 0,
  mode: "interactive",
  hasUI: true,
  projectTrusted: true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  isStreaming: false,
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiSessionStateDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} rows={sessionStateRowsOf(STATE)} />
    </DialogStage>
  )
}
