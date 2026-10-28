import type { PiScreenMeta, PiScreenProps } from "@/pi/dev/registry"
import { BDesktop, BPhoneChat } from "@/pi/dev/frames/BFrames"
import { piBaseName } from "@/components/pi/shared/format"
import { PiCodeBlock } from "@/components/pi/conversation/PiCodeBlock"
import { PiFilePane } from "@/components/pi/conversation/PiFilePane"
import { PiPaneTabs } from "@/components/pi/conversation/PiPaneTabs"
import { PiRoot, PiStaticProvider } from "@/components/pi/shared"
import type { PiFileResult } from "@/components/pi/shared/types"

/**
 * 下划线开发屏（不计入 32 屏、不参加对图）：kit 分词器不认的语言走 shiki（PLAN 4.4、D12）。
 * python / bash / go 三个围栏代码块 + 桌面右 pane 的 .py 文件视图（「大小 · Python」、行号、高亮）。深浅两种主题都看。
 * shiki 按需加载，代码块先按纯文本出现，高亮回来后换成带色的记号（[data-highlight="shiki"]）。
 */
export const piScreen: PiScreenMeta = {
  id: "code-langs",
  area: "b",
  title: "代码高亮：shiki 语言（开发屏）",
  themes: ["light", "dark"],
  states: ["shiki 加载中（纯文本）", "不认识的语言（纯文本）"],
  notes: "PLAN 4.4。颜色全是 --cw-syntax-* 变量（highlight.ts 的 PI_SYNTAX_THEME），深浅主题不重新高亮。kit 的 ts / tsx / js / jsx / json / html 仍走 kit 分词器（画廊 L1 不变）。",
}

const PY = [
  "import asyncio",
  "from dataclasses import dataclass",
  "",
  "@dataclass",
  "class Viewport:",
  "    height: float",
  "    offset_top: float = 0.0",
  "",
  "async def wait_closed(vv: Viewport, base: float, timeout: float = 0.12) -> bool:",
  '    """键盘收起：高度回到基线，并且 offsetTop 回到 0。"""',
  "    delta = base - vv.height",
  "    if delta < 120 and vv.offset_top <= 1:",
  "        return True",
  "    await asyncio.sleep(timeout)  # 去抖 120ms",
  "    return False",
].join("\n")

const SH = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "",
  "# 只跑手机相关的用例",
  'PATTERN="${1:-mobile}"',
  "for f in test/*.test.mjs; do",
  '  if grep -q "$PATTERN" "$f"; then',
  '    node --test "$f" || exit 1',
  "  fi",
  "done",
  'echo "done: $PATTERN"',
].join("\n")

const GO = [
  "package viewport",
  "",
  'import "math"',
  "",
  "// CloseDelta 返回键盘收起时的高度差；offsetTop 没回到 0 时返回 +Inf。",
  "func CloseDelta(height, base, offsetTop float64) float64 {",
  "\tif offsetTop > 1 {",
  "\t\treturn math.Inf(1)",
  "\t}",
  "\treturn base - height",
  "}",
  "",
  "type Viewport struct {",
  '\tHeight    float64 `json:"height"`',
  '\tOffsetTop float64 `json:"offsetTop"`',
  "}",
].join("\n")

const PY_FILE: PiFileResult = {
  path: "scripts/mobile/viewport.py",
  size: new TextEncoder().encode(PY + "\n").length,
  // get_file 对 .py 常回 text/plain 或 text/x-python：语言名按扩展名认（fileLangLabelOf）
  mime: "text/x-python",
  encoding: "utf-8",
  truncated: false,
  text: PY + "\n",
}

/** 代码块走可交互态（PiStaticProvider value=false）：复制钮带 44 点击区外扩，和产品里一样（画廊舞台默认是静态态） */
function Blocks() {
  return (
    <PiStaticProvider value={false}>
      <BlockList />
    </PiStaticProvider>
  )
}

function BlockList() {
  return (
    <div data-pi-part="code-langs" className="flex flex-col">
      {[
        { label: "python", code: PY },
        { label: "bash", code: SH },
        { label: "go", code: GO },
      ].map((b) => (
        <section key={b.label}>
          <div className="mt-3 text-(length:--cw-text-sm) text-(--cw-pi-text-secondary)">{b.label}</div>
          <PiCodeBlock code={b.code} lang={b.label} foldAfter={20} />
        </section>
      ))}
    </div>
  )
}

export default function Screen({ viewport, theme }: PiScreenProps) {
  const phone = viewport === "phone"
  return (
    <PiRoot viewport={viewport} theme={theme} keyboard={piScreen.keyboard}>
      {phone ? (
        <BPhoneChat roomId="r-s1">
          <div className="px-4 pb-4">
            <Blocks />
          </div>
        </BPhoneChat>
      ) : (
        <BDesktop
          roomId="r-s1"
          pane={
            <>
              <PiPaneTabs active="file" file={{ name: piBaseName(PY_FILE.path), kind: "file" }} />
              <PiFilePane file={PY_FILE} variant="desktop" />
            </>
          }
        >
          <div className="absolute inset-0 overflow-y-auto px-6 pb-6">
            <Blocks />
          </div>
        </BDesktop>
      )}
    </PiRoot>
  )
}
