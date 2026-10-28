/**
 * 斜杠菜单的分组（plan §7.3 slash-menu、P5.5 c 线）。纯函数，node --test 直接加载。
 * 分组规则照 chat/slashParse.ts 的 groupSlashBrowse（常用按本机计数取、内置同名优先、资源命令单独一组），
 * 组名按 design 写「常用 / 内置 / 本机资源」（产品旧界面里内置主组没有组名、资源组叫「资源命令」）。
 * 资源命令行的说明照 chat/slash.tsx 的 resourceRow：[执行 | 不可执行, 来源, 说明].join(" · ")。
 */
import { groupSlashBrowse, resourceSourceLabel, type ResourceCommand } from "../../chat/slashParse.ts"

/** 菜单的一行（同 components/pi/composer 的 SlashRow） */
export type PiSlashRow = { key: string; name: string; desc: string }
export type PiSlashGroup = { title: string; rows: PiSlashRow[] }

/**
 * 新界面里说明要改的内置命令（行为不同）：/commands 在新界面打开命令面板（G01），不是旧界面的命令中心。
 * 其余照 COMMANDS 原文。
 */
export const PI_SLASH_DESC_OVERRIDE: Readonly<Record<string, string>> = { commands: "打开命令面板" }

export const PI_SLASH_GROUP_FREQUENT = "常用"
export const PI_SLASH_GROUP_BUILTIN = "内置"
export const PI_SLASH_GROUP_RESOURCES = "本机资源"

/** 内置命令（chat/slash.tsx 的 COMMANDS）→ 菜单行；只取 key / name / desc */
export function slashBuiltinRows(commands: readonly { key: string; name: string; desc: string }[]): PiSlashRow[] {
  return commands.map((c) => ({ key: c.key, name: c.name, desc: PI_SLASH_DESC_OVERRIDE[c.key] ?? c.desc }))
}

/** get_commands 的一条资源命令 → 菜单行（key 带 resource: 前缀，执行时据此找回命令） */
export function slashResourceRow(command: ResourceCommand): PiSlashRow {
  const action = command.executable ? "执行" : "不可执行"
  const desc = [action, resourceSourceLabel(command.source), command.description].filter(Boolean).join(" · ")
  return { key: `resource:${command.name}`, name: `/${command.name}`, desc }
}

/**
 * 空查询浏览的三组（空组不出）。usageOrder = slashUsage.frequentSlashNames 的结果（按次数 / 最近排好序的命令名），
 * 本机没有计数时没有「常用」组。
 */
export function slashBrowseGroupsOf(
  builtins: readonly PiSlashRow[],
  resources: readonly ResourceCommand[],
  usageOrder: readonly string[],
  frequentLimit = 5,
): PiSlashGroup[] {
  const groups = groupSlashBrowse(builtins, resources.map(slashResourceRow), usageOrder, frequentLimit)
  return groups.map((g) => ({
    title: g.title === null ? PI_SLASH_GROUP_BUILTIN : g.title === "常用" ? PI_SLASH_GROUP_FREQUENT : PI_SLASH_GROUP_RESOURCES,
    rows: g.rows,
  }))
}

/** 命中的资源命令（key = "resource:<name>"）；不是资源行返回 null */
export function slashResourceOf(resources: readonly ResourceCommand[], key: string): ResourceCommand | null {
  if (!key.startsWith("resource:")) return null
  const name = key.slice("resource:".length)
  return resources.find((r) => r.name === name) ?? null
}
