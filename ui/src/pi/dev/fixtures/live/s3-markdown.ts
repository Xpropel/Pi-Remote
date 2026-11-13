/**
 * s3/markdown：r-s1 换成一个 markdown 丰富的已完成回合，给对话流的正文排版和卡片几何对图。
 * 回合里有：思考、探索（grep + read）、跑失败的终端卡（输出末尾带 pi 的 "Command exited with code 1"）、跑通的终端卡；
 * 收尾正文 = 标题、嵌套列表（三层）、长表格（8 行 4 列、格里有行内代码）、带语言 / 不带语言的代码块、两段引用、链接、长 URL。
 * 形状照真实会话（D:\pi-e2e\s3 里 DeepSeek 的回答）改写，内容是虚构的示例项目。
 */
import type { Block, Item } from "../../../../relay/transcript.ts"
import { BASE, tool, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const S = 1000
const M = 60 * S
const T0 = MOCK_NOW - 6 * M
const MODEL = "claude-sonnet-4-5"

function assistant(key: string, at: number, durationMs: number, stopReason: string, blocks: Block[], totalTokens?: number): Item {
  return {
    kind: "assistant",
    key,
    model: MODEL,
    startedAt: at,
    durationMs,
    endedAt: at + durationMs,
    timestamp: at,
    stopReason,
    blocks,
    ...(totalTokens ? { usage: { totalTokens } } : {}),
  }
}

const FORMAT_JS = [
  `// 把分（整数）格式化成 "¥12.30" 这样的字符串`,
  `function formatPrice(cents) {`,
  `  const sign = cents < 0 ? "-" : ""`,
  `  const abs = Math.abs(cents)`,
  `  const yuan = Math.floor(abs / 100)`,
  `  const fen = String(abs % 100).padStart(2, "0")`,
  `  return sign + "¥" + yuan + "." + fen`,
  `}`,
  ``,
  `module.exports = { formatPrice }`,
  ``,
].join("\n")

const FAILED_RUN = [
  `✔ 普通价格 (0.4ms)`,
  `✔ 负数 (0.1ms)`,
  `✖ 千分位 (0.6ms)`,
  `  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`,
  `  + actual - expected`,
  ``,
  `  + '¥12345.00'`,
  `  - '¥12,345.00'`,
  `ℹ tests 3`,
  `ℹ pass 2`,
  `ℹ fail 1`,
  ``,
  `Command exited with code 1`,
].join("\n")

const PASSED_RUN = [`✔ 普通价格 (0.4ms)`, `✔ 负数 (0.1ms)`, `✔ 千分位 (0.2ms)`, `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`, ``].join("\n")

const EXPLAIN = `## formatPrice 是怎么工作的

把**以分为单位的整数**格式化成人民币字符串：负数加 \`-\`，整数部分每三位一个逗号，分补齐两位。思路和 [Intl.NumberFormat](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat) 的 \`currency\` 样式一致，但不依赖运行环境的区域设置。

### 处理步骤

1. **取符号**：\`cents < 0\` 时记下 \`-\`，后面一律用绝对值计算。
   - 例：\`-1230\` → 符号 \`-\`，绝对值 \`1230\`
   - 符号放在 \`¥\` 前面（\`-¥12.30\`），和财务报表一致
2. **拆整数与分**：全程整数运算，不碰浮点。
   - \`yuan = Math.floor(abs / 100)\`
   - \`fen = abs % 100\`，再补齐两位：
     - \`5\` → \`05\`
     - \`50\` → \`50\`
3. **加千分位**：正则 \`\\B(?=(\\d{3})+(?!\\d))\` 从个位往左每三位插一个逗号。

### 规则一览

| 场景 | 输入（分） | 输出 | 说明 |
| --- | --- | --- | --- |
| 普通价格 | \`1230\` | \`¥12.30\` | 分补齐两位 |
| 零 | \`0\` | \`¥0.00\` | 不写成 \`¥0\` |
| 负数 | \`-1230\` | \`-¥12.30\` | 符号在货币符号前面 |
| 千分位 | \`1234500\` | \`¥12,345.00\` | 每三位一个逗号 |
| 百万级 | \`123456789\` | \`¥1,234,567.89\` | 逗号可以有好几个 |
| 一分钱 | \`1\` | \`¥0.01\` | 整数部分补 \`0\` |
| 非整数 | \`12.5\` | 抛 \`TypeError\` | 调用方必须先取整，免得把浮点误差藏起来 |
| 超大值 | \`Number.MAX_SAFE_INTEGER\` | \`¥90,071,992,547,409.91\` | 超过安全整数时结果不可信，调用方自己校验 |

### 核心代码

\`\`\`ts
export function formatPrice(cents: number): string {
  if (!Number.isInteger(cents)) throw new TypeError(\`cents 必须是整数：\${cents}\`)
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(cents)
  const yuan = String(Math.floor(abs / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")
  const fen = String(abs % 100).padStart(2, "0")
  return \`\${sign}¥\${yuan}.\${fen}\`
}
\`\`\`

测试的最后几行（原样贴出，没标语言）：

\`\`\`
✔ 千分位 (0.2ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
\`\`\`

> 千分位对所有 ≥ 4 位的整数部分生效（如 \`¥5,000.00\`），已经覆盖注释里「超过一万」的要求。
>
> 只想在一万以上加逗号的话，正则改用后行断言，见 [MDN：断言](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide/Regular_expressions/Assertions)。

命令行跑法见 https://nodejs.org/api/test.html#running-tests-from-the-command-line ，CI 里加 \`--test-reporter=spec\` 更好读。`

const ITEMS: Item[] = [
  {
    kind: "user",
    key: "u-s3-1",
    text: "补上 format.js 的千分位，跑测试；最后用标题、嵌套列表、表格、代码块和引用解释 formatPrice。",
    images: [],
    timestamp: T0,
    from: "remote",
    status: "delivered",
  },
  assistant("a-s3-2", T0 + 2 * S, 5 * S, "toolUse", [
    { kind: "thinking", text: "**先找到定义和测试**\n\n要改 formatPrice，先 grep 出定义和用到它的测试，再读源码。" },
    tool("t-s3-grep", "grep", { pattern: "formatPrice", path: "." }, `format.js:2:function formatPrice(cents) {\nformat.test.js:3:const { formatPrice } = require("./format")\n`),
    tool("t-s3-read", "read", { path: "format.js" }, FORMAT_JS),
  ], 2_100),
  assistant("a-s3-3", T0 + 8 * S, 4 * S, "toolUse", [
    { kind: "text", text: "源码里还没有千分位。先跑一遍测试看失败在哪：" },
    tool("t-s3-test1", "bash", { command: "cd D:/pi-e2e/s3 && node --test 2>&1" }, FAILED_RUN, { state: "output-error" }),
  ], 3_400),
  assistant("a-s3-4", T0 + 14 * S, 6 * S, "toolUse", [
    { kind: "thinking", text: "千分位那条失败：整数部分没加逗号。用正则从个位往左每三位插一个逗号，改完再跑。" },
    { kind: "text", text: "加上千分位后再跑：" },
    tool("t-s3-test2", "bash", { command: "cd D:/pi-e2e/s3 && node --test 2>&1" }, PASSED_RUN),
  ], 4_200),
  assistant("a-s3-5", T0 + 22 * S, 18 * S, "stop", [{ kind: "text", text: EXPLAIN }], 9_800),
]

const fixture: PiLiveFixture = {
  id: "s3-markdown",
  now: MOCK_NOW,
  note: "S3 第二轮：markdown 丰富的已完成回合（标题、三层嵌套列表、8 行长表格、ts / 无语言代码块、引用、链接、长 URL）；失败的终端卡按最近回合的规则展开。",
  relay: {
    ...BASE,
    transcript: transcriptOf(ITEMS),
  },
}
export default fixture
