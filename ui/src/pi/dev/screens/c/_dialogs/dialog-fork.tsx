import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiForkDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-fork",
  area: "c",
  title: "从消息分叉（G08，开发屏）",
  themes: ["light", "dark"],
  states: ["冷分叉（未载入会话：文件名 + 「开始分叉」）", "没有可分叉的用户消息", "读取失败 · 重试", "分叉中（行尾「分叉中…」）"],
  notes: "P5 c 线新做，版式推断（design §2 H：PiDialog + 用户消息列表，480）。get_fork_messages 的消息是 mock。不进 80 张对图。",
}

const MESSAGES = [
  { id: "e-41a", text: "横屏的时候也测一下，键盘弹出时输入框要一直贴着键盘" },
  { id: "e-37c", text: "看一下 useMobileViewport 在 iOS 上的取值" },
  { id: "e-30f", text: "修复手机键盘收起时输入框跳动" },
]

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiForkDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} messages={MESSAGES} />
    </DialogStage>
  )
}
