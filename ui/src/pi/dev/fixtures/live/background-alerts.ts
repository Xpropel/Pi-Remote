/** a/background-alerts：从后台回来，relay 重启过，一条有副作用的命令结果未知（warning 卡），后面还排着 2 条。 */
import { emptyNotices, pushNotice, type NoticeInput } from "../../../../chat/noticeCore.ts"
import { BASE, commandTable, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

/** 通知输入（replica a/mock.ts A_NOTICE + 后面排着的 2 条）；可见卡和队列由真实的 noticeCore 归约出来 */
export const NOTICE_INPUTS: NoticeInput[] = [
  {
    level: "warning",
    title: "刚才的操作结果未知",
    body: "服务器重启过，「压缩上下文」可能没有执行。请先看看会话再操作。",
    actions: [
      { id: "open", label: "查看会话", kind: "primary" },
      { id: "ok", label: "知道了" },
    ],
    dedupeKey: "relay-restart",
  },
  { level: "info", title: "「整理 README 的配对步骤」完成了", actions: [{ id: "view", label: "查看" }], dedupeKey: "turn:r-s4:7" },
  { level: "info", title: "「退款对账脚本报错」出错了", actions: [{ id: "view", label: "查看" }], dedupeKey: "turn:r-s6:12" },
]

const notices = NOTICE_INPUTS.reduce((state, input, k) => pushNotice(state, input, MOCK_NOW - (NOTICE_INPUTS.length - k) * 100), emptyNotices())

const fixture: PiLiveFixture = {
  id: "background-alerts",
  now: MOCK_NOW,
  note: "replica 手机返回键「‹ 4」按 MOCK_ATTENTION 算；relay 的注意力 2 条 + 侧栏补的 ThinkPad 掉线（G2）= 3，少的那条是别房的等你回答（G1）。",
  relay: {
    ...BASE,
    notices: notices.visible,
    noticeQueue: notices.queue.length,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
