/** 发送动作的纯规划：把「现在忙不忙」折成唯一的投递命令。
 *
 *  规范 5.2：S4（生成中仍有草稿）必须使用 pi 原生的 `follow_up`，绝不能退回
 *  `deliveryPlan("auto", true)` —— 那个组合是 steer，会把消息插进当前回合。
 *  空闲时一律 prompt（deliveryPlan 自己保证）。
 *
 *  本文件不依赖 React，Node 测试可直接 import。
 */

import { S4_SEND_MODE } from "../composerMachine.ts"
import { deliveryPlan, type DeliveryPlan } from "../composerTools.ts"

/** 离线/断线时点发送的明确提示：不假装已发送，也不清空输入。 */
export const OFFLINE_SEND_COPY = "当前离线，消息保留在输入框，连上后再发送。"

/** 发送按钮被按下时该走哪条命令。Busy 只影响 S4；S1 永远 prompt。 */
export function planForSend(busy: boolean): DeliveryPlan {
  if (busy) return deliveryPlan(S4_SEND_MODE, true)
  return deliveryPlan("auto", false)
}
