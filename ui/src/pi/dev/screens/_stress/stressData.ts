/**
 * 压力屏的数据（PLAN 4.3 验证；下划线目录里的 .ts 辅助文件，不注册成屏）。long-transcript 开发屏和 #/play/long-transcript 共用。
 * 1 万条（= relay/transcript.ts 的 TRANSCRIPT_MAX_ITEMS，状态层的上限），每 10 条一个回合：
 * 用户卡 → 思考 + 两次搜索（探索行）→ 读取 → 正文 → 终端卡 → 带 ts 代码块的正文 → diff 卡（details.patch）→ 测试终端卡 → 正文 → 收尾正文。
 * 渲染窗只挂最后 300 条（30 个回合），所以首帧的成本是这 30 个回合，不是 1 万条。
 */
import { EDIT_VIEWPORT_2, NOW, tool, VIEWPORT_PATH } from "@/pi/dev/fixtures/gallery/b"
import type { PiBlock, PiItem } from "@/components/pi/shared/types"

/** = relay/transcript.ts 的 TRANSCRIPT_MAX_ITEMS（test/pi-p4-b.test.mjs 核对两边一致） */
export const STRESS_ITEMS = 10_000

const S = 1000
const MODEL = "claude-sonnet-4-5"
const TEST_OUT = ["✔ 键盘弹出 (0.8ms)", "✔ 收起要等 offsetTop 回到 0 (1.1ms)", "✔ 去抖 120ms (121.4ms)", "ℹ tests 23", "ℹ pass 23", "ℹ fail 0"].join("\n")
const TS_CODE = [
  "export function closeDelta(vv: VisualViewport, base: number): number {",
  "  // 键盘收起：高度回到基线，且 offsetTop 回到 0",
  "  const delta = base - vv.height",
  "  return vv.offsetTop <= 1 ? delta : Number.POSITIVE_INFINITY",
  "}",
].join("\n")

function blocksOf(n: number, k: number): PiBlock[] {
  const id = (s: string) => `st-${n}-${s}`
  switch (k) {
    case 1:
      return [
        { kind: "thinking", observedMs: 3 * S, text: `**第 ${n} 段排查**\n\n先找 visualViewport 的监听，再看收起判定。` },
        tool(id("g1"), "grep", { pattern: "visualViewport", path: "ui/src" }, `${VIEWPORT_PATH}:18`),
        tool(id("g2"), "find", { pattern: "*Viewport*", path: "ui/src" }, VIEWPORT_PATH),
      ]
    case 2:
      return [tool(id("r"), "read", { path: VIEWPORT_PATH, offset: 1, limit: 92 }, "…")]
    case 3:
    case 8:
      return [
        {
          kind: "text",
          text: "说明",
          prose: [
            { p: [`第 ${n} 条：收起判定只看了高度差，没等 `, { code: "offsetTop" }, " 回落，", { file: VIEWPORT_PATH }, " 里改成两步。"] },
            { p: ["去抖期间沿用上一次的位置，只更新高度和偏移；超时回调改读最新值。"] },
          ],
        },
      ]
    case 4:
      return [tool(id("b1"), "bash", { command: "git status --short" }, " M ui/src/mobile/useMobileViewport.ts", { exitCode: 0 })]
    case 5:
      return [{ kind: "text", text: "代码", prose: [{ p: ["判定函数："] }, { code: TS_CODE, lang: "ts" }] }]
    case 6:
      return [
        tool(id("e"), "edit", { path: VIEWPORT_PATH, oldText: "a", newText: "b" }, "Successfully replaced text.", { details: { patch: EDIT_VIEWPORT_2 } }),
      ]
    case 7:
      return [tool(id("b2"), "bash", { command: "npm test -- mobile" }, TEST_OUT, { exitCode: 0 })]
    default:
      return [{ kind: "text", text: "收尾", prose: [{ p: [`第 ${n} 轮完成：23 个用例全部通过。`] }] }]
  }
}

/** 第 i 条（0 起）：每 10 条一个回合，k = 0 是用户卡；时间从 now 往前每条 6 秒 */
export function stressItems(count: number = STRESS_ITEMS, now: number = NOW): PiItem[] {
  const items: PiItem[] = []
  for (let i = 0; i < count; i++) {
    const at = now - (count - i) * 6 * S
    const k = i % 10
    const n = Math.floor(i / 10) + 1
    if (k === 0) {
      items.push({ kind: "user", key: `su-${i}`, text: `第 ${n} 轮：手机键盘收起时输入框还会跳吗？再看一遍。`, images: [], timestamp: at, from: "remote", status: "delivered" })
    } else {
      items.push({
        kind: "assistant",
        key: `sa-${i}`,
        model: MODEL,
        startedAt: at,
        durationMs: 5 * S,
        timestamp: at,
        usage: { totalTokens: 18_000 + k * 1_000 },
        stopReason: k === 9 ? "stop" : "toolUse",
        blocks: blocksOf(n, k),
      })
    }
  }
  return items
}
