/**
 * 扩展 provider 运行时注册表（P4.1）：注册 / 注销 / 解析能力、订阅变化、给 UI 能力视图。
 *
 * - **生产默认无 provider**：注册表初始为空 → 所有能力 `unavailable`（禁用态）；只有未来扩展 / dev mock 调用
 *   `registerPiUiExtension()` 才变 `available` / `simulated`。
 * - 纯逻辑（无 React / 无 relay / 无协议依赖）：node --test 可直接加载（test/pi-ui-extensions.test.mjs）；
 *   React 侧消费见 `./usePiUiCapabilities.ts`。
 * - 同一 provider id 重复注册 = 覆盖（热更新 / mock 重装场景）；多 provider 提供同一能力时**最后注册者优先**。
 */
import { piUiCapabilityMetaOf } from "./capabilities.ts"
import { piUiDisabledStateOf, type PiUiDisabledStateView } from "./disabled.ts"
import type {
  PiUiCapability,
  PiUiCapabilityActions,
  PiUiCapabilityBinding,
  PiUiCapabilityData,
  PiUiCapabilityMeta,
  PiUiCapabilityProvider,
  PiUiCapabilityStatus,
  PiUiExtensionEvent,
  PiUiExtensionProvider,
} from "./types.ts"
import { PI_UI_CAPABILITY_IDS } from "./types.ts"

/** 注册表快照（version 每次变化 +1；对象只在变化时替换，供 useSyncExternalStore 用） */
export interface PiUiExtensionSnapshot {
  version: number
  providers: readonly PiUiExtensionProvider[]
}

const registry = new Map<string, PiUiExtensionProvider>()
let snapshot: PiUiExtensionSnapshot = { version: 0, providers: [] }
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = { version: snapshot.version + 1, providers: [...registry.values()] }
  for (const listener of [...listeners]) listener()
}

/** 注册/校验错误（message 汇总问题；problems 给测试与调用方） */
export class PiUiExtensionError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`无效的 Pi UI 扩展 provider：${problems.join("; ")}`)
    this.name = "PiUiExtensionError"
    this.problems = problems
  }
}

/** 纯函数校验：provider 形状/能力 id/getData 等；返回问题清单（空 = 合法） */
export function piUiExtensionProblems(provider: unknown): string[] {
  if (!provider || typeof provider !== "object") return ["provider 必须是对象"]
  const p = provider as Partial<PiUiExtensionProvider>
  const problems: string[] = []
  if (typeof p.id !== "string" || !p.id.trim()) problems.push("缺 provider.id（非空字符串）")
  if (p.capabilities == null || typeof p.capabilities !== "object" || Array.isArray(p.capabilities)) {
    problems.push("缺 provider.capabilities 对象")
    return problems
  }
  const entries = Object.entries(p.capabilities)
  if (entries.length === 0) problems.push("provider.capabilities 为空")
  for (const [capabilityId, capability] of entries) {
    if (!(PI_UI_CAPABILITY_IDS as readonly string[]).includes(capabilityId)) {
      problems.push(`未知能力 id：${capabilityId}`)
      continue
    }
    if (!capability || typeof capability !== "object") {
      problems.push(`${capabilityId}：能力实现必须是对象`)
      continue
    }
    const impl = capability as Partial<PiUiCapabilityProvider>
    if (typeof impl.getData !== "function") problems.push(`${capabilityId}：缺 getData()`)
    if (impl.mode != null && impl.mode !== "available" && impl.mode !== "simulated") problems.push(`${capabilityId}：mode 只能是 available / simulated`)
    for (const fn of ["subscribe", "getActions", "onEvent"] as const) {
      if (impl[fn] != null && typeof impl[fn] !== "function") problems.push(`${capabilityId}：${fn} 必须是函数`)
    }
  }
  return problems
}

/** 注册（或覆盖同 id）扩展 provider；非法直接抛 PiUiExtensionError */
export function registerPiUiExtension(provider: PiUiExtensionProvider): void {
  const problems = piUiExtensionProblems(provider)
  if (problems.length) throw new PiUiExtensionError(problems)
  registry.delete(provider.id)
  registry.set(provider.id, provider)
  publish()
}

/** 注销；返回是否真的删掉了 */
export function unregisterPiUiExtension(id: string): boolean {
  const removed = registry.delete(id)
  if (removed) publish()
  return removed
}

/** 清空注册表（测试 / 退出 dev mock 用） */
export function resetPiUiExtensions(): void {
  if (registry.size === 0 && snapshot.version === 0) return
  registry.clear()
  snapshot = { version: snapshot.version + 1, providers: [] }
  for (const listener of [...listeners]) listener()
}

/** 当前快照（useSyncExternalStore 的 getSnapshot；引用只在变化时换） */
export function piUiExtensionSnapshot(): PiUiExtensionSnapshot {
  return snapshot
}

/** 订阅注册表变化（register / unregister / reset）；返回取消订阅 */
export function subscribePiUiExtensions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前全部 provider（按注册顺序，后来者优先解析） */
export function piUiExtensionProviders(): readonly PiUiExtensionProvider[] {
  return snapshot.providers
}

const noopUnsubscribe = () => () => {}

/** 解析某能力的绑定（最后注册的 provider 优先）；没有 = null（禁用态） */
export function piUiExtensionBindingOf<K extends PiUiCapability>(capability: K, providers: readonly PiUiExtensionProvider[] = snapshot.providers): PiUiCapabilityBinding<K> | null {
  for (let i = providers.length - 1; i >= 0; i -= 1) {
    const provider = providers[i]
    const impl = provider.capabilities[capability] as PiUiCapabilityProvider<K> | undefined
    if (!impl) continue
    return {
      capability,
      providerId: provider.id,
      status: impl.mode === "simulated" ? "simulated" : "available",
      data: impl.getData(),
      actions: impl.getActions?.() ?? null,
      subscribe: impl.subscribe ?? noopUnsubscribe,
      onEvent: impl.onEvent ?? noopUnsubscribe,
    }
  }
  return null
}

/** 能力状态解析（binding 有 = available/simulated；无 = unavailable 默认态） */
export function piUiCapabilityStatusOf(capability: PiUiCapability, providers: readonly PiUiExtensionProvider[] = snapshot.providers): PiUiCapabilityStatus {
  return piUiExtensionBindingOf(capability, providers)?.status ?? piUiCapabilityMetaOf(capability).defaultStatus
}

/** 给变体的能力视图（hook 与纯逻辑测试共用；数据/动作/禁用态都从这里取） */
export interface PiUiCapabilities {
  /** 注册表版本（变化 = 注册/注销过 provider） */
  readonly version: number
  readonly providers: readonly PiUiExtensionProvider[]
  /** 能力状态：available / simulated / unavailable */
  statusOf(capability: PiUiCapability): PiUiCapabilityStatus
  /** 能力绑定（provider 数据 + 动作 + 订阅）；未提供 = null */
  bindingOf<K extends PiUiCapability>(capability: K): PiUiCapabilityBinding<K> | null
  /** provider 数据快照；未提供 = undefined */
  dataOf<K extends PiUiCapability>(capability: K): PiUiCapabilityData<K> | undefined
  /** provider 动作回调；未提供 / 无动作 = null */
  actionsOf<K extends PiUiCapability>(capability: K): PiUiCapabilityActions<K> | null
  /** 禁用态 / 模拟态契约；available = null（两变体据此渲染统一禁用态） */
  disabledOf(capability: PiUiCapability): PiUiDisabledStateView | null
  /** 全部能力 + 状态（设置页扩展区 / 文档 / 验收矩阵用） */
  list(): { capability: PiUiCapability; meta: PiUiCapabilityMeta; status: PiUiCapabilityStatus }[]
}

/** 纯函数：从 provider 列表构造能力视图（生产 = 空列表 → 全 unavailable） */
export function piUiCapabilitiesOf(providers: readonly PiUiExtensionProvider[] = snapshot.providers, version = snapshot.version): PiUiCapabilities {
  const bindingOf = <K extends PiUiCapability>(capability: K) => piUiExtensionBindingOf(capability, providers)
  const statusOf = (capability: PiUiCapability): PiUiCapabilityStatus => bindingOf(capability)?.status ?? piUiCapabilityMetaOf(capability).defaultStatus
  return {
    version,
    providers,
    statusOf,
    bindingOf,
    dataOf: <K extends PiUiCapability>(capability: K) => bindingOf(capability)?.data,
    actionsOf: <K extends PiUiCapability>(capability: K) => bindingOf(capability)?.actions ?? null,
    disabledOf: (capability) => piUiDisabledStateOf(capability, statusOf(capability)),
    list: () => PI_UI_CAPABILITY_IDS.map((capability) => ({ capability, meta: piUiCapabilityMetaOf(capability), status: statusOf(capability) })),
  }
}

/** 当前能力视图（非 hook 场景 / 测试用；React 组件请用 usePiUiCapabilities） */
export function piUiCapabilities(): PiUiCapabilities {
  return piUiCapabilitiesOf(snapshot.providers, snapshot.version)
}

export type { PiUiExtensionEvent }
