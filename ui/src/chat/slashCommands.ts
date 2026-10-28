/**
 * 19 条内置斜杠命令（P7 B2e：从 chat/slash.tsx 原样挪出，名字、说明、顺序都不变；plan §4.4 保留表的新增文件）。
 * 纯数据，node --test 直接加载。新界面的 slash 菜单（pi/model/slashBuiltins.ts）读它；旧界面的 chat/slash.tsx 已在 P7 B3c 删除。
 * dialog 是旧界面 chat/ui.tsx 的 DialogId 的子集（旧界面按它开对话框），新界面不读这一列。
 */
export type SlashCommandDialog =
  | "model"
  | "thinking"
  | "name"
  | "compact"
  | "regenerate"
  | "session"
  | "settings"
  | "system"
  | "resume"
  | "fork"
  | "clone"
  | "tree"
  | "stats"
  | "usage"
  | "tools"
  | "commands"
export type SlashCommandRow = {
  key: string
  name: string
  desc: string
  kind: "command"
  command?: string
  arg?: boolean
  menu?: "models" | "levels" | "sessions" | "forks" | "tree" | "commands"
  dialog?: SlashCommandDialog
}
export const COMMANDS: readonly SlashCommandRow[] = [
  { key: "model", name: "/model", desc: "切换模型", kind: "command", menu: "models", dialog: "model" },
  { key: "thinking", name: "/thinking", desc: "切换思考级别", kind: "command", menu: "levels", dialog: "thinking" },
  { key: "name", name: "/name", desc: "修改会话名，后面写上新名字", kind: "command", arg: true, command: "set_session_name", dialog: "name" },
  { key: "compact", name: "/compact", desc: "压缩上下文", kind: "command", arg: true, command: "compact", dialog: "compact" },
  { key: "regenerate", name: "/regenerate", desc: "重新回答上一条", kind: "command", command: "regenerate", dialog: "regenerate" },
  { key: "session", name: "/session", desc: "查看当前会话", kind: "command", command: "get_state", dialog: "session" },
  { key: "copy", name: "/copy", desc: "复制上一条回答", kind: "command", command: "get_last_assistant_text" },
  { key: "settings", name: "/settings", desc: "查看设置项名称", kind: "command", command: "get_settings", dialog: "settings" },
  { key: "system", name: "/system", desc: "查看当前系统提示词", kind: "command", command: "get_system_prompt", dialog: "system" },
  { key: "follow", name: "/follow", desc: "等这轮结束后再发后面的文字", kind: "command", arg: true, command: "follow_up" },
  { key: "new", name: "/new", desc: "新建会话", kind: "command", command: "new_session" },
  { key: "resume", name: "/resume", desc: "切换到另一个会话", kind: "command", menu: "sessions", dialog: "resume" },
  { key: "fork", name: "/fork", desc: "从一条用户消息分叉", kind: "command", menu: "forks", dialog: "fork" },
  { key: "clone", name: "/clone", desc: "把当前分支复制成新会话", kind: "command", command: "clone", dialog: "clone" },
  { key: "tree", name: "/tree", desc: "跳到会话树的某个节点", kind: "command", menu: "tree", dialog: "tree" },
  { key: "stats", name: "/stats", desc: "消息数、token 和费用", kind: "command", command: "get_session_stats", dialog: "stats" },
  { key: "usage", name: "/usage", desc: "上下文占用", kind: "command", command: "get_context_usage", dialog: "usage" },
  { key: "tools", name: "/tools", desc: "管理启用的工具", kind: "command", arg: true, command: "get_active_tools", dialog: "tools" },
  { key: "commands", name: "/commands", desc: "打开命令中心", kind: "command", menu: "commands", dialog: "commands" },
]
