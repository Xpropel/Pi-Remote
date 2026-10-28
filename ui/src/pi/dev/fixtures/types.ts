/**
 * live fixture 的类型（plan P5.2）：每屏一份"原始状态"，只给 relay 的原始字段，界面由真实函数算出来。
 * test/*.test.mjs 用 node 直接加载 .ts 源文件，相对导入必须带扩展名；这里只有类型导入（运行时擦除）。
 */
import type { useRelay } from "../../../relay/useRelay.ts"
import type { PiOutboxItemView } from "../../model/tray.ts"

export type Relay = ReturnType<typeof useRelay>

/**
 * 所有 fixture 的 now：2026-10-24 10:42（+08:00）。
 * 来源：R/replica/src/components/pi/shared/mock.ts 的 MOCK_NOW（值照抄）。P3.3 起画廊 mock（gallery/shared.ts）也从这里引，全仓只有这一个定义。
 */
export const MOCK_NOW = 1792809720000

export type PiLiveFixture = {
  /** 屏 id（= R/replica/src/screens/pi/{a,b,c}/<id>.tsx 的 piScreen.id） */
  id: string
  /**
   * relay 的原始字段。useRelay 内部派生的字段（selectedDevice、listedSessions、pendingStart、composer、retryReady）不写，
   * 由 derive.ts 的 liveRelayOf 用真实函数补齐。
   */
  relay: Partial<Relay>
  /** 本页 outbox（P5.6）：liveRelayOf 把它补成 relay.outbox（OutboxEntry，容器读这个）；测试里直接交给 trayItemsOf / queueSectionsOf */
  outbox?: PiOutboxItemView[]
  now: number
  note?: string
}
