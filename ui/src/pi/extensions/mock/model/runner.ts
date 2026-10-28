/**
 * mock model 推进器（P4.2）：把 `./scenarios.ts` 的步骤表变成**确定性时间线**（确定时长、确定事件序号）。
 *
 * 两个消费端：
 * - 单测 / e2e：`new PiUiDemoTurnRunner("tool-approval-stream"); runner.runToEnd()` 直接拿全部事件（无时钟依赖）。
 * - 画廊（后续 P4Route）：用 `advanceTo(elapsedMs)` 配合 setInterval 逐段渲染流式/工具/审批；时间从 0 起算。
 *
 * 时间基准：`at = PI_UI_DEMO_NOW + 相对毫秒`；禁止 wall clock。
 */
import { PI_UI_DEMO_NOW } from "../fixtures.ts"
import { piUiDemoModelScenarioOf, type PiUiDemoModelScenario, type PiUiDemoModelStep } from "./scenarios.ts"

/** 一步的确定时长（ms）：只由步骤内容决定，不读时钟 */
export function piUiDemoStepDurationMs(step: PiUiDemoModelStep): number {
  switch (step.kind) {
    case "thinking":
      return 900
    case "text":
      return Math.max(400, Math.min(2400, step.text.length * 18))
    case "tool":
      return step.state === "error" ? 700 : 800
    case "approval":
      return 1_500
    case "artifact":
      return 500
    case "plan":
      return 700
    case "error":
      return 400
    case "done":
      return 300
    default:
      return 500
  }
}

export interface PiUiDemoTurnEvent {
  /** 事件序号（从 0 递增） */
  seq: number
  /** 时间戳 = PI_UI_DEMO_NOW + 本步开始时的相对毫秒 */
  at: number
  /** 步骤下标 */
  stepIndex: number
  kind: PiUiDemoModelStep["kind"]
  step: PiUiDemoModelStep
}

/** 一步在时间线上的位置 */
export interface PiUiDemoTimelineEntry {
  stepIndex: number
  startMs: number
  endMs: number
  step: PiUiDemoModelStep
}

/** 场景时间线（纯函数；测试与画廊共用） */
export function piUiDemoScenarioTimeline(scenario: PiUiDemoModelScenario): PiUiDemoTimelineEntry[] {
  let cursor = 0
  return scenario.steps.map((step, stepIndex) => {
    const startMs = cursor
    const duration = piUiDemoStepDurationMs(step)
    cursor += duration
    return { stepIndex, startMs, endMs: cursor, step }
  })
}

/** 场景总时长（ms） */
export function piUiDemoScenarioDurationMs(scenario: PiUiDemoModelScenario): number {
  const timeline = piUiDemoScenarioTimeline(scenario)
  return timeline.length ? timeline[timeline.length - 1].endMs : 0
}

/** 确定性推进器：reset 后可重复跑出同一串事件（测试与 e2e 断言序列） */
export class PiUiDemoTurnRunner {
  readonly scenario: PiUiDemoModelScenario
  readonly timeline: PiUiDemoTimelineEntry[]
  private events: PiUiDemoTurnEvent[] = []
  private nextStep = 0

  constructor(scenarioId: string) {
    this.scenario = piUiDemoModelScenarioOf(scenarioId)
    this.timeline = piUiDemoScenarioTimeline(this.scenario)
  }

  /** 总时长（ms） */
  get durationMs(): number {
    return piUiDemoScenarioDurationMs(this.scenario)
  }

  /** 全部已产生事件（只读副本） */
  get emitted(): readonly PiUiDemoTurnEvent[] {
    return this.events
  }

  get done(): boolean {
    return this.nextStep >= this.timeline.length
  }

  /**
   * 推进到相对毫秒 elapsedMs；返回**本次新增**的事件（按 stepIndex 升序）。
   * 幂等：同一 elapsedMs 重复调用不再产生事件；elapsedMs 回退到 0 等价 reset。
   */
  advanceTo(elapsedMs: number): PiUiDemoTurnEvent[] {
    const bounded = Math.max(0, elapsedMs)
    const added: PiUiDemoTurnEvent[] = []
    while (this.nextStep < this.timeline.length) {
      const entry = this.timeline[this.nextStep]
      if (entry.startMs > bounded) break
      const event: PiUiDemoTurnEvent = {
        seq: this.events.length,
        at: PI_UI_DEMO_NOW + entry.startMs,
        stepIndex: entry.stepIndex,
        kind: entry.step.kind,
        step: entry.step,
      }
      this.events.push(event)
      added.push(event)
      this.nextStep += 1
    }
    return added
  }

  /** 一次跑完；返回全部事件 */
  runToEnd(): readonly PiUiDemoTurnEvent[] {
    this.advanceTo(this.durationMs)
    return this.events
  }

  /** 当前步骤（elapsedMs 时刻；已结束 = null） */
  stepAt(elapsedMs: number): PiUiDemoModelStep | null {
    for (const entry of this.timeline) {
      if (elapsedMs >= entry.startMs && elapsedMs < entry.endMs) return entry.step
    }
    return null
  }

  reset(): void {
    this.events = []
    this.nextStep = 0
  }
}

/** 便捷：直接拿某场景的全部事件（测试用） */
export function piUiDemoScenarioEvents(scenarioId: string): readonly PiUiDemoTurnEvent[] {
  return new PiUiDemoTurnRunner(scenarioId).runToEnd()
}
