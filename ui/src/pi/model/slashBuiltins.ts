/**
 * 19 条内置斜杠命令的 key / name / desc（新界面的斜杠菜单用）。
 * P5 时 chat/slash.tsx 的 COMMANDS 没有 export，这里先照抄了一份（test/pi-p5-c 逐条对照）；
 * P7 B2e 把 COMMANDS 挪进纯数据文件 chat/slashCommands.ts，这里改成从它取，副本删掉（只剩一份）。名字照旧，调用方不用改。
 */
import { COMMANDS } from "../../chat/slashCommands.ts"
export const SLASH_BUILTINS_COPY: readonly { key: string; name: string; desc: string }[] = COMMANDS.map(({ key, name, desc }) => ({ key, name, desc }))
