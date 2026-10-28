/** b/file-pane：从流里点 FileChip 打开 ui/src/mobile/useMobileViewport.ts（get_file 的结果）。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const TEXT = [
  `import { useEffect, useRef, useState } from "react"`,
  ``,
  `export const KEYBOARD_OPEN_DELTA = 120`,
  `export const KEYBOARD_CLOSE_DELTA = 48`,
  ``,
  `export function keyboardLikelyOpen(full: number, visible: number): boolean {`,
  `  return full - visible > KEYBOARD_OPEN_DELTA && visible / full < 0.82`,
  `}`,
  ``,
  `export function useMobileViewport() {`,
  `  const focused = useRef(false)`,
  `  const [state, setState] = useState({ height: 0, offsetTop: 0, keyboardOpen: false })`,
  `  useEffect(() => {`,
  `    const vv = window.visualViewport`,
  `    if (!vv) return`,
  `    const update = () => {`,
  `      const height = vv.height`,
  `      const offsetTop = vv.offsetTop`,
  `      const delta = window.innerHeight - height`,
  `      // 收起分两步：高度差回落后，还要等 offsetTop 回到 0 再判定`,
  `      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {`,
  `        setState({ height: vv.height, offsetTop: vv.offsetTop, keyboardOpen: false })`,
  `        return`,
  `      }`,
  `      // 去抖期间沿用上一次的位置，只更新高度和偏移`,
  `      setState((prev) => ({ ...prev, height, offsetTop }))`,
  `    }`,
  `    vv.addEventListener("resize", update)`,
  `    return () => vv.removeEventListener("resize", update)`,
  `  }, [])`,
  `  return state`,
  `}`,
  ``,
].join("\n")

/**
 * get_file 回包，照扩展的真实契约（G10，P5.4 对照 extension/pi-remote-sync.ts 的 readFileInRoot 核实）：
 * { name, mimeType, size, encoding: "utf8" | "base64", data, truncated }；.ts 文件扩展给的 mimeType 是 text/plain（语言名由界面按扩展名认）。
 * path / text 两个字段不是契约里的，只给 test/pi-fixtures.test.mjs 现有的 b/file-pane 断言用（R2/lane-requests/p5-b.md 请 p5-code 改断言后删掉）。
 */
export const FILE_RESULT = {
  name: "useMobileViewport.ts",
  mimeType: "text/plain",
  size: new TextEncoder().encode(TEXT).length,
  encoding: "utf8",
  data: TEXT,
  truncated: false,
}

const fixture: PiLiveFixture = {
  id: "file-pane",
  now: MOCK_NOW,
  note: "文件正文比 replica 的 VIEWPORT_V2 短（只取关键段）；大小按这段文字的实际字节算。回包字段照扩展的 get_file 契约（G10）。",
  relay: {
    ...BASE,
    getFile: async () => FILE_RESULT,
  },
}
export default fixture
