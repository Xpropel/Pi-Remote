/**
 * mock model 场景（P4.2）：聊天/任务流程的确定性剧本（thinking / 流式文本 / 工具 / 审批 / 错误 / artifact / plan）。
 *
 * 用途：画廊的 `#/p4/...` 场景驱动、e2e 全流程（E2E-15）与截图；**不进生产**。
 * 约束：纯数据，无随机、无 wall clock；时间基准 `PI_UI_DEMO_NOW`（见 runner.ts 的时间表）。
 * 每个场景对应 plan §5.1 的一个流程；步骤只描述语义，UI 由变体自写渲染。
 */
import type { PiUiPlanStep } from "../../types.ts"

export type PiUiDemoModelStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; output?: string; state?: "ok" | "error" }
  | { kind: "approval"; title: string; message: string; options: readonly string[]; answer: "allow-once" | "allow-session" | "deny" }
  | { kind: "artifact"; artifactId: string }
  | { kind: "plan"; steps: readonly Pick<PiUiPlanStep, "id" | "title" | "status">[] }
  | { kind: "error"; message: string }
  | { kind: "done" }

export interface PiUiDemoModelScenario {
  id: string
  title: string
  description: string
  /** 主要覆盖的能力（e2e / 矩阵说明用） */
  capabilities: readonly string[]
  steps: readonly PiUiDemoModelStep[]
}

/** 5 个内置场景（plan §5.1）：默认全流程 / Cowork 计划 / Review 评论 / Automation 后台 / 错误恢复 */
export const PI_UI_DEMO_MODEL_SCENARIOS: readonly PiUiDemoModelScenario[] = [
  {
    id: "tool-approval-stream",
    title: "工具 + 审批 + 流式（默认全流程）",
    description: "thinking → bash 工具 → 等你批准 → 输出 → 流式正文 → 收尾；E2E-15 主流程。",
    capabilities: ["mcp-tools", "background-tasks"],
    steps: [
      { kind: "thinking", text: "先确认工作区状态，再跑测试。" },
      { kind: "tool", name: "bash", input: { command: "git status --short" }, output: " M ui/src/pi/extensions/mock/store.ts", state: "ok" },
      { kind: "approval", title: "允许运行这条命令吗？", message: "npm test -- pi-ui-mock", options: ["允许一次", "这个会话都允许", "拒绝"], answer: "allow-once" },
      { kind: "tool", name: "bash", input: { command: "npm test -- pi-ui-mock" }, output: "ℹ tests 42\nℹ pass 42\nℹ fail 0", state: "ok" },
      { kind: "text", text: "测试通过。这一轮演示覆盖了工具调用、审批卡与流式输出；点「允许一次」后工具继续，最后进入 done。" },
      { kind: "done" },
    ],
  },
  {
    id: "cowork-plan",
    title: "Cowork：澄清 → 计划 → 产出",
    description: "选择题澄清卡 → Progress 步骤卡（可增删）→ Artifact 产出；覆盖 plan-pane + artifacts。",
    capabilities: ["plan-pane", "artifacts", "suggestions"],
    steps: [
      { kind: "thinking", text: "任务需要先澄清范围，再给可谈判的计划。" },
      { kind: "tool", name: "ask", input: { question: "你希望产出偏向哪一种？", options: ["Quick summary", "Detailed notes", "Just the action items"] }, output: "选择：Detailed notes", state: "ok" },
      {
        kind: "plan",
        steps: [
          { id: "step-demo-1", title: "梳理需求与验收口径", status: "completed" },
          { id: "step-demo-2", title: "生成 mock 数据与 provider", status: "completed" },
          { id: "step-demo-3", title: "两线接入 + 双态截图", status: "in_progress" },
          { id: "step-demo-4", title: "验收矩阵 + 终审", status: "pending" },
        ],
      },
      { kind: "artifact", artifactId: "art-demo-deck" },
      { kind: "text", text: "计划已更新，产出已进 Artifacts（演示 deck）。中途插话可以随时增删步骤。" },
      { kind: "done" },
    ],
  },
  {
    id: "review-flow",
    title: "Review：diff → 行内评论 → 攒批提交",
    description: "生成 diff → 行内评论草稿 → Cmd+Enter 攒批 → 新 diff；覆盖 code-review-comments + pr-review。",
    capabilities: ["code-review-comments", "pr-review", "git-stage"],
    steps: [
      { kind: "thinking", text: "先取本回合 diff，再在 store.ts 的改动行上落评论。" },
      { kind: "tool", name: "bash", input: { command: "git diff --stat" }, output: " ui/src/pi/extensions/mock/store.ts | 42 +++++---\n 1 file changed, 30 insertions(+), 12 deletions(-)", state: "ok" },
      { kind: "text", text: "在 store.ts:42 起了一个评论线程（演示）：`getData 需要兜底`，接着攒第二条多行评论。" },
      { kind: "tool", name: "review", input: { action: "batch-submit", comments: 2 }, output: "已提交 2 条评论，生成新 diff（演示）", state: "ok" },
      { kind: "done" },
    ],
  },
  {
    id: "automation-run",
    title: "Automation：后台任务 → review queue",
    description: "后台任务 running → done → 结果进 review queue；覆盖 automations + background-tasks + session-rail。",
    capabilities: ["automations", "background-tasks", "session-rail-extra"],
    steps: [
      { kind: "thinking", text: "触发「PR 打开时审查」automation，后台跑。" },
      { kind: "tool", name: "automation", input: { automationId: "auto-demo-pr" }, output: "queued → running", state: "ok" },
      { kind: "tool", name: "automation", input: { automationId: "auto-demo-pr" }, output: "completed：2 条结果进 review queue", state: "ok" },
      { kind: "text", text: "Automation 结果已进 review queue（演示）：可 accept 或 dismiss。" },
      { kind: "done" },
    ],
  },
  {
    id: "error-recovery",
    title: "错误 → 重试 → 成功",
    description: "工具失败 → 错误条 → 用户重发 → 成功；覆盖错误/重试状态与 transcript 错误 part。",
    capabilities: ["background-tasks"],
    steps: [
      { kind: "tool", name: "bash", input: { command: "npm test" }, output: "Error: connect ECONNREFUSED 127.0.0.1:5432", state: "error" },
      { kind: "error", message: "工具执行失败：连接被拒绝（演示错误态，可重试）。" },
      { kind: "tool", name: "bash", input: { command: "npm test -- --retry" }, output: "ℹ tests 42\nℹ pass 42", state: "ok" },
      { kind: "text", text: "重试成功。错误态与恢复流程都可截。" },
      { kind: "done" },
    ],
  },
]

const SCENARIO_BY_ID = new Map(PI_UI_DEMO_MODEL_SCENARIOS.map((scenario) => [scenario.id, scenario]))

/** 取场景；未知 id 回退第一个（默认全流程），不抛错（画廊参数容错） */
export function piUiDemoModelScenarioOf(id: string | null | undefined): PiUiDemoModelScenario {
  return SCENARIO_BY_ID.get(id ?? "") ?? PI_UI_DEMO_MODEL_SCENARIOS[0]
}

/** 场景 id 列表（测试 / 文档） */
export function piUiDemoModelScenarioIds(): string[] {
  return PI_UI_DEMO_MODEL_SCENARIOS.map((scenario) => scenario.id)
}
