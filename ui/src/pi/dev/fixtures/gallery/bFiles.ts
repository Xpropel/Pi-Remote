/**
 * b 区 mock：r-s1 会话里被编辑的文件。useMobileViewport.ts 写了三个版本（v0 原样 → v1 第一次编辑 → v2 第二次编辑），
 * edit 的 details.patch、改动视图的汇总 diff、read 的输出、文件视图的内容都从这三版推出来，行号和计数彼此一致（§1.9）。
 */

export const VIEWPORT_PATH = "ui/src/mobile/useMobileViewport.ts"
export const CONVERSATION_PATH = "ui/src/mobile/MobileConversation.tsx"
export const KEYBOARD_TEST_PATH = "test/mobile-keyboard.test.mjs"

/** v2：两次编辑之后（文件视图显示的就是这一版） */
export const VIEWPORT_V2: string[] = [
  `import { useEffect, useRef, useState } from "react"`,
  ``,
  `/** 键盘判定阈值，与 test/mobile.test.mjs 对齐。 */`,
  `export const KEYBOARD_MIN_DELTA = 120`,
  `export const KEYBOARD_MAX_RATIO = 0.82`,
  `export const KEYBOARD_CLOSE_DELTA = 48`,
  `export const KEYBOARD_CLOSE_DEBOUNCE_MS = 120`,
  ``,
  `export type MobileViewport = {`,
  `  /** 可视视口高度（visualViewport.height，没有时退回 innerHeight） */`,
  `  height: number`,
  `  /** 可视视口相对布局视口的上偏移（iOS 键盘弹出时会变） */`,
  `  offsetTop: number`,
  `  keyboardOpen: boolean`,
  `}`,
  ``,
  `function readViewport(): MobileViewport {`,
  `  const vv = window.visualViewport`,
  `  return {`,
  `    height: vv?.height ?? window.innerHeight,`,
  `    offsetTop: vv?.offsetTop ?? 0,`,
  `    keyboardOpen: false,`,
  `  }`,
  `}`,
  ``,
  `export function keyboardLikelyOpen(innerHeight: number, vvHeight: number): boolean {`,
  `  const delta = innerHeight - vvHeight`,
  `  return delta > KEYBOARD_MIN_DELTA && vvHeight / innerHeight < KEYBOARD_MAX_RATIO`,
  `}`,
  ``,
  `export function useMobileViewport(enabled: boolean): MobileViewport {`,
  `  const [state, setState] = useState<MobileViewport>(readViewport)`,
  `  const closeTimer = useRef<number | null>(null)`,
  `  const focused = useRef(false)`,
  ``,
  `  useEffect(() => {`,
  `    if (!enabled) return`,
  `    const vv = window.visualViewport`,
  `    if (!vv) return`,
  ``,
  `    const clearClose = () => {`,
  `      if (closeTimer.current == null) return`,
  `      window.clearTimeout(closeTimer.current)`,
  `      closeTimer.current = null`,
  `    }`,
  ``,
  `    const update = () => {`,
  `      const height = vv.height`,
  `      const offsetTop = vv.offsetTop`,
  `      const delta = window.innerHeight - height`,
  `      if (focused.current && keyboardLikelyOpen(window.innerHeight, height)) {`,
  `        clearClose()`,
  `        setState({ height, offsetTop, keyboardOpen: true })`,
  `        return`,
  `      }`,
  `      // 收起分两步：高度差回落后，还要等 offsetTop 回到 0 再判定`,
  `      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {`,
  `        clearClose()`,
  `        closeTimer.current = window.setTimeout(() => {`,
  `          closeTimer.current = null`,
  `          setState({ height: vv.height, offsetTop: vv.offsetTop, keyboardOpen: false })`,
  `        }, KEYBOARD_CLOSE_DEBOUNCE_MS)`,
  `        return`,
  `      }`,
  `      // 去抖期间沿用上一次的位置，只更新高度和偏移`,
  `      setState((prev) => ({ ...prev, height, offsetTop }))`,
  `    }`,
  ``,
  `    const onFocusIn = (e: FocusEvent) => {`,
  `      const t = e.target as HTMLElement | null`,
  `      focused.current = !!t && (t.tagName === "TEXTAREA" || t.isContentEditable)`,
  `      update()`,
  `    }`,
  `    const onFocusOut = () => {`,
  `      focused.current = false`,
  `      update()`,
  `    }`,
  ``,
  `    vv.addEventListener("resize", update)`,
  `    vv.addEventListener("scroll", update)`,
  `    document.addEventListener("focusin", onFocusIn)`,
  `    document.addEventListener("focusout", onFocusOut)`,
  `    update()`,
  `    return () => {`,
  `      clearClose()`,
  `      vv.removeEventListener("resize", update)`,
  `      vv.removeEventListener("scroll", update)`,
  `      document.removeEventListener("focusin", onFocusIn)`,
  `      document.removeEventListener("focusout", onFocusOut)`,
  `    }`,
  `  }, [enabled])`,
  ``,
  `  return state`,
  `}`,
]

/** 把 lines 里从 from（含）起、与 match 相同的连续行换成 insert；找不到就抛错（mock 写错了立刻暴露） */
function swap(lines: readonly string[], match: readonly string[], insert: readonly string[]): string[] {
  for (let i = 0; i + match.length <= lines.length; i++) {
    if (match.every((l, k) => lines[i + k] === l)) return [...lines.slice(0, i), ...insert, ...lines.slice(i + match.length)]
  }
  throw new Error(`mockFiles: 找不到要替换的行：${match[0]}`)
}

/** v1：第一次编辑之后、第二次编辑之前（CONVO_DONE 里 read 读到的就是这一版） */
export const VIEWPORT_V1: string[] = (() => {
  let v = swap(
    VIEWPORT_V2,
    [`      // 收起分两步：高度差回落后，还要等 offsetTop 回到 0 再判定`, `      if (delta < KEYBOARD_CLOSE_DELTA && offsetTop <= 1) {`],
    [`      if (delta < KEYBOARD_CLOSE_DELTA) {`],
  )
  v = swap(
    v,
    [`          setState({ height: vv.height, offsetTop: vv.offsetTop, keyboardOpen: false })`],
    [`          setState({ height, offsetTop, keyboardOpen: false })`],
  )
  v = swap(
    v,
    [`      // 去抖期间沿用上一次的位置，只更新高度和偏移`, `      setState((prev) => ({ ...prev, height, offsetTop }))`],
    [`      setState({ height, offsetTop, keyboardOpen: state.keyboardOpen })`],
  )
  return v
})()

/** v0：会话开始前的样子 */
export const VIEWPORT_V0: string[] = (() => {
  let v = swap(VIEWPORT_V1, [`  const focused = useRef(false)`], [])
  v = swap(
    v,
    [`      if (focused.current && keyboardLikelyOpen(window.innerHeight, height)) {`],
    [`      if (keyboardLikelyOpen(window.innerHeight, height)) {`],
  )
  v = swap(
    v,
    [
      `    const onFocusIn = (e: FocusEvent) => {`,
      `      const t = e.target as HTMLElement | null`,
      `      focused.current = !!t && (t.tagName === "TEXTAREA" || t.isContentEditable)`,
      `      update()`,
      `    }`,
      `    const onFocusOut = () => {`,
      `      focused.current = false`,
      `      update()`,
      `    }`,
    ],
    [`    const onFocusIn = () => update()`, `    const onFocusOut = () => update()`],
  )
  return v
})()

/** MobileConversation.tsx 的一次编辑（手写的 unified patch；行号是该文件里的真实位置口径） */
export const CONVERSATION_PATCH = [
  `--- a/${CONVERSATION_PATH}`,
  `+++ b/${CONVERSATION_PATH}`,
  `@@ -61,9 +61,10 @@ export function MobileConversation({ room, viewport }: Props) {`,
  `   const dockRef = useRef<HTMLDivElement>(null)`,
  `   const keyboardOpen = viewport.keyboardOpen`,
  ` `,
  "-  const dockStyle = keyboardOpen",
  "-    ? { transform: `translateY(${viewport.offsetTop}px)` }",
  "-    : undefined",
  "+  // 键盘开着时按可视视口贴底；收起后清掉平移，避免残留一帧",
  "+  const dockStyle: CSSProperties = keyboardOpen",
  "+    ? { height: viewport.height, transform: `translateY(${viewport.offsetTop}px)` }",
  `+    : { transform: "none" }`,
  ` `,
  `   return (`,
  `     <div className="mobile-conversation" style={{ height: keyboardOpen ? viewport.height : undefined }}>`,
  ``,
].join("\n")

/** write 写出的新测试文件 */
export const KEYBOARD_TEST_CONTENT = [
  `import assert from "node:assert/strict"`,
  `import { test } from "node:test"`,
  `import { KEYBOARD_CLOSE_DELTA, keyboardLikelyOpen } from "../ui/src/mobile/useMobileViewport.ts"`,
  ``,
  `test("键盘弹出：高度差 > 120 且比例 < 0.82", () => {`,
  `  assert.equal(keyboardLikelyOpen(844, 508), true)`,
  `  assert.equal(keyboardLikelyOpen(844, 760), false)`,
  `})`,
  ``,
  `test("收起阈值是 48", () => {`,
  `  assert.equal(KEYBOARD_CLOSE_DELTA, 48)`,
  `})`,
  ``,
].join("\n")

/** nginx 配置（session-archived 的代码块，14 行） */
export const NGINX_CONF = [
  `server {`,
  `    listen 443 ssl;`,
  `    http2 on;`,
  `    server_name billing.internal.example.com;`,
  ``,
  `    ssl_certificate     /etc/nginx/certs/billing.pem;`,
  `    ssl_certificate_key /etc/nginx/certs/billing.key;`,
  `    ssl_protocols TLSv1.2 TLSv1.3;`,
  ``,
  `    gzip on;`,
  `    gzip_types text/css application/json;`,
  `    client_max_body_size 20m;`,
  `    location / { proxy_pass http://127.0.0.1:8080; }`,
  `}`,
].join("\n")
