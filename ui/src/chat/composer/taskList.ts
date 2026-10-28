/**
 * 任务清单（task_list_state 事件）的纯解析与进度归纳。
 * P7 B2g：从 chat/composer/TaskListCard.tsx 原样挪出（函数体、类型一字不改），relay/useRelay.ts 改从这里 import；
 * TaskListCard.tsx 只 import 后转出，B3c 删它时不影响 useRelay 和测试。纯函数，node --test 直接加载。
 */
export type TaskStatus = "pending" | "in_progress" | "completed"

export type TaskListItem = {
  id: string
  content: string
  status: TaskStatus
  activeForm?: string
}

/** 全部完成后临时展开的时长：够看清收尾，又不长期占输入区高度。 */
export const TASK_LIST_AUTO_COLLAPSE_MS = 1500

const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"]

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

/**
 * 解析 task_list_state 事件载荷。
 *  - `tasks` 不是数组：返回 null（忽略这一帧，保留当前状态）；
 *  - `tasks: []`：返回空数组（契约里的“清空”语义）；
 *  - 单条缺 id/content/status 或状态非法：跳过该条，不补默认值；
 *  - 非空数组一条都认不出：返回 null（坏帧），不清空当前清单。
 */
export function parseTaskListEvent(event: unknown): TaskListItem[] | null {
  if (!event || typeof event !== "object") return null
  const raw = (event as { tasks?: unknown }).tasks
  if (!Array.isArray(raw)) return null
  const tasks: TaskListItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === "string" ? row.id.trim() : ""
    const content = typeof row.content === "string" ? row.content.trim() : ""
    const status = row.status
    if (!id || !content || !isTaskStatus(status) || seen.has(id)) continue
    seen.add(id)
    const activeForm = typeof row.activeForm === "string" ? row.activeForm.trim() : ""
    tasks.push(activeForm ? { id, content, status, activeForm } : { id, content, status })
  }
  // 非空数组却一条都认不出：当坏帧忽略，不能用一次解析失败把现有清单清空。
  return raw.length && !tasks.length ? null : tasks
}

/** 事件归约：合法帧替换，非法帧原样保留，空数组清空。 */
export function taskListAfterEvent(current: TaskListItem[], event: unknown): TaskListItem[] {
  return parseTaskListEvent(event) ?? current
}

export type TaskSummary = {
  total: number
  completed: number
  allComplete: boolean
  current: TaskListItem | null
  currentLabel: string
}

/**
 * 当前项：优先 in_progress（有 activeForm 用 activeForm），没有进行项就指向第一条待办；
 * 全部完成时显示“全部完成”。计数只数 true 的 completed，不把进行项算作完成。
 */
export function summarizeTasks(tasks: readonly TaskListItem[]): TaskSummary {
  let completed = 0
  let active: TaskListItem | null = null
  let firstPending: TaskListItem | null = null
  for (const task of tasks) {
    if (task.status === "completed") completed += 1
    else if (task.status === "in_progress" && !active) active = task
    else if (task.status === "pending" && !firstPending) firstPending = task
  }
  const total = tasks.length
  const allComplete = total > 0 && completed === total
  const current = active ?? firstPending
  const currentLabel = allComplete
    ? "全部完成"
    : current
      ? current.status === "in_progress"
        ? current.activeForm || current.content
        : current.content
      : ""
  return { total, completed, allComplete, current, currentLabel }
}
