/** 变体自己的界面文案集中处（不 import cursor 的 COPY；事实口径与 relay/devices 的 COPY 一致） */
export const CODEBOOK = {
  sourcesEmpty: "暂无",
  pairHint: "配对码 10 分钟内有效，只能用一次。配对成功后按提示重启 pi。",
  revokeExplain: "撤销后这台设备的令牌立即作废，它的窗口和扩展会断开，要重新配对才能再连。",
  pairDone: "请在那台电脑上重启 pi；再运行 deploy/attach.sh（Windows：deploy\\attach.cmd）打开连接窗口。",
  intro: "设备与配对",
} as const
