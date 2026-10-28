/** dev mock 开关解析（P4.1）：URL `?caps=` 与 localStorage dev flag；纯函数，node 可测。 */
import type { PiUiCapability } from "../types.ts"
import { PI_UI_CAPABILITY_IDS } from "../types.ts"

/** localStorage dev flag 键：值 "1" 或能力列表（如 "artifacts,browser-pane" / "all"） */
export const PI_UI_DEMO_FLAG_KEY = "pi_dev_ui_mock_caps"

export interface PiUiMockOptions {
  caps: PiUiCapability[]
  mode: "simulated"
  source: "url" | "storage"
}

export interface PiUiMockStorageLike {
  getItem(key: string): string | null
}

const isCapability = (value: string): value is PiUiCapability => (PI_UI_CAPABILITY_IDS as readonly string[]).includes(value)

/** 解析能力列表字符串："all" = 全部；逗号分隔；非法 id 忽略；空结果 = null（未请求 mock） */
export function parsePiUiMockCaps(raw: string | null | undefined): PiUiCapability[] | null {
  if (raw == null) return null
  const text = raw.trim()
  if (!text) return null
  if (text === "all" || text === "*") return [...PI_UI_CAPABILITY_IDS]
  const caps = [...new Set(text.split(",").map((part) => part.trim()).filter(Boolean))]
  const valid = caps.filter(isCapability)
  return valid.length ? valid : null
}

/** `?caps=all|artifacts,browser-pane` → mock 选项；未带参数 = null */
export function piUiMockOptionsFromSearch(search: string): PiUiMockOptions | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`)
  const caps = parsePiUiMockCaps(params.get("caps"))
  return caps ? { caps, mode: "simulated", source: "url" } : null
}

/** localStorage dev flag（键 PI_UI_DEMO_FLAG_KEY）→ mock 选项；没有 = null */
export function piUiMockOptionsFromStorage(storage: PiUiMockStorageLike | null | undefined): PiUiMockOptions | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(PI_UI_DEMO_FLAG_KEY)
  } catch {
    return null
  }
  const caps = parsePiUiMockCaps(raw)
  return caps ? { caps, mode: "simulated", source: "storage" } : null
}

/** 汇总：URL 优先，其次 localStorage（gallery `?caps=` / 开发时手动置 flag 都可） */
export function resolvePiUiMockOptions(input: { search?: string; storage?: PiUiMockStorageLike | null }): PiUiMockOptions | null {
  return piUiMockOptionsFromSearch(input.search ?? "") ?? piUiMockOptionsFromStorage(input.storage)
}
