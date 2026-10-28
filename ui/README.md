# ui：Pi-Remote 网页端

React 19 + TypeScript + Vite 8 + Tailwind CSS 4。构建产物写到仓库根的 `web/`，由 relay 在 7002 端口同口托管（见根 README）。
界面的设计依据是 Cursor 3 Agents Window 的复刻（`--cw-*` 令牌）加 Pi-Remote 自己的部件（`--cw-pi-*`）。

## 入口

| 文件 | 内容 | 进不进生产包 |
|---|---|---|
| `index.html` | 产品界面，模块脚本是 `/src/pi/main.tsx`。首帧脚本同步读主题偏好（`localStorage["pi_remote_pi_prefs"].theme`，没有时取旧键 `pi-remote.theme`，再没有就跟随系统），先写好 `<html data-pi-theme>`，避免浅色、深色闪一下 | 进，`npm run build` → `../web/` |
| `gallery.html` | 开发画廊，脚本是 `/src/pi/dev/main.tsx` | 不进。只在 `PI_GALLERY=1` 时单独构建 |

- `vite.config.ts` 的生产构建入口只有 `index.html`。relay 对没有扩展名的路径回退到 `index.html`，所以旧地址 `/m`、`/b` 打开的也是这套界面。
- `src/pi/main.tsx` 按这个顺序引样式：`styles/tokens.local.css` → `styles/tokens.css` → `styles/index.css`，然后挂 `PiApp`。
- `PiApp` 按宽度选布局：≥ 1024 是桌面（`containers/DesktopApp.tsx`），否则是手机（`containers/PhoneApp.tsx`）。平板（≥ 768）用手机布局，对话列限宽居中。
- relay 地址：构建时的 `VITE_RELAY_URL` 优先；没有就连页面同源的 ws / wss；不是 http(s) 页面时用 `ws://127.0.0.1:7002`（`src/relay/useRelay.ts` 的 `wsUrl`）。dev server 和 relay 不同源，所以开发时连本机 relay 要设 `VITE_RELAY_URL=ws://127.0.0.1:7002`。

## 目录

```
ui/
├─ index.html  gallery.html  vite.config.ts  tsconfig*.json
├─ public/                         favicon、pi 标记图标
└─ src/
   ├─ pi/                          新界面
   │  ├─ main.tsx  PiApp.tsx       产品入口
   │  ├─ containers/               容器：接 useRelay，把数据和动作交给部件（DesktopApp、PhoneApp、TranscriptContainer、ComposerContainer、DialogsContainer…）
   │  ├─ model/                    纯函数（不依赖 React / DOM，node --test 直接加载）：transcriptView、composerView、outbox、slashMenu、changesView…
   │  ├─ hooks/                    usePiDevice（布局、键盘、安全区）、usePiUiState、usePiShortcuts、useNow…
   │  ├─ styles/                   令牌与 Tailwind 入口（见「令牌」）
   │  └─ dev/                      开发画廊，只给 gallery.html 用，产品代码不许 import（test/pi-structure.test.mjs 检查）
   │     ├─ main.tsx  PiStage.tsx  registry.ts  stage.ts   画廊路由、舞台、屏幕注册
   │     ├─ screens/{a,b,c,_stress}/   设计屏（一个文件一屏），下划线开头的是开发屏
   │     ├─ play/                  #/play 可交互版的起始状态
   │     ├─ LiveRoute.tsx  fakeRelay.ts  fixtures/live/  live/   #/live：真实容器 + 假 relay
   │     └─ fixtures/gallery/  frames/                    画廊用的 mock 数据和背景框架
   ├─ components/
   │  ├─ pi/                       Pi 部件（只收 props，不碰 relay）
   │  │  ├─ shared/                PiRoot（主题 / 布局根节点）、PiShell、PiSidebar、PiTopBar、PiOverlay（对话框 / sheet / 菜单）、按钮与控件、pi-theme.css
   │  │  ├─ shell/                 外壳与列表：登录、配对、无设备、会话菜单、重命名 / 删除、搜索结果、会话信息卡
   │  │  ├─ conversation/          对话流与右侧 pane：PiTranscript、审批卡、代码块、diff、终端 / 改动 / 文件 pane、任务面板、灯箱
   │  │  └─ composer/              输入区、菜单、弹窗、设置：PiComposerDock、斜杠 / @ / 模型菜单、命令面板、排队、各类弹窗、设置页
   │  ├─ kit/                      从复刻搬来的基础组件（chrome、composer、controls、diff、menu、sidebar、stream、icons）
   │  └─ ui/                       只剩 streaming-markdown-core.ts（流式 markdown 的纯逻辑）
   ├─ relay/                       WebSocket 客户端 useRelay、同步规则、命令通道、设备名册、注意力、草稿
   ├─ chat/  shell/  mobile/  conversation/   旧界面留下的纯逻辑和 hook，新界面直接 import（见下）
   └─ lib/                         小工具（cn 等）
```

- 画廊的区域代号 a / b / c 分别对应 `components/pi/shell`、`conversation`、`composer`。屏幕 id（例如 `a/login`）也是截图文件名，所以画廊这边保留了代号。
- 部件不读 relay，也不读存储。数据从容器经 props 传进来；交互态的开关走 `PiStaticProvider`（画廊静态）和 `PiLayerProvider`（浮层登记、Esc 分层）。
- 旧界面的组件、样式和页面在切换时删掉了。`chat/`、`shell/`、`mobile/`、`conversation/` 里留下的是新界面还在用的纯逻辑和 hook，例如 `chat/composerMachine.ts`（发送锁）、`chat/slashCommands.ts`、`chat/composer/faviconBadge.ts`（完成角标）、`chat/composer/sound.ts`、`shell/breakpoints.ts`（1024 断点）、`mobile/useMobileViewport.ts`（键盘与可视视口）、`conversation/remoteImage.ts`。另有 6 份模型文件（`chat/{entryCopy,optionsKey,thinkingLevels,usageLine}.ts`、`conversation/{attachmentModel,diffModel}.ts`）现在没有界面引用，按实施计划的保留表留着，待以后清理。

## 令牌

| 文件 | 来源 | 规则 |
|---|---|---|
| `src/pi/styles/tokens.css` | 复刻的官方令牌，浅色 `:root`，由复刻工程的 `tokens/work/gen.py` 生成 | 原样复制，不手改。已发布的名字不改，只加新的 |
| `src/pi/styles/tokens.local.css` | kit 级补充令牌（官方里没有、kit 需要的） | 先于 tokens.css 引入，官方以后补上同名变量时自动覆盖 |
| `src/pi/styles/theme.css` | `--cw-*` → Tailwind 4 主题的映射，由复刻工程的 `scripts/gen-theme.mjs` 生成 | 不手改。写法：`bg-cw-surface`、`text-cw-md`、`rounded-cw-card`，或者直接 `bg-(--cw-surface)` |
| `src/pi/styles/index.css` | Tailwind 入口，依次引 `theme.css`、`base.css`（基础样式，也是从复刻原样复制） | `source(none)`，只扫 `components/kit`、`components/pi`、`src/pi` 三处 |
| `src/components/pi/shared/pi-theme.css` | Pi 自己的 `--cw-pi-*` 变量，加深色和手机布局下对 `--cw-*` 的重设 | 由 PiRoot import |

- 作用域：PiRoot 的根节点 `[data-pi-root]`，以及镜像到 `<html>` 上的 `data-pi-theme`、`data-pi-layout`（portal 出去的菜单也跟着变）。
- 明暗只看 `[data-pi-theme="light"|"dark"]`。手机布局只看 `[data-pi-layout="phone"]`。
- 布局类型是 `PiLayout = "desktop" | "phone"`（`components/pi/shared/viewport.ts`），部件的 `viewport` prop 收的就是它。画廊舞台的像素尺寸是另一个类型 `PiStageSize = "1440x900" | "390x844"`，只在画廊路由的 `vp=` 参数和舞台尺寸里用，换算只有 `piLayoutOf` 一处。
- 部件里不写字面色值，一律用变量。test/pi-structure.test.mjs 有白名单，只许减少。
- 层级只用 `--cw-pi-z-*` 五档：raised 10、popover 30、sheet 40、modal 50、chrome 60。卡内的局部层叠要在 test/pi-p4-base.test.mjs 的 ALLOW 里登记。
- 产品目录不许出现 `--cw-ch5-*`（复刻里章节帧专用的变量）。
- 深色整套和手机字号是推断值，验收看结构和对比度（test/design-tokens.test.mjs 末尾的对比度块）。

## 开发画廊

开发时：`npm run dev`，然后打开 `http://localhost:<端口>/gallery.html`。

| 路由 | 内容 |
|---|---|
| `#/pi` | 索引：按区域列出每屏、每个视口和主题的链接，开发屏标「开发屏」 |
| `#/pi/<id>?vp=1440x900\|390x844&theme=light\|dark` | 一个设计屏。舞台贴在左上角 (0,0)，尺寸正好是该视口；静态，L1 截的就是它 |
| `#/play/<id>?vp=…&theme=…` | 同一批部件的可交互版（Radix、焦点、Esc 分层），不参加对图。`#/play/overlays` 是浮层原语自测页 |
| `#/live/<id>?vp=…&theme=…[&interactive]` | 真实容器树 + 假 relay（`fixtures/live/<id>.ts`），和 PiApp 走同一个分支，L2 截的就是它。带 `interactive` 时可交互 |
| `vp=device`（`#/play`、`#/live`） | 设备模式：不画固定舞台，PiRoot 走产品模式铺满窗口，给 Chrome 设备模拟用 |

- 加一屏：在 `src/pi/dev/screens/<a|b|c>/<id>.tsx` 里 `export const piScreen: PiScreenMeta = { id, area, title, themes?, keyboard?, states?, notes? }`，默认导出组件收 `{ viewport, theme }`（`viewport` 是布局 `"desktop" | "phone"`）。`id` 必须等于文件名。registry 用 `import.meta.glob("./screens/**/*.tsx")` 自动注册。
- 截图脚本从 `window.__PI_GALLERY__` 读屏幕清单。舞台就绪的标志是 `[data-pi-stage="<id>"][data-pi-ready]`。
- 构建成能从 `file://` 直接打开的单文件（JS 内联进 gallery.html）：
  ```bash
  PI_GALLERY=1 npx vite build --base ./ --outDir dist/gallery --emptyOutDir
  open dist/gallery/gallery.html        # 或 file://…/ui/dist/gallery/gallery.html#/pi
  ```

## 视觉回归

视觉基准与截图对比工具不随本公开仓提供；需要时可用 Playwright 对 `gallery.html` 自建截图回归。

## 常用命令

```bash
cd ui
npm run dev -- --port 5173 --strictPort         # dev server；产品页 /，画廊 /gallery.html#/pi
VITE_RELAY_URL=ws://127.0.0.1:7002 npm run dev  # 连本机 relay（根目录 npm run relay）
npx tsc -b                                       # 类型检查（tsconfig.app.json 已 noEmit）
npm run lint                                     # oxlint，要求 0 error
npm run build                                    # tsc -b + vite build → ../web/（relay 正在托管的目录）
npm run build -- --outDir dist/build-check --emptyOutDir                    # 只检查能否构建，不碰 ../web/
PI_GALLERY=1 npx vite build --base ./ --outDir dist/gallery --emptyOutDir   # 画廊单文件构建
cd .. && npm test                                # 全部单元 / 协议 / 源码结构测试（含 test/pi-*.test.mjs）
```

- 依赖装在 ui/ 自己的 node_modules（`npm ci`）。根目录的 `npm ci` 只装 relay 和测试用的三个包。
- 测试直接加载 `ui/src` 里的 `.ts`，靠 Node 内置的类型剥离，需要 Node ≥ 22.18。
- 新测试文件要加进根 package.json 的 `scripts.test`。
