/**
 * 会话信息（plan §7.1 session-info、P5.3；design §3.3 session-info、§1.9 诚实数据）。纯函数，node --test 直接加载。
 * 缺数据一律返回 null（整行不出现），不填默认值。
 */

/** usage_state 里的 token 计数（同 useRelay 的 UsageState.tokens） */
export type PiUsageTokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }

/** 缓存命中（百分数，四舍五入）= cacheRead / (input + cacheRead)；缺数或分母为 0 时 null */
export function cacheHitOf(tokens: PiUsageTokens | null | undefined): number | null {
  const input = tokens?.input
  const read = tokens?.cacheRead
  if (typeof input !== "number" || typeof read !== "number" || !Number.isFinite(input) || !Number.isFinite(read)) return null
  if (input + read <= 0) return null
  return Math.round((read / (input + read)) * 100)
}

/** get_git_branch 的回包（G11，已对照 extension/pi-remote-sync.ts 的 cmdGetGitBranch 核实）：{ branch, repoRoot, detached, error? } */
export type PiGitBranch = { branch: string; detached: boolean }

/**
 * 回包 → 分支。branch 为 null（不在仓库里）、出错、形状不对时返回 null（分支行整行不出现）。
 * detached = HEAD 指向提交而不是分支，branch 是短 SHA。
 */
export function gitBranchOf(reply: unknown): PiGitBranch | null {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) return null
  const rec = reply as Record<string, unknown>
  if (typeof rec.branch !== "string" || !rec.branch.trim()) return null
  return { branch: rec.branch.trim(), detached: rec.detached === true }
}

/** 分支行的文字：detached 时 branch 是短 SHA，后面标"（游离）"，免得把提交号当分支名 */
export function gitBranchText(branch: PiGitBranch | null): string | null {
  if (!branch) return null
  return branch.detached ? `${branch.branch}（游离）` : branch.branch
}

/** 模型行："Claude Sonnet 4.5 · medium"（模型名优先 modelMeta.name，再 modelId，再 relay.model；没有模型就 null） */
export function sessionModelLine(meta: { name?: string; modelId?: string } | null | undefined, model: string | null | undefined, thinkingLevel: string | null | undefined): string | null {
  const name = meta?.name || meta?.modelId || model || ""
  if (!name) return null
  return thinkingLevel ? `${name} · ${thinkingLevel}` : name
}
