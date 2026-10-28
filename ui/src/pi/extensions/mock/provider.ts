/**
 * dev mock provider 工厂（P4.1/P4.2）：把有状态 store 包装成 `PiUiExtensionProvider`（mode = simulated）。
 *
 * 口径（P4.2 M1）：
 * - 只注入 `PI_UI_CAPABILITY_PROVIDER_IDS`（31 项 provider-backed）；9 项 contract-only（builtin）**永不注入**（硬规则 2）。
 * - provider id 稳定为 `pi-ui-mock`；install/uninstall 由 `./index.ts` 管，动作/订阅/事件由 `./store.ts` 提供。
 * - `createPiUiMockProvider` 保持 P4.1 的公开签名（`install` / 测试沿用），返回 `capabilities` 为有状态实现。
 */
import { PI_UI_CAPABILITY_PROVIDER_IDS } from "../capabilities.ts"
import type { PiUiCapability, PiUiExtensionProvider } from "../types.ts"
import { PI_UI_DEMO_FIXTURES } from "./fixtures.ts"
import type { PiUiMockOptions } from "./options.ts"
import { createPiUiDemoStore, type PiUiDemoStore } from "./store.ts"

export const PI_UI_DEMO_PROVIDER_ID = "pi-ui-mock"
export const PI_UI_DEMO_PROVIDER_NAME = "Pi 数据模拟（开发演示）"

/** 当前已安装的演示 store（e2e / 调试可读状态与事件；未安装 = null） */
let activeStore: PiUiDemoStore | null = null

/** 取当前 mock store（未安装 = null） */
export function piUiDemoStore(): PiUiDemoStore | null {
  return activeStore
}

/** 清掉 store 引用（uninstall / 测试清理） */
export function clearPiUiDemoStore(): void {
  activeStore = null
}

/** 把请求的能力列表过滤成 provider-backed 子集（contract-only / 未知 id 直接丢，避免冒充注入） */
export function piUiMockProviderCaps(options: PiUiMockOptions): PiUiCapability[] {
  return options.caps.filter((capability) => (PI_UI_CAPABILITY_PROVIDER_IDS as readonly string[]).includes(capability))
}

/**
 * 造一个有状态 mock provider：只提供 options.caps 里**且 provider-backed** 的能力；mode = simulated。
 * @param store 可注入现成 store（测试 / P4 harness 复用同一份状态）；缺省按过滤后的 caps 新建。
 */
export function createPiUiMockProvider(options: PiUiMockOptions, store?: PiUiDemoStore): PiUiExtensionProvider {
  const caps = piUiMockProviderCaps(options)
  const demoStore = store ?? createPiUiDemoStore(caps)
  activeStore = demoStore
  return {
    id: PI_UI_DEMO_PROVIDER_ID,
    name: PI_UI_DEMO_PROVIDER_NAME,
    capabilities: demoStore.capabilities as PiUiExtensionProvider["capabilities"],
  }
}

/** mock 是否覆盖某项能力（provider-backed 且有 fixture；测试 / 调试用） */
export function piUiMockProvides(options: PiUiMockOptions, capability: PiUiCapability): boolean {
  return piUiMockProviderCaps(options).includes(capability) && PI_UI_DEMO_FIXTURES[capability] != null
}
