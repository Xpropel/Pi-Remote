import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiToolsDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-tools",
  area: "c",
  title: "工具（G16，开发屏）",
  themes: ["light", "dark"],
  states: ["全表拿不到（只列已启用的）", "保存中（「保存中…」）", "保存失败（红字，弹窗不关）"],
  notes: "P5 c 线新做，版式推断（design §2 H：勾选行（kit Checkbox variant=menu）+ 保存，560）。工具清单是 mock；这一屏取消勾选了 write，「保存」可点。不进 80 张对图。",
}

const ROWS = [
  { name: "read", description: "Read the contents of a file" },
  { name: "bash", description: "Execute a bash command in the current working directory" },
  { name: "edit", description: "Edit a file by replacing exact text" },
  { name: "write", description: "Write content to a file" },
  { name: "grep", description: "Search file contents" },
]

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiToolsDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} rows={ROWS} selected={["read", "bash", "edit"]} dirty />
    </DialogStage>
  )
}
