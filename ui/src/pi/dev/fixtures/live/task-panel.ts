/** b/task-panel：r-s1 运行中，task_list_state 4 项（2 完成 / 1 进行中 / 1 待做）→ tray「任务 2/4」选中、面板打开。 */
import { STREAMING } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "task-panel",
  now: MOCK_NOW,
  note: "面板开着、pill 选中是界面状态（usePiUiState），不在 relay 里。",
  relay: { ...STREAMING },
}
export default fixture
