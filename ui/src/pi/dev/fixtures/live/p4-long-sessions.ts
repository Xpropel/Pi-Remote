/** P4 画廊 fixture：长会话列表（60 条，供 Round 4 长列表/滚动/性能类验收；Pi 语义 = 设备 + 目录 + 会话）。 */
import type { SessionEntry } from "../../../../relay/devices.ts"
import { BASE, DEVICES, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const M = 60_000
const TITLES = [
  "修复手机键盘收起时输入框跳动",
  "relay 重启后提示结果未知",
  "给 history-backfill 补测试",
  "整理 README 的配对步骤",
  "旧版视觉修正",
  "会话归档后搜索不到",
  "设备令牌轮换的文案",
  "排队面板的冲突提示",
  "命令面板加会话搜索",
  "终端输出软换行",
  "diff 卡读 details.patch",
  "配对码倒计时",
  "升级 vite 8",
  "上下文圆环的缓存命中率",
  "审批卡倒计时播报",
  "无设备时的空态",
  "长转录滚动位置",
  "多标签会话切换",
  "附件拖拽上传",
  "图片灯箱缩放",
]

/** 60 条确定性会话（id/时间/消息数全固定；updatedAt 从新到旧，10 分钟一条） */
const LONG_SESSIONS: SessionEntry[] = Array.from({ length: 60 }, (_, index) => ({
  id: `long-${String(index + 1).padStart(3, "0")}`,
  name: "",
  firstMessage: `${TITLES[index % TITLES.length]} · ${index + 1}`,
  path: `/Users/dev/.pi/agent/sessions/long-${String(index + 1).padStart(3, "0")}.jsonl`,
  cwd: PI_REMOTE,
  messageCount: 4 + ((index * 7) % 60),
  sizeBytes: 2048 + index * 512,
  updatedAt: MOCK_NOW - 10 * M - index * 10 * M,
  active: index < 3,
  online: index < 3,
  parentSession: null,
}))

const fixture: PiLiveFixture = {
  id: "p4-long-sessions",
  now: MOCK_NOW,
  note: "Round 4 长列表：MacBook Pro 上 60 条会话（3 条在线），其余设备沿用共享 fixture；只演示 Pi 语义数据，不保证切真实 relay。",
  relay: {
    ...BASE,
    devices: DEVICES,
    sessionsByDevice: { ...BASE.sessionsByDevice, "d-mbp": LONG_SESSIONS },
    selectedDeviceId: "d-mbp",
    sessionsLoading: false,
    sessionsTruncated: false,
    roomId: "long-001",
    online: true,
    rooms: BASE.rooms,
  } as PiLiveFixture["relay"],
}

export default fixture
