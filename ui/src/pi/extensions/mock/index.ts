/**
 * dev-only mock 注入入口（P4.1/P4.2；**不进生产包**）。
 *
 * 生产默认不注入任何 provider → extension 能力 unavailable（禁用态）；开发 / 画廊 / e2e 需要完整 UI 时：
 * ```ts
 * // 画廊 dev 入口（gallery 入口文件或 P4 harness）显式调用；生产入口 main.tsx 不 import 本模块：
 * installPiUiExtensionMock({ caps: parsePiUiMockCaps("all")!, mode: "simulated", source: "url" })
 * // 或按开关自动注入（DEV / force 旁路，静态 PI_GALLERY build 用 force:true）：
 * installPiUiExtensionMockIfRequested({ force: true })
 * ```
 * 开关（二选一，URL 优先）：
 *   - URL / 画廊：`?caps=all` 或 `?caps=artifacts,browser-pane`（P4 harness 还支持 hash 内 `&caps=`）；
 *   - localStorage dev flag：`pi_dev_ui_mock_caps = "all" | "artifacts,browser-pane" | "1"`（"1" = all）。
 * mock 数据固定（`./fixtures.ts`，PI_UI_DEMO_NOW），能力状态为 `simulated`，UI 显示「模拟演示」标识。
 *
 * P4.2 M1：注入的是**有状态 store**（`./store.ts`）：动作改内存态 + 订阅通知 + 事件流；只注入 31 项 provider-backed，
 * 9 项 contract-only（builtin）绝不注入（硬规则 2）。可读 `piUiDemoStore()` 做 e2e 断言 / 画廊驱动。
 */
import { registerPiUiExtension, unregisterPiUiExtension } from "../registry.ts"
import { resolvePiUiMockOptions, type PiUiMockOptions, type PiUiMockStorageLike } from "./options.ts"
import { createPiUiMockProvider, piUiMockProviderCaps, PI_UI_DEMO_PROVIDER_ID, clearPiUiDemoStore } from "./provider.ts"

export { PI_UI_DEMO_PROVIDER_ID, PI_UI_DEMO_PROVIDER_NAME, createPiUiMockProvider, piUiDemoStore, piUiMockProviderCaps, piUiMockProvides } from "./provider.ts"
export { PI_UI_DEMO_FLAG_KEY } from "./options.ts"
export { PI_UI_DEMO_CONTRACT_FIXTURES, PI_UI_DEMO_FIXTURES, PI_UI_DEMO_PROVIDER_FIXTURES, PI_UI_DEMO_SENTINELS, piUiDemoFixtureClone, piUiMockFixtureOf } from "./fixtures.ts"
export { createPiUiDemoStore, PI_UI_DEMO_ACTION_SAMPLES, PI_UI_DEMO_PROVIDER_CAPABILITIES } from "./store.ts"
export type { PiUiDemoStore } from "./store.ts"
export { parsePiUiMockCaps, piUiMockOptionsFromSearch, piUiMockOptionsFromStorage, resolvePiUiMockOptions } from "./options.ts"
export type { PiUiMockOptions, PiUiMockStorageLike } from "./options.ts"

/**
 * 装上 mock provider（覆盖/替换已注册的 mock；不动真实扩展 provider）。
 * 只注入 provider-backed 子集；若请求里没有任何 provider-backed 能力（例如只请求 builtin），不注册空 provider（避免抛错）。
 * @returns 是否真的安装了 provider
 */
export function installPiUiExtensionMock(options: PiUiMockOptions): boolean {
  unregisterPiUiExtension(PI_UI_DEMO_PROVIDER_ID)
  clearPiUiDemoStore()
  if (piUiMockProviderCaps(options).length === 0) return false
  registerPiUiExtension(createPiUiMockProvider(options))
  return true
}

/** 卸掉 mock（恢复生产禁用态；真实 provider 不受影响） */
export function uninstallPiUiExtensionMock(): boolean {
  clearPiUiDemoStore()
  return unregisterPiUiExtension(PI_UI_DEMO_PROVIDER_ID)
}

function safeLocalStorage(): PiUiMockStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/** 自动注入参数：force = 绕过 import.meta.env.DEV（PI_GALLERY 静态 build / mock 线与验证线显式调用时用） */
export interface PiUiMockInstallHooks {
  force?: boolean
  /** 覆盖 location.search（测试 / 非浏览器环境） */
  search?: string
  /** 覆盖 localStorage（测试） */
  storage?: PiUiMockStorageLike | null
}

/**
 * 按开关自动注入：默认只在 DEV 下生效（Vite 生产构建会把该函数里 DEV 分支摇掉）；
 * PI_GALLERY 静态 build / 画廊 / e2e 需要时显式传 `{ force: true }`（或直接调 `installPiUiExtensionMock(options)`），
 * 二者都从 dev/gallery 入口显式调用，生产 `main.tsx` 不会 import 本模块 → 生产包仍无 mock。
 * 返回是否安装成功（测试 / 调试可断言）。
 */
export function installPiUiExtensionMockIfRequested(hooks: PiUiMockInstallHooks = {}): boolean {
  const dev = import.meta.env?.DEV === true
  if (!dev && !hooks.force) return false
  const options = resolvePiUiMockOptions({
    search: hooks.search ?? (typeof window === "undefined" ? "" : window.location.search),
    storage: hooks.storage !== undefined ? hooks.storage : safeLocalStorage(),
  })
  if (!options) return false
  return installPiUiExtensionMock(options)
}
