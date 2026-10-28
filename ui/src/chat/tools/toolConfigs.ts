/**
 * 工具渲染配置表（声明式）：一张表决定每个工具在转录里长什么样，
 * 渲染器（faces.tsx 的 ToolCard）与展示字段生产者（transcript.ts）只查表分发，
 * 不再逐个工具散写判断。新工具接入 = 在表里填一行；没填的走分类兜底，
 * 再不然走 DEFAULT_TOOL_RENDER_CONFIG，永远有呈现、永不白屏。
 *
 * 字段口径：
 *   form          形态：one-line 单行卡（头部即全部，默认折叠）/
 *                 collapsible 标准可折叠卡 / plan 计划块（清单体）/
 *                 panel 行面板（展开才挂载内部内容）。
 *   resultKind    结果面的内容类型，决定卡体怎么渲染结果区。
 *   defaultOpen   "closed" = 默认折叠（失败也折叠，靠状态徽标标错）；
 *                 "auto" = 沿用既有语义（运行/失败展开、成功稍后收起）。
 *   badge         状态徽标来源："state" 只用展示态；"state+exit" 额外把
 *                 非零退出码进徽标/摘要（命令行工具用）。
 *   fields        从 details / structuredContent 里“提升”为一等展示字段的
 *                 结构化字段名；transcript.ts 按此清单提取，其余键走
 *                 genericDetails 的通用键值呈现，不丢。
 *   genericDetails 是否把未被提升的 details 键做通用键值呈现（兜底）。
 *
 * 本表按 pi 工具集与本仓转录结构原创填写；分类兜底复用
 * conversation/toolDisplay.ts 的 toolKind 归类（变体名如 read_file 也能落位）。
 */
import { toolKind, type ToolKind } from "../../conversation/toolDisplay.ts"

export type ToolForm = "one-line" | "collapsible" | "plan" | "panel"

export type ToolResultKind =
  | "diff"
  | "text"
  | "stderr-mix"
  | "todo-list"
  | "file-list"
  | "question-answer"
  | "success-message"
  | "subagent"
  | "key-value"

/** 可从 details 提升的结构化字段。新增字段先在这里登记，再在 transcript.ts 的生产者里实现提取。 */
export type ToolFieldSpec = "exitCode" | "stderr" | "tasks" | "patch"

export type ToolRenderConfig = {
  form: ToolForm
  resultKind: ToolResultKind
  defaultOpen: "auto" | "closed"
  badge: "state" | "state+exit"
  fields: readonly ToolFieldSpec[]
  genericDetails: boolean
}

const COMMON_FIELDS: readonly ToolFieldSpec[] = ["exitCode", "stderr"]

/** 未知工具的兜底：标准折叠卡 + 通用键值，details 一个键都不丢。 */
export const DEFAULT_TOOL_RENDER_CONFIG: ToolRenderConfig = {
  form: "collapsible",
  resultKind: "key-value",
  defaultOpen: "auto",
  badge: "state",
  fields: COMMON_FIELDS,
  genericDetails: true,
}

/** 精确名表：键是 pi 工具的真实注册名（小写）。 */
const TOOL_RENDER_CONFIGS: Record<string, ToolRenderConfig> = {
  bash: {
    form: "one-line",
    resultKind: "stderr-mix",
    defaultOpen: "closed",
    badge: "state+exit",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  read: {
    form: "collapsible",
    resultKind: "text",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  // edit：pi 的 details.patch（unified diff）+ firstChangedLine 提升为一等字段（G5），不再进通用区
  edit: {
    form: "collapsible",
    resultKind: "diff",
    defaultOpen: "auto",
    badge: "state",
    fields: [...COMMON_FIELDS, "patch"],
    genericDetails: true,
  },
  write: {
    form: "collapsible",
    resultKind: "diff",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  grep: {
    form: "collapsible",
    resultKind: "text",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  find: {
    form: "collapsible",
    resultKind: "file-list",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  ls: {
    form: "collapsible",
    resultKind: "file-list",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  // todo 工具集（扩展 TODO_TOOL_NAMES 同名集合）：结果体是任务清单，
  // 提升 tasks 为一等字段，卡体渲染清单 + 顶部进度条。
  todo: {
    form: "plan",
    resultKind: "todo-list",
    defaultOpen: "auto",
    badge: "state",
    fields: ["tasks"],
    genericDetails: true,
  },
  todos: {
    form: "plan",
    resultKind: "todo-list",
    defaultOpen: "auto",
    badge: "state",
    fields: ["tasks"],
    genericDetails: true,
  },
  todowrite: {
    form: "plan",
    resultKind: "todo-list",
    defaultOpen: "auto",
    badge: "state",
    fields: ["tasks"],
    genericDetails: true,
  },
  todo_write: {
    form: "plan",
    resultKind: "todo-list",
    defaultOpen: "auto",
    badge: "state",
    fields: ["tasks"],
    genericDetails: true,
  },
  // 子智能体本体（#68）未落地：先入表占位。生产者接通前结果区只有
  // 空态占位（“暂无子任务结果”），不造假数据；接通后按 subagent 体渲染。
  subagent: {
    form: "panel",
    resultKind: "subagent",
    defaultOpen: "closed",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
}

/** 分类兜底：变体名（read_file / apply_patch / ripgrep …）按类别落到同类行。 */
const KIND_FALLBACK: Record<ToolKind, ToolRenderConfig> = {
  bash: TOOL_RENDER_CONFIGS.bash,
  read: TOOL_RENDER_CONFIGS.read,
  write: TOOL_RENDER_CONFIGS.write,
  edit: TOOL_RENDER_CONFIGS.edit,
  search: TOOL_RENDER_CONFIGS.grep,
  list: TOOL_RENDER_CONFIGS.ls,
  fetch: {
    form: "collapsible",
    resultKind: "text",
    defaultOpen: "auto",
    badge: "state",
    fields: COMMON_FIELDS,
    genericDetails: true,
  },
  other: DEFAULT_TOOL_RENDER_CONFIG,
}

/** 查表：精确名 → 类别兜底 → 默认兜底。返回的对象是表内常量，调用方只读。 */
export function toolRenderConfigFor(name: string): ToolRenderConfig {
  const key = (name || "").trim().toLowerCase()
  const exact = TOOL_RENDER_CONFIGS[key]
  if (exact) return exact
  return KIND_FALLBACK[toolKind(key)] ?? DEFAULT_TOOL_RENDER_CONFIG
}
