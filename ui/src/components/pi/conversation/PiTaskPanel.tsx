import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { CircleCheck } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { T_SECONDARY } from "./styles"
import type { PiTaskListItem, PiTaskStatus } from "@/components/pi/shared/types"

const STATUS_TEXT: Record<PiTaskStatus, string> = { completed: "完成", in_progress: "进行中", pending: "待做" }

function TaskIcon({ status }: { status: PiTaskStatus }) {
  if (status === "completed")
    return <CircleCheck aria-hidden size={15} strokeWidth={1.5} className="shrink-0 text-(--cw-text-3)" />
  if (status === "in_progress")
    return (
      <span className="inline-grid size-[15px] shrink-0 place-items-center">
        <PiSpinner size={13} tone="muted" arc={0.5} label="进行中" />
      </span>
    )
  return (
    <span aria-hidden className="inline-grid size-[15px] shrink-0 place-items-center">
      <span className="size-[12.5px] rounded-full border-[1.5px] border-(--cw-status-idle-ring)" />
    </span>
  )
}

/** 任务完成数 / 总数 */
export function taskProgress(tasks: readonly PiTaskListItem[]) {
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length }
}

export interface PiTaskRowsProps {
  tasks: readonly PiTaskListItem[]
  variant: "desktop" | "phone"
}

/** 任务行：状态圈 + 标题 + 行尾灰字状态；当前项加粗（参照 ch5/TaskRow 的排法，文案是 Pi 的） */
export function PiTaskRows({ tasks, variant }: PiTaskRowsProps) {
  const phone = variant === "phone"
  return (
    <ul data-pi-part="task-rows" className="m-0 list-none p-0">
      {tasks.map((t) => (
        <li
          key={t.id}
          data-status={t.status}
          className={cn(
            "flex items-center gap-2.5 rounded-(--cw-radius-row)",
            phone ? "min-h-12 px-3 text-(length:--cw-text-base)" : "min-h-8 px-2.5 text-(length:--cw-text-md)",
          )}
        >
          <TaskIcon status={t.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              // 已完成仍是要读的字：secondary 灰（§4.6；B5），比待办的 --cw-text-2 浅一档
              t.status === "completed" && T_SECONDARY,
              t.status === "in_progress" && "font-(--cw-weight-semibold) text-(--cw-text)",
              t.status === "pending" && "text-(--cw-text-2)",
            )}
          >
            {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
          </span>
          <span className={cn("shrink-0 text-(length:--cw-text-sm)", T_SECONDARY)}>{STATUS_TEXT[t.status]}</span>
        </li>
      ))}
    </ul>
  )
}

export interface PiTaskPanelProps {
  tasks: readonly PiTaskListItem[]
  className?: string
}

/**
 * 任务面板（PiTaskPanel；compose from kit: Spinner；参照 ch3/TodoProgressCard 的头行、ch5/TaskRow 的行）。
 * 桌面：tray 上方的浮层，宽 360，头行"任务 · 2/4 完成"，行无框、靠缩进分层。面板版式整套推断（run-brief ⑦：tray 面板展开态未核实）。
 * 手机用 PiSheet 包 PiTaskRows（屏幕里组装）。
 */
export function PiTaskPanel({ tasks, className }: PiTaskPanelProps) {
  const { done, total } = taskProgress(tasks)
  return (
    <section
      data-pi-part="task-panel"
      aria-label="任务"
      className={cn(
        "w-[360px] rounded-(--cw-radius-popover) border border-(--cw-border) bg-(--cw-surface) p-1.5 shadow-(--cw-shadow-popover)",
        className,
      )}
    >
      <header className="flex h-8 items-center px-2.5 text-(length:--cw-text-md)">
        <span className="font-(--cw-weight-semibold) text-(--cw-text)">任务</span>
        <span className={cn("ml-1.5", T_SECONDARY)}>
          · {done}/{total} 完成
        </span>
      </header>
      <PiTaskRows tasks={tasks} variant="desktop" />
    </section>
  )
}
