import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * 构建入口（实施计划 D1、D6）：
 * - 默认：index.html（新界面，入口 src/pi/main.tsx；P7 B1 起唯一的产品入口，旧界面和 next.html 已下线）。
 * - PI_GALLERY=1：只构建 gallery.html（开发画廊，对图基准页，不进生产包），默认输出到 dist/gallery，不碰 ../web。
 * dev server 不受影响：两个 html 都能直接打开。
 */
const gallery = process.env.PI_GALLERY === "1"

/**
 * 生产包 vendor 拆分（P4 R2 性能）：把入口里的大依赖拆成稳定命名 chunk，
 * 让「改 UI 代码」不失效第三方库缓存（入口 chunk 变小、vendor hash 稳定）；
 * 首屏引用闭包总量保持 ~等价（只多几个可缓存请求）。只对产品构建生效：
 * - gallery 构建必须单 chunk（file:// 内联），不走这里；
 * - 变体（Claude/Codex）本来就是 lazy chunk，不在此列；
 * - shiki 语言包/内核本来就是按需懒加载 chunk，不能拉进首屏 vendor。
 * 分组顺序 = 匹配优先级（同优先级按声明顺序），test 用 [\\/] 兼容 Windows 路径。
 */
const VENDOR_GROUPS = [
  { name: "vendor-react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
  { name: "vendor-radix", test: /node_modules[\\/](?:radix-ui|@radix-ui|@floating-ui|floating-ui)[\\/]/ },
  {
    name: "vendor-markdown",
    test: /node_modules[\\/](?:remark|remark-[a-z-]+|micromark|micromark-[a-z-]+|mdast|mdast-[a-z-]+|hast|hast-[a-z-]+|unified|react-markdown|ccount|character-entities|decode-named-character-reference|devlop|trim-lines|space-separated-tokens|comma-separated-tokens|property-information|unist|unist-[a-z-]+|vfile|vfile-[a-z-]+|bail|is-plain-obj|trough|extend|longest-streak|markdown-table|zwitch|html-url-attributes|style-to-object|inline-style-parser|estree|estree-[a-z-]+)[\\/]/,
  },
  { name: "vendor-lucide", test: /node_modules[\\/]lucide-react[\\/]/ },
  { name: "vendor-marked", test: /node_modules[\\/]marked[\\/]/ },
  // 注意：不要用 `/node_modules[\\/]/` 兜底——dynamic import 的 shiki 语法包也来自 node_modules，
  // 兜底会把它们拉进首屏（实测 vendor-misc 9.9MB）。未命中分组的小依赖继续留在入口。
]

/**
 * 画廊构建要能从 file:// 打开（L1 截图用 file://…/dist/gallery/gallery.html，实施计划 P2.4、§8.2）：
 * Chrome 在 file:// 下会按 CORS 拦掉带 crossorigin 的 module 脚本和 CSS 外链（origin 'null'）。
 * 所以 PI_GALLERY=1 时只出一个 JS chunk，内联进 gallery.html，并去掉 HTML 标签上的 crossorigin；不带它的 CSS 外链在 file:// 下能正常加载。
 * 照 replica vite.config.ts 的 inlineEntryForFile 写，只在画廊构建里启用。
 */
function inlineEntryForFile(htmlName: string): Plugin {
  return {
    name: "pi-gallery-inline-entry",
    apply: "build",
    enforce: "post",
    // order: "post"：vite 自己的 build-import-analysis 也在 generateBundle 里改写动态 import() 的预加载标记（__VITE_PRELOAD__），
    // 内联要排在它后面。排在前面时 chunk 已经内联、从 bundle 里删掉，标记原样留在 HTML 里，画廊一执行 import("shiki") 就 ReferenceError
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const chunks = Object.values(bundle).filter((f) => f.type === "chunk")
        if (chunks.length !== 1) {
          this.error(`pi-gallery-inline-entry: expected exactly 1 JS chunk, got ${chunks.length}: ${chunks.map((c) => c.fileName).join(", ")}`)
        }
        const chunk = chunks[0]
        if (chunk.type !== "chunk") return
        const html = bundle[htmlName]
        if (!html || html.type !== "asset") this.error(`pi-gallery-inline-entry: ${htmlName} not found in bundle`)
        if (html.type !== "asset") return
        let source = typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source)
        const scriptRe = new RegExp(`<script[^>]*src="[^"]*${chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*></script>`)
        if (!scriptRe.test(source)) this.error(`pi-gallery-inline-entry: <script src=${chunk.fileName}> not found in ${htmlName}`)
        // 先去掉 HTML 标签上的 crossorigin，再内联脚本：内联后的 JS 里也有 "crossorigin" 字样，不能被这条替换碰到
        source = source.replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, "")
        const code = chunk.code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")
        source = source.replace(scriptRe, () => `<script type="module">\n${code}\n</script>`)
        html.source = source
        delete bundle[chunk.fileName]
        if (chunk.sourcemapFileName) delete bundle[chunk.sourcemapFileName]
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(gallery ? [inlineEntryForFile("gallery.html")] : [])],
  // 画廊产物用相对路径，才能从 file:// 打开（命令行的 --base 仍然优先）
  ...(gallery ? { base: "./" } : {}),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: gallery ? "dist/gallery" : "../web",
    emptyOutDir: true,
    // vendor 拆分后各 vendor chunk 均 <500KB；入口仍 ~695KB（cursor 默认 UI 业务代码）；仅按需加载的 shiki 语法 chunk
    // 会超 500KB（如 emacs-lisp），属预期。阈值放到 900KB 避免这些已知噪声，同时仍能捕获异常的新增大 chunk。
    chunkSizeWarningLimit: 900,
    ...(gallery ? { modulePreload: false } : {}),
    rolldownOptions: {
      input: gallery
        ? { gallery: path.resolve(__dirname, "gallery.html") }
        : { index: path.resolve(__dirname, "index.html") },
      // 画廊：不拆 chunk，整个入口一个 JS 文件，供上面的插件内联；
      // 产品构建：vendor 拆分（见 VENDOR_GROUPS）；shiki 语言包仍是按需 lazy chunk，不受影响
      ...(gallery ? { output: { codeSplitting: false } } : { output: { advancedChunks: { groups: VENDOR_GROUPS } } }),
    },
  },
})
