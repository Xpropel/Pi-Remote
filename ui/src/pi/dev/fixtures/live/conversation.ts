/** b/conversation：r-s1 最后一个回合已完成（S0），tray 只有改动 pill。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

/**
 * get_image 的回包（扩展 cmdGetImage 的形状：{ entryId, blockIndex, mimeType, bytes, data, compressed }）。
 * 像素是一张 78×168 的中性手机截图占位（279 字节的 PNG，不是真截图）：#live 的可交互模式里点"加载原图"→ 缩略图 → 灯箱（P5.4 用例）；
 * 静态截图不点它，用户卡照旧是过大占位块。
 */
const SHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAE4AAACoCAIAAADB1U/VAAAA3klEQVR42u3WMQqAMBBFwdz/dkIEwTbgBZJaWxs7MbI74V1gmp8trR1JKqioqKioqKioqKioYam9jyShoqKioqKioqKiouaj1rr9PFRUVAuMioqKmvFaQkVFNUuoqKiorqU53w8qakyqBUZFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRb11BnqoqKioqKioqO9T3cCoqKion1GXdU8SKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKupjF/LpPC4bdsKrAAAAAElFTkSuQmCC"

const fixture: PiLiveFixture = {
  id: "conversation",
  now: MOCK_NOW,
  note: "replica 的「思考 6 秒」靠界面层实时观测（observedMs），快照里没有，真实函数给「已思考」（缺口 G4）。用户卡的截图是 omitted 图，原图走 get_image（回包像素是占位 PNG）。",
  relay: {
    ...BASE,
    getImage: async (entryId: string, blockIndex: number) => {
      if (entryId !== "u-r1-46" || blockIndex !== 1) throw Object.assign(new Error("内容块不存在"), { code: "not_found" })
      return { entryId, blockIndex, mimeType: "image/png", bytes: Math.floor((SHOT_PNG.length * 3) / 4), data: SHOT_PNG, compressed: false }
    },
  },
}
export default fixture
