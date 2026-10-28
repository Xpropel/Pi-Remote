/**
 * 设置 › 关于 · 诊断导出与版本检查（纯函数；无 React / 无 DOM，node --test 可直载）。
 *
 * 边界：
 *   - 诊断文件只组长名单里的字段：应用 / 中继 / 设备 / 主机诊断；绝不带 viewer token、
 *     admin token、设备令牌、设备项目路径 / 浏览根目录或会话正文；
 *   - host diag 先走 normalizeHostDiag（与主机诊断弹窗同一口径，日志 / 错误已脱敏），
 *     整份 JSON 再走一次 redactSecrets；
 *   - 检查更新走 GitHub Releases 列表 API（api.github.com 支持 CORS）：仓库没有 Release 时
 *     列表返回 200 + []，不会像 releases/latest 那样以 404 制造一条预期内的浏览器网络错误；
 *     CSP / 网络 / timeout / 404 都转成一句可读说明，不假装「已是最新」。
 */
import { normalizeHostDiag, redactSecrets, type HostDiag } from "../../model/hostDiag.ts"
import type { Device } from "../../../relay/devices.ts"

/**
 * 仓库的 Releases 列表 API（按创建时间倒序）。
 * 用列表而不是 `releases/latest`：后者在「还没有任何 Release」时返回 404，浏览器
 * 必然在 console 打一条 network error（JS 无法屏蔽）；列表在同样场景返回 200 + []。
 * per_page 取 10：足够跳过预发布 / 草稿找到第一个正式版，也避免拉全量。
 */
export const GITHUB_RELEASES_API =
  "https://api.github.com/repos/your-org/Pi-Remote/releases?per_page=10"

export type UpdateCheckStatus = "newer" | "latest" | "none" | "error"

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  /** 一行直接放进「检查更新」行 / 通知的说明。 */
  text: string
  /** GitHub 上的版本号（去掉 v 前缀）；没有就是 null。 */
  version: string | null
}

/* ------------------------------------------------------------------ */
/* 版本比较                                                            */
/* ------------------------------------------------------------------ */

/** 解析 x.y.z（可带 v 前缀与 -pre/+build 后缀）；不合法返回 null。 */
export function versionPartsOf(value: string | null | undefined): [number, number, number] | null {
  if (typeof value !== "string") return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/i.exec(value.trim())
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number]
  return parts.every((part) => Number.isFinite(part) && part >= 0) ? parts : null
}

/** semver 主版本比较；任一方不合法返回 null（页面据此显示「版本号无法识别」）。 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = versionPartsOf(left)
  const b = versionPartsOf(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1
    if (a[index] < b[index]) return -1
  }
  return 0
}

/* ------------------------------------------------------------------ */
/* 检查更新                                                            */
/* ------------------------------------------------------------------ */

interface ReleasePayload {
  tag_name?: unknown
  name?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
}

function isRelease(value: unknown): value is ReleasePayload {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 列表 → 正式发布（跳过草稿 / 预发布）；坏结构按空列表处理，不抛。 */
function publishedReleasesOf(payload: unknown): ReleasePayload[] {
  if (!Array.isArray(payload)) return []
  return payload.filter((item) => isRelease(item) && item.draft !== true && item.prerelease !== true)
}

function tagOf(payload: ReleasePayload): string {
  const tag = typeof payload.tag_name === "string" ? payload.tag_name.trim() : ""
  if (tag) return tag
  const name = typeof payload.name === "string" ? payload.name.trim() : ""
  // 有些仓库的 release name 写成「Pi-Remote v4.1.0」；只从里面抓一个像版本号的 token。
  const match = /v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/i.exec(name)
  return match ? match[0] : ""
}

export interface UpdateCheckOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 请求 GitHub Releases 列表，取第一个正式发布并与当前版本比较。
 * 不依赖 DOM；测试可注入 fetchImpl。失败一律 status=error，不把网络错误误报成「已是最新」。
 * 没有任何正式发布时 status=none（列表 200 + []），不会制造 /releases/latest 的 404。
 */
export async function checkLatestRelease(
  currentVersion: string,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  const fetchImpl =
    options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : null)
  if (!fetchImpl) {
    return { status: "error", text: "当前环境不支持检查更新（没有 fetch）", version: null }
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs ?? 0) : 8000
  const controller = typeof AbortController === "function" ? new AbortController() : null
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null
  try {
    const response = await fetchImpl(GITHUB_RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller?.signal,
    })
    if (response.status === 404) {
      // 私有 / 改名 / 删除的仓库匿名访问也是 404，不能据此断言「没有发布版本」。
      return {
        status: "error",
        text: "检查更新失败（读不到 GitHub 发布信息；仓库可能未公开，或还没有 Release）",
        version: null,
      }
    }
    if (!response.ok) {
      return { status: "error", text: `检查更新失败（GitHub 返回 ${response.status}）`, version: null }
    }
    const payload = (await response.json()) as unknown
    if (!Array.isArray(payload)) {
      return { status: "error", text: "检查更新失败（GitHub 发布列表格式无法识别）", version: null }
    }
    const release = publishedReleasesOf(payload)[0]
    if (!release) return { status: "none", text: "GitHub 上还没有发布版本", version: null }
    const tag = tagOf(release)
    if (!tag) return { status: "error", text: "检查更新失败（发布版本号无法识别）", version: null }
    const latest = tag.replace(/^v/i, "")
    const compared = compareVersions(latest, currentVersion)
    if (compared === null) {
      return { status: "error", text: `检查更新失败（版本号无法比较：${tag}）`, version: latest }
    }
    if (compared > 0) return { status: "newer", text: `发现新版本 ${tag}（当前 ${currentVersion}）`, version: latest }
    return { status: "latest", text: `已是最新版本（${currentVersion}）`, version: latest }
  } catch (error) {
    const aborted = !!error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError"
    return {
      status: "error",
      text: aborted
        ? "检查更新超时（网络或 CSP 可能拦截了 api.github.com）"
        : "检查更新失败（网络或 CSP 可能拦截了 api.github.com）",
      version: null,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 诊断导出                                                            */
/* ------------------------------------------------------------------ */

export interface DiagnosticsRelay {
  serverName: string | null
  serverProto: number | null
  clientVersion: string
  browserOnline: boolean
  authed: boolean
  deviceMode: boolean
}

export interface DiagnosticsInput {
  hostDiag: HostDiag | null
  relay: DiagnosticsRelay
  devices: readonly Device[]
  selectedDeviceId: string | null
  appVersion: string
  now?: number
}

export interface DiagnosticsFile {
  fileName: string
  mime: string
  text: string
}

function clean(value: unknown, max = 200): string {
  if (typeof value !== "string") return ""
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) out += char
  }
  return out.trim().slice(0, max)
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null
}

/** 设备只留白名单字段：名册 id / 名字 / 平台 / 在线 / 配对 / 鉴权方式 / 时间 / 延迟。 */
function safeDevice(device: Device): Record<string, string | number | boolean | null> {
  return {
    id: clean(device.id),
    name: clean(device.name),
    platform: clean(device.platform),
    online: device.online === true,
    paired: device.paired === true,
    auth: device.auth === "token" || device.auth === "legacy" ? device.auth : null,
    lastAttachAt: finiteOrNull(device.lastAttachAt),
    firstSeenAt: finiteOrNull(device.firstSeenAt),
    windowExpiresAt: finiteOrNull(device.windowExpiresAt),
    latencyMs: finiteOrNull(device.latencyMs),
  }
}

/** YYYYMMDD-HHmmss（本地时区；只用于文件名）。 */
function stampOf(now: number): string {
  const date = new Date(now)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 「导出诊断信息」组包：host diag + 中继信息 + 设备名册 + 版本。
 * 用户点击时才调用；组好的 JSON 只在本机下载，不打印、不上传。
 */
export function buildDiagnosticsExport(input: DiagnosticsInput): DiagnosticsFile {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now()
  const diag = normalizeHostDiag(input.hostDiag)
  const payload = {
    app: "Pi-Remote",
    format: "pi-remote-diagnostics.v1",
    exportedAt: new Date(now).toISOString(),
    appVersion: clean(input.appVersion, 80),
    relay: {
      serverName: clean(input.relay.serverName, 200),
      serverProto: finiteOrNull(input.relay.serverProto),
      clientVersion: clean(input.relay.clientVersion, 80),
      browserOnline: input.relay.browserOnline === true,
      authed: input.relay.authed === true,
      deviceMode: input.relay.deviceMode === true,
    },
    selectedDeviceId: clean(input.selectedDeviceId),
    devices: input.devices.map(safeDevice),
    hostDiag: diag,
    hostDiagUnavailable: diag === null,
  }
  const text = redactSecrets(JSON.stringify(payload, null, 2))
  return {
    fileName: `pi-remote-diagnostics-${stampOf(now)}.json`,
    mime: "application/json",
    text,
  }
}
