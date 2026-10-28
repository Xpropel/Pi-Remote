import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiExportDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-export",
  area: "c",
  title: "导出会话（G12，开发屏）",
  themes: ["light", "dark"],
  states: ["已载入会话（export_session，只有文本）", "导出已截断（全文字数）", "超过 512KB（读取失败 · 原因）", "还没有可导出的内容"],
  notes: "P5 c 线新做，版式推断（design §2 H：文本预览 + 复制 / 下载 .txt，≤512KB，560）。这一屏是未载入会话的导出（多一行格式分段）。文本是 mock。不进 80 张对图。",
}

const TEXT = [
  "# 修复手机键盘收起时输入框跳动",
  "",
  "## user",
  "键盘收起时输入框会跳一下，看一下 useMobileViewport。",
  "",
  "## assistant",
  "visualViewport 的 resize 在收起键盘时先于 scroll 到达，offsetTop 还没归零……",
].join("\n")

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiExportDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} cold text={TEXT} sizeNote="按这个文件的活动分支转换，共 38 KB / 12,040 字符" />
    </DialogStage>
  )
}
