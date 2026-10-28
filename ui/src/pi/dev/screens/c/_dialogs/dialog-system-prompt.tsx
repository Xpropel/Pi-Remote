import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiSystemPromptDialog } from "@/components/pi/composer"
import { DIALOG_SESSION_TITLE, DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-system-prompt",
  area: "c",
  title: "系统提示词（G15，开发屏）",
  themes: ["light", "dark"],
  states: ["不支持读取（只写原因）", "加载中", "读取失败 · 重试"],
  notes: "P5 c 线新做，版式推断（design §2 H：全文 + 字数 + 截断标记，560）。提示词是 mock，这一屏画的是截断的样子。不进 80 张对图。",
}

const PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "You help users by reading files, executing commands, editing code, and writing new files.",
  "",
  "Available tools:",
  "- read: Read file contents",
  "- bash: Execute bash commands",
  "- edit: Make surgical edits to files",
  "- write: Create or overwrite files",
].join("\n")

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiSystemPromptDialog static viewport={viewport} subtitle={DIALOG_SESSION_TITLE} view={{ kind: "prompt", text: PROMPT, truncated: true, chars: 18240 }} chars={18240} />
    </DialogStage>
  )
}
