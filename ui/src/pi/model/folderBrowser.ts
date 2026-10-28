/**
 * P9 C（spec §5.5）：按设备选文件夹的纯函数——浏览器的状态形状、面包屑、已知文件夹（白名单 + 最近）、搜索过滤、
 * 能不能浏览与不能时的原因、list_dirs 的错误码文案。node --test 直接加载（相对导入带 .ts 扩展名）。
 */
import { DIR_LIST_MAX, baseName, underRoots, type Device, type DirEntry, type SessionEntry } from "../../relay/devices.ts"
import { paletteMatches } from "./composerInput.ts"
import { recentFoldersOf } from "./newSession.ts"

export type { DirEntry, DirListResult } from "../../relay/devices.ts"
export { DIR_LIST_MAX }

/** 文件夹浏览器的全部界面状态（loading / error / 空 / 截断都在这里）。由组件维护，纯函数只描述形状 */
export interface FolderBrowserState {
  /** 当前目录（完整路径）；出错时保留上一个成功值，供「重试」 */
  path: string
  /** 当前目录所属的浏览根目录（attach 回的 root；刷新用） */
  root: string
  /** 上一级；在根目录时为 null */
  parent: string | null
  entries: DirEntry[]
  /** attach 只给了前 500 个 */
  truncated: boolean
  loading: boolean
  /** 已经归一过的中文原因（folderErrorText），不给 = 没出错 */
  error: string | null
  showHidden: boolean
}

/** 空状态（also used as the gallery / server-async fallback） */
export function emptyFolderBrowserState(patch: Partial<FolderBrowserState> = {}): FolderBrowserState {
  return { path: "", root: "", parent: null, entries: [], truncated: false, loading: false, error: null, showHidden: false, ...patch }
}

/** 显示用路径：反斜杠统一成 /，去掉末尾斜杠（不改大小写）。只用于显示/比较，不拿去发命令 */
function displayPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
}

/** 去重口径：分隔符与末尾斜杠不计，大小写不分（同一台设备的目录不会只在大小写上不同） */
function folderKey(value: string): string {
  return displayPath(value).toLowerCase()
}

/** 面包屑：从浏览根目录到当前目录，每一段都带完整路径，供点击跳转 */
export interface FolderCrumb {
  label: string
  path: string
}

/**
 * 生成面包屑（spec §5.5）：第一段是 `~`（浏览根目录，默认是设备用户的家目录），后面每段是目录名。
 * 路径不在根目录下时只给根目录一段（正常不会发生：list_dirs 回的 root 一定是它的祖先）。
 */
export function breadcrumbOf(path: string, root: string): FolderCrumb[] {
  const want = displayPath(path)
  const base = displayPath(root)
  if (!want) return []
  if (!base) return [{ label: baseName(want) || want, path: want }]
  const wantKey = want.toLowerCase()
  const baseKey = base.toLowerCase()
  if (wantKey !== baseKey && !wantKey.startsWith(baseKey + "/")) return [{ label: "~", path: base }]
  const crumbs: FolderCrumb[] = [{ label: "~", path: base }]
  if (wantKey === baseKey) return crumbs
  const parts = want.slice(base.length + 1).split("/").filter(Boolean)
  let current = base
  for (const part of parts) {
    current = `${current}/${part}`
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

/**
 * 二级菜单的文件夹列表（spec §5.1-3）：白名单目录（Device.projects）加上最近用过的文件夹，去重。
 * 顺序 = 白名单在前，最近用过的按更新倒序补在后面（「最近」组已经在顶层给过一遍）。
 */
export function knownFoldersOf(
  device: Pick<Device, "projects" | "browseRoots" | "platform">,
  sessions: readonly Pick<SessionEntry, "cwd" | "updatedAt">[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (path: string) => {
    const key = folderKey(path)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(path)
  }
  for (const path of device.projects || []) push(path)
  for (const path of recentFoldersOf(sessions, device, Infinity)) push(path)
  return out
}

/** 搜索过滤（D11：只在网页端过滤已知文件夹，不去设备上按名字搜）：按目录名和完整路径做包含匹配 */
export function filterFolders(query: string, list: readonly string[]): string[] {
  const q = query.trim()
  if (!q) return [...list]
  return list.filter((path) => paletteMatches(q, baseName(path), path))
}

/** 浏览功能不可用时的三种原因（spec §5.1-6 的原文） */
export const BROWSE_REASON = {
  offline: "设备未连接，连上后才能浏览文件夹",
  update: "这台设备的连接窗口（attach）需要更新",
  disabled: "这台设备没有开启文件夹浏览",
} as const

/**
 * 设备能不能浏览文件夹 + 不能时的原因（spec §5.1-6）。
 * `features` 是 P9 B 线加到 Device 上的能力表（attach 声明的 fs.browse）；本线单独存在时没有这个字段，
 * 旧版有它、新版没有的区分要等合并后才有——缺字段时按「浏览根目录为空 = 没开启浏览」降级。
 */
export type BrowseDevice = Pick<Device, "online" | "browseRoots"> & { features?: readonly string[] }

export function browseAccessOf(device: BrowseDevice | null | undefined): { canBrowse: boolean; reason: string | null } {
  if (!device) return { canBrowse: false, reason: BROWSE_REASON.offline }
  if (!device.online) return { canBrowse: false, reason: BROWSE_REASON.offline }
  const features = device.features
  if (features && !features.includes("fs.browse")) return { canBrowse: false, reason: BROWSE_REASON.update }
  if (!(device.browseRoots ?? []).length) return { canBrowse: false, reason: BROWSE_REASON.disabled }
  return { canBrowse: true, reason: null }
}

/** 浏览器打开时的起点：当前选中的文件夹在浏览根目录里就用它，否则交给 attach 用第一个根目录（默认家目录） */
export function initialBrowsePathOf(device: Pick<Device, "browseRoots" | "platform">, folder: string | null | undefined): string | null {
  const target = typeof folder === "string" ? folder.trim() : ""
  if (!target) return null
  return underRoots(device.browseRoots, target, device.platform) ? target : null
}

/** list_dirs 的协议错误码 → 中文（spec §5.2 的文案表）；未知码用设备/relay 带回的话，再没有就是兜底 */
const FOLDER_ERROR: Record<string, string> = {
  fs_outside_root: "不在允许浏览的范围内",
  fs_not_found: "文件夹不存在",
  fs_not_dir: "这不是文件夹",
  fs_denied: "没有权限读取这个文件夹",
  browse_disabled: "这台设备没有开启文件夹浏览",
  device_update_required: "这台设备的连接窗口（attach）需要更新",
  device_offline: "设备未连接，连上后才能浏览文件夹",
}

export function folderErrorText(code?: string | null, message?: string | null): string {
  const known = code ? FOLDER_ERROR[code] : ""
  return known || (message && message.trim()) || "读取文件夹失败"
}

/** 中间截断（浏览器底部的当前路径）：超长时保留头尾、中间换成 …，让最末一段目录名始终可见 */
export function middleEllipsis(text: string, max = 56): string {
  const s = String(text || "")
  if (max < 7 || s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.55)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}
