import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiHostSettingsDialog } from "@/components/pi/composer"
import { jsonTextOf } from "@/pi/model/dialogsData"
import { DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-host-settings",
  area: "c",
  title: "本机设置（G14，开发屏）",
  themes: ["light", "dark"],
  states: ["加载中", "读取失败 · 重试", "内容很长（截断说明）"],
  notes: "P5 c 线新做，版式推断（design §2 H：JSON，敏感键 ***，560）。get_settings 的内容是 mock。不进 80 张对图。",
}

const SETTINGS = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  defaultThinkingLevel: "medium",
  theme: "dark",
  shellPath: "/bin/zsh",
  apiKeys: { anthropic: "***", openai: "***" },
  compaction: { enabled: true, reserveTokens: 16384 },
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiHostSettingsDialog static viewport={viewport} subtitle="MacBook Pro" json={jsonTextOf(SETTINGS).text} />
    </DialogStage>
  )
}
