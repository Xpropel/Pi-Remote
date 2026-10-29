/**
 * c 区部件的数据形状（P3.3 从 c/mock.ts 拆出：部件的 props 用这些类型，数据由画廊 fixture / P5 容器给）。
 */
import type { PiModelMeta, PiRowMarkerKind } from "@/components/pi/shared/types"
import type { PiUiVariant } from "@/pi/variants/types"

/** 待发图片（SendImage 在产品里是 { data, mimeType }；设计稿只需要类型与大小） */
export interface CImage {
  mimeType: string
  bytes: number
  /** P5：真实缩略图（data: URL）；不给 = 中性占位（画廊屏） */
  src?: string
}

export interface SlashRow {
  key: string
  name: string
  desc: string
}

export interface SlashGroup {
  title: string
  rows: SlashRow[]
}

export interface CModel extends PiModelMeta {
  key: string
  /** 规格：上下文窗口 · 能否发图 */
  spec: string
  current?: boolean
  /** provider 未认证：灰字"未配置"，不可选 */
  unconfigured?: boolean
  /** 手机行内的费用说明（全产品唯一的橙色，只出在这里与说明卡） */
  costNote?: string
}

/** queue_update 的元素是 AgentMessage（通常是 user 消息，data-interface §5.0 / §6.1：content 是字符串或 Text/Image 块数组） */
export interface CHostMessage {
  role: "user"
  content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
  timestamp: number
}

export interface PaletteCommand {
  key: string
  label: string
  /** 键帽（ch1/KeycapGroup），浏览器里真能触发的才写 */
  keys?: string[]
  icon: "new" | "sidebar" | "pane" | "compact" | "regenerate" | "tree" | "usage" | "inspect" | "settings"
}

export interface PaletteSession {
  id: string
  title: string
  marker: PiRowMarkerKind
  group: string
}

/** 设置页与显示选项读的偏好（形状照 c 区 mock 的 C_PREFS；产品里来自 pi/model/prefs.ts） */
export interface CPrefs {
  /** 界面变体（PI-UI-REFS 架构线）：设置页「外观」里的三张界面卡片，选中即时切换 */
  ui: PiUiVariant
  theme: "system" | "light" | "dark"
  fontSize: "small" | "standard" | "large"
  density: "compact" | "balanced" | "detailed"
  /** 忙时发送的默认投递（待用户确认 10） */
  busyDelivery: "steer" | "follow_up"
  /** 排队消息"立即发送"时 */
  sendNow: "interrupt" | "after_tool"
  /** 网页回答电脑上的确认框 */
  dialogRemote: boolean
  /** G1：允许智能体用 ask_user 工具提问（默认关） */
  askUser: boolean
  /** G2：工具执行审批门（默认关） */
  approvalGate: boolean
  /** G2 审批档位（默认只问高危） */
  approvalGateTier: "high-risk" | "all-non-readonly" | "list"
  /** 完成提示音（默认关） */
  sound: boolean
  /** 列表：设备筛选与分组 */
  deviceFilter: string
  grouping: "device" | "flat"
}
