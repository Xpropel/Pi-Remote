/** 斜杠命令草稿解析（纯函数，不依赖 React，便于单测）。 */

export function withoutSlash(draft: string) {
  return draft.replace(/^\/[^\s]*(?:\s[\s\S]*)?$/, "").trimEnd()
}

/**
 * 保留原始大小写的解析结果。命令名除了字母/连字符，还要认 `skill:name`（冒号）、
 * 模板名里的数字/下划线/点：pi 的命令名就是按空格切开的整段，不能只认 `[a-zA-Z-]`。
 */
export function parseSlashDetailed(draft: string) {
  const match = /^\/([^\s]*)(?:\s([\s\S]*))?$/.exec(draft)
  if (!match) return null
  return { name: match[1].toLowerCase(), raw: match[1], arg: match[2] !== undefined ? match[2] : null }
}

/**
 * 只认**整段输入开头**的 /：正文中间出现的 "/tools 命令的作用" 是普通文本；
 * 多行消息的最后一行以 / 开头（比如引用一段命令说明）也不能被当成命令执行、把前面的正文吞掉。
 */
export function parseSlash(draft: string) {
  const parsed = parseSlashDetailed(draft)
  return parsed ? { name: parsed.name, arg: parsed.arg } : null
}

/** Fork 成功后输入框里的提示：新分支保留被分叉的这条消息，改完再发就是接在它后面。 */
export const FORK_BACKFILL_COPY = "这条消息已回到输入框，修改后发送即从新分支继续"
export const FORK_APPEND_HINT = "已有草稿，已换行追加到末尾"

/**
 * Fork 回填：空草稿直接放原文；已有草稿不覆盖，换行追加。
 * 返回值里的 appended 用来决定是否提示“已追加”。
 */
export function mergeForkDraft(current: string, incoming: string): { text: string; appended: boolean } {
  const draft = typeof current === "string" ? current : ""
  const text = typeof incoming === "string" ? incoming.trim() : ""
  if (!text) return { text: draft, appended: false }
  if (!draft.trim()) return { text, appended: false }
  return { text: draft + (draft.endsWith("\n") ? "" : "\n") + text, appended: true }
}

/** get_commands 清单里可执行的资源命令（扩展命令 / 提示词模板 / 技能）。 */
export type ResourceCommand = {
  name: string
  description: string
  source: string
  executable: boolean
}

const RESOURCE_SOURCES = new Set(["extension", "prompt", "skill"])

export function resourceSourceLabel(source: string): string {
  if (source === "extension") return "扩展命令"
  if (source === "prompt") return "模板"
  if (source === "skill") return "技能"
  return source || "资源"
}

/** 内置命令不在 get_commands 里；source=builtin（或 kind=builtin）即使出现也只当说明，不执行。 */
export function isExecutableResource(source: unknown, kind?: unknown): boolean {
  if (typeof kind === "string" && kind.trim().toLowerCase() === "builtin") return false
  return typeof source === "string" && RESOURCE_SOURCES.has(source.trim().toLowerCase())
}

/** 把 get_commands 回包整理成菜单可用的清单：去重、去掉脏条目，保留原始大小写。 */
export function parseResourceCommands(data: unknown): ResourceCommand[] {
  const raw =
    data && typeof data === "object" && Array.isArray((data as { commands?: unknown }).commands)
      ? ((data as { commands: unknown[] }).commands)
      : []
  const seen = new Set<string>()
  const out: ResourceCommand[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === "string" ? rec.name.trim().replace(/^\/+/, "") : ""
    if (!name || /\s/.test(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const source = typeof rec.source === "string" ? rec.source.trim().toLowerCase() : ""
    const kind = typeof rec.kind === "string" ? rec.kind.trim().toLowerCase() : ""
    // 内置命令不在 get_commands 的清单语义里；即使旧/新本机混进来，也不建执行行。
    if (source === "builtin" || kind === "builtin") continue
    out.push({
      name,
      description: typeof rec.description === "string" ? rec.description.trim() : "",
      source,
      executable: isExecutableResource(source, kind),
    })
  }
  return out
}

/**
 * 整段命令名命中清单（先区分大小写，再忽略大小写回退）。
 * 只认整名：`/review extra` 的 name 是 review；前缀不算，未知名返回 null，普通正文不误触。
 */
export function matchResourceCommand(commands: readonly ResourceCommand[] | unknown, rawName: unknown): ResourceCommand | null {
  if (!Array.isArray(commands) || typeof rawName !== "string") return null
  const name = rawName.trim().replace(/^\/+/, "")
  if (!name) return null
  const list = commands as ResourceCommand[]
  const exact = list.find((item) => item && item.name === name)
  if (exact) return exact
  const folded = name.toLowerCase()
  return list.find((item) => item && item.name.toLowerCase() === folded) ?? null
}

/** 执行时用清单里的规范名字（pi 区分大小写），参数原文保留（引号、$1 等都交给本机展开）。 */
export function resourceCommandText(name: unknown, arg: unknown): string {
  const clean = typeof name === "string" ? name.trim().replace(/^\/+/, "") : ""
  if (!clean) return ""
  const rest = typeof arg === "string" ? arg : ""
  return rest ? `/${clean} ${rest}` : `/${clean}`
}

/**
 * 资源命令的执行帧参数：走 prompt 命令注入并要求 pi 展开模板/技能（expandPromptTemplates）。
 * 只有明确选中清单里的命令才会走到这里；普通正文永远不带这个开关。
 * 忙时按输入卡的投递方式排队，扩展不认识该参数时会按 steer 处理。
 */
export function resourceExecArgs(text: string, options?: { busy?: boolean; followUp?: boolean }): Record<string, unknown> {
  const args: Record<string, unknown> = { message: text, expandPromptTemplates: true }
  if (options?.busy) args.streamingBehavior = options.followUp ? "followUp" : "steer"
  return args
}

/**
 * 思考级别整段匹配。written 先 trim；只和 levels 里的非空字符串比，不区分大小写。
 * 命中返回列表里的原字符串（同时命中取第一项）。前缀不算，没有命中返回 null。
 */
export function matchThinkingLevel(levels: unknown, written: unknown): string | null {
  if (typeof written !== "string" || !Array.isArray(levels)) return null
  const needle = written.trim().toLowerCase()
  if (!needle) return null
  for (const item of levels) {
    if (typeof item !== "string" || item.length === 0) continue
    if (item.toLowerCase() === needle) return item
  }
  return null
}

type ModelIdentity = { provider: string; modelId: string; name: string }

function modelIdentity(item: unknown): ModelIdentity | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null
  const rec = item as Record<string, unknown>
  if (typeof rec.provider !== "string" || rec.provider.length === 0) return null
  const modelId =
    typeof rec.modelId === "string" && rec.modelId.length > 0
      ? rec.modelId
      : typeof rec.id === "string" && rec.id.length > 0
        ? rec.id
        : ""
  if (!modelId) return null
  const name = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : ""
  return { provider: rec.provider, modelId, name }
}

/**
 * 模型整段匹配。written 先 trim；空或 models 不是数组返回 null。
 * 只认对象项：provider 为非空字符串，模型 id 用非空 modelId，否则非空 id。
 * 比较不区分大小写，命中返回该项原来的 provider 和模型 id。名字和前缀都不算。
 * 先比整段 provider/模型 id：一条返回，多于一条返回 null 且不再比裸 id。
 * 零条且 written 含 / 时只在第一个 / 切开，两侧 trim 后都非空再分别比；一条返回，多于一条返回 null。
 * 再比裸模型 id 与整段 written：一条返回，否则 null。
 */
export function matchExactModel(models: unknown, written: unknown): { provider: string; modelId: string } | null {
  if (typeof written !== "string" || !Array.isArray(models)) return null
  const needle = written.trim()
  if (!needle) return null
  const folded = needle.toLowerCase()
  const entries: { provider: string; modelId: string }[] = []
  for (const item of models) {
    const id = modelIdentity(item)
    if (id) entries.push({ provider: id.provider, modelId: id.modelId })
  }
  const full = entries.filter((entry) => `${entry.provider}/${entry.modelId}`.toLowerCase() === folded)
  if (full.length === 1) return full[0]
  if (full.length > 1) return null
  if (needle.includes("/")) {
    const cut = needle.indexOf("/")
    const provider = needle.slice(0, cut).trim()
    const modelId = needle.slice(cut + 1).trim()
    if (provider && modelId) {
      const split = entries.filter(
        (entry) => entry.provider.toLowerCase() === provider.toLowerCase() && entry.modelId.toLowerCase() === modelId.toLowerCase(),
      )
      if (split.length === 1) return split[0]
      if (split.length > 1) return null
    }
  }
  const bare = entries.filter((entry) => entry.modelId.toLowerCase() === folded)
  if (bare.length === 1) return bare[0]
  return null
}

function modelSearchText(item: unknown): string | null {
  const id = modelIdentity(item)
  if (!id) return null
  let text = `${id.provider} ${id.provider}/${id.modelId} ${id.provider} ${id.modelId}`
  if (id.name) text += ` ${id.name}`
  return text.toLowerCase()
}

function isSearchBoundary(ch: string): boolean {
  return /\s/.test(ch) || ch === "-" || ch === "_" || ch === "." || ch === "/" || ch === ":"
}

/** 小写词在小写文本里从左到右做子序列：indexOf 只取上一处之后的第一处。命中返回分数，否则 null。 */
function scoreModelWord(haystack: string, word: string): number | null {
  if (!word || word.length > haystack.length) return null
  let from = 0
  let prev = -1
  let consecutive = 0
  let score = 0
  for (let i = 0; i < word.length; i++) {
    const pos = haystack.indexOf(word[i]!, from)
    if (pos < 0) return null
    if (prev >= 0 && pos === prev + 1) {
      consecutive += 1
      score -= consecutive * 5
    } else {
      consecutive = 0
      if (prev >= 0) score += (pos - prev - 1) * 2
    }
    if (pos === 0 || isSearchBoundary(haystack[pos - 1]!)) score -= 10
    score += pos * 0.1
    prev = pos
    from = pos + 1
  }
  if (word === haystack) score -= 100
  return score
}

export const SLASH_GROUP_FREQUENT = "常用"
export const SLASH_GROUP_RESOURCES = "资源命令"

/** 空查询浏览时的一组菜单行；title 为 null 的组不渲染组标题（内置命令主组）。 */
export type SlashBrowseGroup<T> = { title: string | null; rows: T[] }

function slashRowKey(name: string): string {
  return name.replace(/^\/+/, "").toLowerCase()
}

/**
 * 空查询浏览分组（P3-5）：把内置命令行与资源命令行为「常用 / 内置 / 资源命令」三组。
 *  - 常用：按 usageOrder（已按频次/最近排好序的命令名）依次取行，内置与资源混合，
 *    取到的行从原组摘走不重复出现；组内上限 frequentLimit；无命中整组不出。
 *  - 内置优先口径与正文匹配一致：与内置同名的资源命令不进行（资源组与常用组都跳过）。
 *  - 资源组带来源组标题「资源命令」；内置主组无标题，与改造前的平铺观感衔接。
 * usageOrder 里当前清单不存在的名（别房资源、已删命令）静默跳过。
 */
export function groupSlashBrowse<T extends { name: string }>(
  builtins: readonly T[],
  resources: readonly T[],
  usageOrder: readonly string[],
  frequentLimit: number,
): SlashBrowseGroup<T>[] {
  const builtinKeys = new Set(builtins.map((row) => slashRowKey(row.name)))
  const taken = new Set<string>()
  const frequent: T[] = []
  for (const raw of usageOrder) {
    if (frequent.length >= Math.max(0, frequentLimit)) break
    const key = typeof raw === "string" ? slashRowKey(raw) : ""
    if (!key || taken.has(key)) continue
    const builtin = builtins.find((row) => slashRowKey(row.name) === key)
    if (builtin) {
      frequent.push(builtin)
      taken.add(key)
      continue
    }
    if (builtinKeys.has(key)) continue
    const resource = resources.find((row) => slashRowKey(row.name) === key)
    if (resource) {
      frequent.push(resource)
      taken.add(key)
    }
  }
  const restBuiltins = builtins.filter((row) => !taken.has(slashRowKey(row.name)))
  const restResources = resources.filter((row) => {
    const key = slashRowKey(row.name)
    return !taken.has(key) && !builtinKeys.has(key)
  })
  const groups: SlashBrowseGroup<T>[] = []
  if (frequent.length) groups.push({ title: SLASH_GROUP_FREQUENT, rows: frequent })
  if (restBuiltins.length) groups.push({ title: null, rows: restBuiltins })
  if (restResources.length) groups.push({ title: SLASH_GROUP_RESOURCES, rows: restResources })
  return groups
}

/** 整词是字母后接数字，或数字后接字母时，对调这两段。 */
function swapAlphaNumWord(word: string): string | null {
  const lettersThenDigits = /^([a-z]+)(\d+)$/.exec(word)
  if (lettersThenDigits) return lettersThenDigits[2] + lettersThenDigits[1]
  const digitsThenLetters = /^(\d+)([a-z]+)$/.exec(word)
  if (digitsThenLetters) return digitsThenLetters[2] + digitsThenLetters[1]
  return null
}

function scoreModelQueryWord(haystack: string, word: string): number | null {
  const direct = scoreModelWord(haystack, word)
  if (direct != null) return direct
  const swapped = swapAlphaNumWord(word)
  if (!swapped) return null
  const again = scoreModelWord(haystack, swapped)
  if (again == null) return null
  return again + 5
}

/**
 * 按选择器搜索词过滤模型。query 不是字符串、trim 后为空，或按空白和 / 切开没有词时，按原顺序返回。
 * 搜索文本是「provider provider/模型 id provider 模型 id」，显示名非空再追加。
 * 每个词都要匹配；低分在前，同分保持原相对顺序。
 */
export function filterModelsBySelectorQuery<T>(models: readonly T[] | unknown, query: unknown): T[] {
  if (!Array.isArray(models)) return []
  const list = models as T[]
  if (typeof query !== "string" || !query.trim()) return list
  const words = query
    .trim()
    .split(/[\s/]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0)
  if (words.length === 0) return list
  const ranked: { item: T; score: number; index: number }[] = []
  list.forEach((item, index) => {
    const text = modelSearchText(item)
    if (text == null) return
    let score = 0
    for (const word of words) {
      const part = scoreModelQueryWord(text, word)
      if (part == null) return
      score += part
    }
    ranked.push({ item, score, index })
  })
  ranked.sort((a, b) => a.score - b.score || a.index - b.index)
  return ranked.map((row) => row.item)
}
