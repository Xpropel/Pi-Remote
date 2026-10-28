import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiCloneDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-clone",
  area: "c",
  title: "克隆成新会话（G09，开发屏）",
  themes: ["light", "dark"],
  states: ["忙时禁用", "执行中（「正在克隆…」）", "命令失败（红字，弹窗不关）"],
  notes: "P5 c 线新做，版式推断（design §2 H：PiDialog 确认，360）。命令 clone。这一屏画的是命令失败的样子。不进 80 张对图。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiCloneDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} error="克隆失败：pi 正忙，稍后再试" />
    </DialogStage>
  )
}
