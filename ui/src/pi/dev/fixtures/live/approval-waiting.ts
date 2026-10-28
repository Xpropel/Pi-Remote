/** b/approval-waiting：r-s3 回合在跑，扩展的 select 确认框挡在 bash 前（timeout 120s，38 秒前打开，剩 1:22），网页可答。 */
import { APPROVAL_DIALOG, BASE, CONVO_APPROVAL, roomsWith, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "approval-waiting",
  now: MOCK_NOW,
  note: "被挡住的 bash 在现在的协议里停在 input-available（显示成运行中）；replica 的 waiting_approval「等你确认」没有数据源（缺口 G6）。",
  relay: {
    ...BASE,
    roomId: "r-s3",
    busy: true,
    rooms: roomsWith({ "r-s3": { busy: true, lastActivity: MOCK_NOW - 38_000 } }),
    dialogs: [APPROVAL_DIALOG],
    transcript: transcriptOf(CONVO_APPROVAL, "a-r3-9"),
    usage: null,
  },
}
export default fixture
