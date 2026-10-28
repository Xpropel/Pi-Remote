/** c/model-menu：模型与思考级别菜单：当前 Claude Sonnet 4.5 · medium；Qwen3 Coder 未配置。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, input: ["text", "image"] },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200000, input: ["text", "image"] },
  { provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 400000, input: ["text", "image"] },
  // cost 照 pi 1.3.0 模型目录（pi-ai providers/data/google.json 的 gemini-2.5-pro），tiers 由扩展 toModel 原样转发（G12）
  {
    provider: "google", id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1000000,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, tiers: [{ inputTokensAbove: 200000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }] },
  },
  { provider: "deepseek", id: "deepseek-v3.1", name: "DeepSeek V3.1", contextWindow: 128000, input: ["text"] },
  { provider: "qwen", id: "qwen3-coder", name: "Qwen3 Coder", contextWindow: 262000, input: ["text"] },
]
/**
 * get_available_models 回包（replica c/mock.ts C_MODELS）。形状照 chat/slash.tsx 的读法：models = 全部、available = 已配置的；
 * 「未配置」= 在 models 里不在 available 里。逐字段没有和 data-interface §4.11.2 核对。
 */
export const GET_MODELS = { models: MODELS, available: MODELS.filter((x) => x.provider !== "qwen") }
/** get_available_thinking_levels 回包 */
export const GET_THINKING_LEVELS = { levels: ["off", "minimal", "low", "medium", "high"] }

const fixture: PiLiveFixture = {
  id: "model-menu",
  now: MOCK_NOW,
  note: "Gemini 行的费用说明「输入超过 200k 时单价翻倍」由 costNoteOf 从回包的 cost.tiers 推出（G12 前端修）；接进 PiModelMenu 留给 P5 c 线。",
  relay: {
    ...BASE,
    // get_git_branch（扩展回包 { branch, repoRoot, detached }）给状态行的分支：P5 c 线加
    runCommand: commandTable({
      get_available_models: GET_MODELS,
      get_available_thinking_levels: GET_THINKING_LEVELS,
      get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false },
    }),
  },
}
export default fixture
