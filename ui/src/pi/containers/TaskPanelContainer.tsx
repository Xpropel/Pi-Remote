import { PiTaskPanel, PiTaskRows, taskProgress } from "@/components/pi/conversation/PiTaskPanel"
import { PiSheet } from "@/components/pi/shared"
import { PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 任务面板（plan §7.2 task-panel、P5.4，b 线）：relay.taskList（task_list_state 整帧，不经前端加工），
 * 行的口径照 chat/composer/TaskListCard.tsx（进行中的那项写 activeForm）；去掉了蓝色进度条。
 * 打开状态（跨线契约，R2/p5-lanes.md §2）：c 的 tray "任务 n/m" pill 开它 —
 * - 桌面：ui.menu?.id === PI_UI_IDS.tasks；c 的 ComposerContainer 把它放进 PiComposerDock 的 panel 槽（tray 上方浮层，宽 360）。
 * - 手机：ui.sheet?.id === PI_UI_IDS.tasks；PhoneApp 把它放在 sheet 槽（半高 PiSheet "任务 · 2/4 完成"，行高 48，M-03）。
 * 没开时什么都不画；桌面清单空了也不画（tray 里也就没有这颗 pill）。
 */
export function TaskPanelContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const tasks = relay.taskList
  if (variant === "desktop") {
    if (ui.menu?.id !== PI_UI_IDS.tasks || tasks.length === 0) return null
    return <PiTaskPanel tasks={tasks} />
  }
  if (ui.sheet?.id !== PI_UI_IDS.tasks) return null
  const { done, total } = taskProgress(tasks)
  return (
    <PiSheet
      title="任务"
      subtitle={`${done}/${total} 完成`}
      size="half"
      onOpenChange={(open) => {
        if (!open) act.closeSheet()
      }}
    >
      <PiTaskRows tasks={tasks} variant="phone" />
    </PiSheet>
  )
}
