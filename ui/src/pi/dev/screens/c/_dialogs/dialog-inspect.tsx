import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiInspectDialog } from "@/components/pi/composer"
import { INSPECT_PAGES, jsonTextOf } from "@/pi/model/dialogsData"
import { DialogStage } from "./_frame"

export const piScreen: PiScreenMeta = {
  id: "dialog-inspect",
  area: "c",
  title: "检视本机信息（G18，开发屏）",
  themes: ["light", "dark"],
  states: ["扩展 flags（多一行说明）", "加载中", "读取失败 · 重试"],
  notes: "P5 c 线新做，版式推断（design §2 H：分类页签 + JSON，560；入口在命令面板「检视本机信息」）。这一屏选的是「Provider 认证」，内容是 mock。不进 80 张对图。",
}

const AUTH = {
  anthropic: { type: "api_key", configured: true },
  openai: { type: "api_key", configured: true },
  google: { type: "oauth", configured: true },
  qwen: { configured: false },
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiInspectDialog static viewport={viewport} subtitle="MacBook Pro" pages={INSPECT_PAGES} active="auth" json={jsonTextOf(AUTH).text} />
    </DialogStage>
  )
}
