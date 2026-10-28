/**
 * 工具活动按动作的重量呈现（design §1.5、§10）。纯函数，node --test 直接加载。
 * 查表口径与 replica 的 b/tools.ts toolWeight 一致；chat/toolConfigs.ts 的 form 字段不变【测试 tool-render-config】。
 */
import type { Block } from "../../relay/transcript.ts"

export type PiToolWeight = "line" | "terminal" | "diff" | "tray" | "subagent"
export type PiDensity = "compact" | "balanced" | "detailed"
export type PiToolBlock = Extract<Block, { kind: "tool" }>

const EXPLORE = new Set(["grep", "find", "ls", "glob"])
const READ = new Set(["read", "read_file"])
const TERMINAL = new Set(["bash", "powershell", "shell"])
const DIFF = new Set(["edit", "write", "multi_edit"])
const TODO = new Set(["todo", "todo_write", "todowrite", "todo_read", "todoread", "tasks"])
const SUBAGENT = new Set(["subagent", "task", "agent"])

/**
 * 工具名 → 呈现方式：read / 探索 / 其他工具是一行灰字（line），bash 类是终端卡，edit / write 是 diff 卡，
 * todo 系列进 tray，subagent 是角色行。密度不改变重量：它只影响探索合并（mergeExploreRuns）和终端卡默认露几行（部件）。
 */
export function toolWeightOf(toolName: string, _density?: PiDensity): PiToolWeight {
  const n = toolName.trim().toLowerCase()
  if (TERMINAL.has(n)) return "terminal"
  if (DIFF.has(n)) return "diff"
  if (TODO.has(n)) return "tray"
  if (SUBAGENT.has(n)) return "subagent"
  return "line"
}

export type PiExploreSummary = { files: number; searches: number; text: string }
export type PiToolRun = { kind: "single"; block: Block } | { kind: "explore"; blocks: PiToolBlock[]; summary: PiExploreSummary }

function explores(block: Block, density: PiDensity): block is PiToolBlock {
  if (block.kind !== "tool") return false
  const n = block.name.trim().toLowerCase()
  return EXPLORE.has(n) || (density === "compact" && READ.has(n))
}

function outputLines(text: string): number {
  return text ? text.replace(/\n$/, "").split("\n").filter(Boolean).length : 0
}

/**
 * 一段探索 → "查看了 3 个文件，搜索 2 次"：grep / glob 记搜索；find / ls 按结果列出的文件计数；read 记 1 个文件。
 * 结果还没到（文件数 0、也没有搜索）时只写"查看了 N 次"。
 */
export function exploreSummaryOf(blocks: readonly PiToolBlock[]): PiExploreSummary {
  let files = 0
  let searches = 0
  for (const b of blocks) {
    const n = b.name.trim().toLowerCase()
    if (n === "grep" || n === "glob") searches++
    else if (READ.has(n)) files++
    else files += outputLines(b.outputText)
  }
  const parts: string[] = []
  if (files > 0) parts.push(`${files} 个文件`)
  if (searches > 0) parts.push(`搜索 ${searches} 次`)
  const text = parts.length ? `查看了 ${parts.join("，")}` : `查看了 ${blocks.length} 次`
  return { files, searches, text }
}

/**
 * 连续 2 个以上的探索调用合并成一行（§1.5）；非工具块、别的工具打断合并。
 * 精简密度下 read 也算探索（"读和探索全部合并成一行"）。单个探索调用保持原样。
 */
export function mergeExploreRuns(blocks: readonly Block[], density: PiDensity = "balanced"): PiToolRun[] {
  const out: PiToolRun[] = []
  let run: PiToolBlock[] = []
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "explore", blocks: run, summary: exploreSummaryOf(run) })
    else for (const block of run) out.push({ kind: "single", block })
    run = []
  }
  for (const block of blocks) {
    if (explores(block, density)) {
      run.push(block)
      continue
    }
    flush()
    out.push({ kind: "single", block })
  }
  flush()
  return out
}
