/** P4 mock 画廊 fixture：运行中的工作台会话（有 live 回合/工具/终端/任务），供窗格工作台/rail 类场景驱动。 */
import { STREAMING } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "p4-workbench",
  now: MOCK_NOW,
  note: "P4 W3 窗格/专属面板场景基座：运行中会话（live 回合 + terminal + taskList + agentState），caps=all 时 Artifacts/Browser/Plan/SideChat/Subagent 等 provider 有数据。",
  relay: { ...STREAMING },
}

export default fixture
