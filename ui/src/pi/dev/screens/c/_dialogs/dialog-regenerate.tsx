import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiRegenerateDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-regenerate",
  area: "c",
  title: "重新回答（G03，开发屏）",
  themes: ["light", "dark"],
  states: ["忙时禁用（「pi 正在输出…」）", "执行中（「正在重新回答…」）", "命令失败（按钮行上方红字，弹窗不关）"],
  notes: "P5 c 线新做，版式推断（design §2 H：PiDialog 确认，360）。命令 regenerate。不进 80 张对图。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiRegenerateDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} />
    </DialogStage>
  )
}
