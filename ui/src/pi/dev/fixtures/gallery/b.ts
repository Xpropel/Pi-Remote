/**
 * b 区 mock 的统一出口（design §6.4：a / c 直接 import 这里的 CONVO_*、ARCHIVE）。
 * 数字都从同一份数据算：tray 的"改动 +N −M"= 改动视图合计 = git diff --stat；"终端 1"= 运行中的命令数；"任务 2/4"= 已完成 / 总数。
 */
import { CHANGES_TOTAL } from "@/pi/dev/fixtures/gallery/bChanges"
import { TASKS, TERMINALS } from "@/pi/dev/fixtures/gallery/bConvo"

export * from "./bChanges"
export * from "./bConvo"
export * from "./bFiles"
export * from "./bOther"

/** tray pill 的数据（形状 = c 区 PiComposerDock 的 PiTrayItem） */
export const TRAY_TASKS = {
  kind: "tasks" as const,
  label: `任务 ${TASKS.filter((t) => t.status === "completed").length}/${TASKS.length}`,
}
export const TRAY_TERMINAL = {
  kind: "terminal" as const,
  label: `终端 ${TERMINALS.filter((t) => t.state === "running").length}`,
  running: TERMINALS.some((t) => t.state === "running"),
}
export const TRAY_CHANGES = {
  kind: "changes" as const,
  label: "改动",
  added: CHANGES_TOTAL.added,
  removed: CHANGES_TOTAL.removed,
}
