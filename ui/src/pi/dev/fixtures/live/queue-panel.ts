/** c/queue-panel：r-s1 运行中，remote_queue_state rev 12（q1 等这轮结束、q2 已插入）+ 本机 queue_update（followUp 1 条，只读）。 */
import { HOST_QUEUE, REMOTE_QUEUE, STREAMING, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "queue-panel",
  now: MOCK_NOW,
  note: "主图没有 outbox（第一段「本页待发」不出）；states 的「离线 outbox」见 test/pi-fixtures.test.mjs 里的变体断言。分支 main 来自 get_git_branch（P5 c 线加）。",
  relay: {
    ...STREAMING,
    remoteQueue: REMOTE_QUEUE,
    queue: HOST_QUEUE,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }),
  },
}
export default fixture
