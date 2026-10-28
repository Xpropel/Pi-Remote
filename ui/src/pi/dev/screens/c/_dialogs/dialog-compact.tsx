import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiCompactDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-compact",
  area: "c",
  title: "压缩上下文（G04，开发屏）",
  themes: ["light", "dark"],
  states: ["压缩中（「压缩中…」）", "完成（写前后 token + 「完成」）", "命令失败（「压缩失败：pi 正忙」，按钮恢复可点）"],
  notes: "P5 c 线新做，版式推断（design §2 H：可选总结要求 + 黑色「开始压缩」，480）。这一屏是填了总结要求、命令失败的样子。不进 80 张对图。",
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiCompactDialog
        static
        viewport={viewport}
        subtitle={DIALOG_SESSION_TITLE}
        instructions="保留改过的文件和还没解决的问题"
        error="压缩失败：pi 正忙"
      />
    </DialogStage>
  )
}
