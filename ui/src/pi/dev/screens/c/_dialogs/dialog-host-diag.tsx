import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { PiHostDiagDialog } from "@/components/pi/composer"
import { MOCK_NOW } from "@/pi/dev/fixtures/types"
import { hostDiagViewOf } from "@/pi/model/hostDiag"
import { DialogStage } from "./_frame"
const M = 60_000
export const piScreen: PiScreenMeta = {
  id: "dialog-host-diag",
  area: "c",
  title: "主机诊断（B07，开发屏）",
  themes: ["light", "dark"],
  states: ["加载中", "设备离线（不发命令）", "不支持（旧扩展 unknown_command / 回包没有可展示字段）", "读取失败 · 重试", "刷新失败（留着上一次的结果）"],
  notes:
    "P5 第 2 轮新做（审查 P5-R1-1），版式推断（design B07：设置 › 设备 › 某台 › 诊断，PiDialog 560）。口径照旧界面 HostDiagView：版本 / Attach / 最近错误 / 日志尾部，缺的字段写「未提供」。get_host_diag 的内容是 mock（同 #/live/settings 的回包）。不进 80 张对图。",
}
/** 同 fixtures/live/settings.ts 的回包形状（到期 = MacBook Pro 的窗口 5h 12m 后；时间按本地时区显示） */
const DIAG = {
  piVersion: "1.3.0",
  nodeVersion: "v22.18.0",
  platform: "darwin",
  arch: "arm64",
  extensionVersion: "4.0.0",
  attach: { active: true, expiresAt: MOCK_NOW + 312 * M, deviceId: "d-mbp" },
  tap: { state: "ok", captures: 12, missed: 0, open: 0 },
  recentErrors: [{ at: MOCK_NOW - 40 * M, code: "timeout", message: "get_git_branch 没有在 5 秒内返回" }],
  logTail: ["[attach] 连接窗口打开，到期 5h 12m 后", "[relay] 已连接 wss://relay.local", "[relay] token=fixture-local-token 已校验", "[pi] 会话 r-s1 已载入"].join("\n"),
}
export default function Screen({ viewport, theme }: PiScreenProps) {
  return (
    <DialogStage viewport={viewport} theme={theme}>
      <PiHostDiagDialog static viewport={viewport} subtitle="MacBook Pro" view={hostDiagViewOf({ unavailable: null, phase: "ready", data: DIAG })} />
    </DialogStage>
  )
}
