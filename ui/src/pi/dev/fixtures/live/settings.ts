/** c/settings：设置页（偏好节），左栏不变；偏好是本机 localStorage，relay 只给设备、能力和诊断。 */
import { BASE, MBP } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"
const M = 60_000
/**
 * get_host_diag 的回包（扩展 cmdGetHostDiag 的形状：piVersion / nodeVersion / platform / arch / extensionVersion / attach / tap / recentErrors / logTail）。
 * 设备行开主机诊断（design B07，P5 第 2 轮）：MacBook Pro 回这一份；Mac Studio 的扩展太旧（unknown_command → "不支持"）；ThinkPad 离线，不发命令。
 * 日志里故意留一个 token=…，弹窗按 redactSecrets 遮掉。这份回包不进 80 张对图（设置页静态截图不开弹窗）。
 */
const HOST_DIAG = {
  piVersion: "1.3.0",
  nodeVersion: "v22.18.0",
  platform: "darwin",
  arch: "arm64",
  extensionVersion: "4.0.0",
  attach: { active: true, expiresAt: MBP.windowExpiresAt, deviceId: MBP.id },
  tap: { state: "ok", captures: 12, missed: 0, open: 0 },
  recentErrors: [{ at: MOCK_NOW - 40 * M, code: "timeout", message: "get_git_branch 没有在 5 秒内返回" }],
  logTail: ["[attach] 连接窗口打开，到期 5h 12m 后", "[relay] 已连接 wss://relay.local", "[relay] token=fixture-local-token 已校验", "[pi] 会话 r-s1 已载入"].join("\n"),
}
const coded = (code: string, message: string) => Object.assign(new Error(message), { code })
const fixture: PiLiveFixture = {
  id: "settings",
  now: MOCK_NOW,
  note: "偏好（主题 / 密度 / 默认投递 / 提示音）来自 pi_remote_pi_prefs，不在 relay；空存储时 migratePiPrefs 给默认值。replica 的字号三档在 model/prefs.ts 里还没有字段（本机偏好，不是 relay 缺口，见报告「留给 P5」）。设备行开主机诊断：get_host_diag 走 runDeviceCommand（设备级只读命令）。",
  relay: {
    ...BASE,
    runDeviceCommand: async (deviceId: string, command: string) => {
      if (command !== "get_host_diag") throw coded("unknown_command", `未知命令 ${command}`)
      if (deviceId === "d-studio") throw coded("unknown_command", "unknown command: get_host_diag")
      if (deviceId !== MBP.id) throw coded("device_offline", "设备未连接")
      return HOST_DIAG
    },
  },
}
export default fixture
