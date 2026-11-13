/**
 * Settings > Devices > System operations -- pure view logic (no React / no DOM,
 * loaded directly by node --test).
 *
 * Contract: SYSOPS-CONTRACT.md. The device side (attach) executes the four
 * mutating commands (update_pi / harness_restart / restart_host /
 * update_components) fire-and-track; this module only shapes what the pages
 * render: the version block from get_host_diag, the availability of each
 * operation row, the confirm-dialog copy, and the running / failed / result
 * presentation of the attach-held operationStatus.
 *
 * Data discipline: copy states only facts the replies carry. A field the
 * device did not send stays unknown (null) and is rendered as "not provided"
 * or as the stated reason an operation is unavailable -- never guessed.
 */
import { deviceErrorText, errorCode } from "../../../relay/devices.ts"
import { lastOnlineTextOf, platformLabelOf, type DeviceLike } from "./devicesLogic.ts"

/* ------------------------------ contract types ------------------------------ */

export type OperationKind = "update_pi" | "harness_restart" | "restart_host" | "update_components"

export const OPERATION_KINDS: readonly OperationKind[] = ["update_pi", "harness_restart", "restart_host", "update_components"]

export type OperationState = "idle" | "running" | "succeeded" | "failed"

export interface OperationStatus {
  state: OperationState
  kind: OperationKind | null
  phase: string | null
  startedAt: number | null
  finishedAt: number | null
  detail: string | null
  error: string | null
}

export const IDLE_OPERATION_STATUS: OperationStatus = {
  state: "idle",
  kind: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  detail: null,
  error: null,
}

export type PiInstallMethod = "npm-global" | "other" | "unknown"

export interface PiUpdateInfo {
  currentVersion: string
  latestVersion: string | null
  installMethod: PiInstallMethod
  canUpdate: boolean
  checkError: string | null
  /** Attach-side facts the update-info reply also carries. They are the
   *  preferred source for availability and the version block: with an active
   *  session get_host_diag is answered by the extension, whose fixed-shape
   *  reply has none of them. Null/empty when the reply did not carry them. */
  supervised: boolean | null
  launchedPiCount: number | null
  attachVersion: string
}

/** The get_host_diag fields the system-operations area reads (contract additions included). */
export interface SystemOpsDiag {
  piVersion: string
  nodeVersion: string
  platform: string
  arch: string
  extensionVersion: string
  attachVersion: string
  piInstallMethod: PiInstallMethod | null
  supervised: boolean | null
  launchedPiCount: number | null
  operationStatus: OperationStatus
}

/* ------------------------------ small parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function versionField(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function timestampField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

function countField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function installMethodField(value: unknown): PiInstallMethod | null {
  return value === "npm-global" || value === "other" || value === "unknown" ? value : null
}

function operationKindField(value: unknown): OperationKind | null {
  return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value) ? (value as OperationKind) : null
}

/* ------------------------------ normalizers ------------------------------ */

export function normalizeOperationStatus(value: unknown): OperationStatus {
  if (!isRecord(value)) return IDLE_OPERATION_STATUS
  const state = value.state
  if (state !== "running" && state !== "succeeded" && state !== "failed") return IDLE_OPERATION_STATUS
  return {
    state,
    kind: operationKindField(value.kind),
    phase: textField(value.phase) || null,
    startedAt: timestampField(value.startedAt),
    finishedAt: timestampField(value.finishedAt),
    detail: textField(value.detail) || null,
    error: textField(value.error) || null,
  }
}

/** get_pi_update_info reply; null when the reply carries nothing usable. */
export function normalizePiUpdateInfo(value: unknown): PiUpdateInfo | null {
  if (!isRecord(value)) return null
  const currentVersion = versionField(value.currentVersion)
  const latestVersion = versionField(value.latestVersion) || null
  const installMethod = installMethodField(value.installMethod)
  if (!currentVersion && !latestVersion && !installMethod) return null
  return {
    currentVersion,
    latestVersion,
    installMethod: installMethod ?? "unknown",
    canUpdate: value.canUpdate === true,
    checkError: textField(value.checkError) || null,
    supervised: typeof value.supervised === "boolean" ? value.supervised : null,
    launchedPiCount: countField(value.launchedPiCount),
    attachVersion: attachVersionOf(value),
  }
}

/**
 * get_operation_status reply: `{ operationStatus }` from the attach-direct
 * route (a bare status-shaped record is also accepted). Null when the reply
 * carries no status at all, so the caller can fall back to the diag field.
 */
export function operationStatusReplyOf(value: unknown): OperationStatus | null {
  if (!isRecord(value)) return null
  if ("operationStatus" in value) return normalizeOperationStatus(value.operationStatus)
  if (value.state === "running" || value.state === "succeeded" || value.state === "failed" || value.state === "idle") {
    return normalizeOperationStatus(value)
  }
  return null
}

/**
 * Attach version in the diag reply: the attach block may carry it as
 * attach.version; a top-level attachVersion or a bare string attach are also
 * accepted so the block renders against either attach build.
 */
function attachVersionOf(raw: Record<string, unknown>): string {
  const top = versionField(raw.attachVersion)
  if (top) return top
  if (typeof raw.attach === "string") return raw.attach.trim()
  if (isRecord(raw.attach)) return versionField(raw.attach.version)
  return ""
}

/** Parse the raw get_host_diag reply into the fields this area reads; null when it is not an object. */
export function systemOpsDiagOf(value: unknown): SystemOpsDiag | null {
  if (!isRecord(value)) return null
  return {
    piVersion: versionField(value.piVersion),
    nodeVersion: versionField(value.nodeVersion),
    platform: versionField(value.platform),
    arch: versionField(value.arch),
    extensionVersion: versionField(value.extensionVersion),
    attachVersion: attachVersionOf(value),
    piInstallMethod: installMethodField(value.piInstallMethod),
    supervised: typeof value.supervised === "boolean" ? value.supervised : null,
    launchedPiCount: countField(value.launchedPiCount),
    operationStatus: normalizeOperationStatus(value.operationStatus),
  }
}

/** Optimistic status right after a mutating command is accepted, until the first diag poll lands. */
export function operationStartedStatusOf(kind: OperationKind, now: number): OperationStatus {
  const phase = kind === "update_pi" ? "checking" : kind === "update_components" ? "downloading" : "restarting"
  return { state: "running", kind, phase, startedAt: now, finishedAt: null, detail: null, error: null }
}

/* ------------------------------ capability gate ------------------------------ */

export const DEVICE_OPS_CAP = "device.ops"

export function deviceOpsSupportedOf(device: { features?: readonly string[] | null }): boolean {
  return Array.isArray(device.features) && device.features.includes(DEVICE_OPS_CAP)
}

export const SYSTEM_OPS_OFFLINE_TEXT = "设备离线，无法执行系统操作"
export const SYSTEM_OPS_UNSUPPORTED_TEXT = "设备端版本不支持系统操作，先在设备本机更新 Pi-Remote"
export const SYSTEM_OPS_NO_COMMAND_TEXT = "当前版本没有可用的设备命令"

/* ------------------------------ busy awareness ------------------------------ */

export interface RoomBusyLike {
  deviceId?: string
  online?: boolean
  busy?: boolean
  waiting?: readonly unknown[] | null
  waitingPrompt?: unknown
}

export interface DeviceBusy {
  generating: boolean
  pendingDialog: boolean
}

/** Busy facts for one device from its online rooms: a generating turn and/or an unanswered dialog. */
export function deviceBusyOf(rooms: readonly RoomBusyLike[] | null | undefined, deviceId: string): DeviceBusy {
  let generating = false
  let pendingDialog = false
  for (const room of rooms ?? []) {
    if (!room || room.deviceId !== deviceId || room.online !== true) continue
    if (room.busy === true) generating = true
    if ((Array.isArray(room.waiting) && room.waiting.length > 0) || room.waitingPrompt) pendingDialog = true
  }
  return { generating, pendingDialog }
}

/* ------------------------------ version block ------------------------------ */

export interface VersionCell {
  label: string
  value: string
  /** Accent tag next to the value (the available Pi update), else null. */
  tag: string | null
}

const MISSING = "未提供"

export function versionCellsOf(diag: SystemOpsDiag, update: PiUpdateInfo | null): VersionCell[] {
  const node = diag.nodeVersion.replace(/^v/i, "")
  return [
    {
      label: "Pi 版本",
      value: diag.piVersion || MISSING,
      tag: update?.canUpdate && update.latestVersion ? `新版 ${update.latestVersion}` : null,
    },
    { label: "扩展版本", value: diag.extensionVersion || MISSING, tag: null },
    // The update-info reply is the preferred attach-version source: it comes
    // from attach itself, while the diag reply may be the extension's shape.
    { label: "Attach 版本", value: update?.attachVersion || diag.attachVersion || MISSING, tag: null },
    { label: "Node", value: node || MISSING, tag: null },
    {
      label: "平台",
      value: `${platformLabelOf(diag.platform)}${diag.arch ? ` · ${diag.arch}` : ""}`,
      tag: null,
    },
  ]
}

/* ------------------------------ phase / elapsed ------------------------------ */

const PHASE_TEXT_BY_KIND: Partial<Record<OperationKind, Record<string, string>>> = {
  update_pi: {
    checking: "正在检查更新",
    installing: "正在安装",
    restarting: "正在重启 Pi",
    verifying: "正在核对版本",
  },
  update_components: {
    downloading: "正在下载设备包",
    verifying: "正在校验设备包",
    swapping: "正在替换文件",
    restarting: "正在重启设备端",
  },
  harness_restart: { restarting: "正在重启 Pi" },
  restart_host: { restarting: "正在重启设备端" },
}

const DEFAULT_PHASE_BY_KIND: Record<OperationKind, string> = {
  update_pi: "正在检查更新",
  harness_restart: "正在重启 Pi",
  restart_host: "正在重启设备端",
  update_components: "正在下载设备包",
}

/** Running-row phase label; the Pi update names its target version while installing. */
export function operationPhaseTextOf(status: OperationStatus, update: PiUpdateInfo | null): string {
  if (!status.kind) return "正在执行"
  const byKind = PHASE_TEXT_BY_KIND[status.kind]
  const base = (status.phase && byKind?.[status.phase]) || DEFAULT_PHASE_BY_KIND[status.kind]
  if (status.kind === "update_pi" && status.phase === "installing" && update?.latestVersion) {
    return `正在安装 ${update.latestVersion}`
  }
  return base
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** Elapsed label for a running operation: 已用时 24 秒 / 已用时 2 分 05 秒. */
export function operationElapsedTextOf(startedAt: number | null, now: number): string {
  if (startedAt == null || !Number.isFinite(now)) return "已用时 —"
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `已用时 ${seconds} 秒`
  return `已用时 ${Math.floor(seconds / 60)} 分 ${pad2(seconds % 60)} 秒`
}

/* ------------------------------ operation rows ------------------------------ */

export type SystemOpButtonAction = "run" | "retry" | "recheck"

export interface SystemOpRow {
  kind: OperationKind
  title: string
  /** Title tone: failed rows render their title in the error color. */
  failed: boolean
  /** Warning segment rendered ahead of the description in the warning color, else null. */
  warningText: string | null
  description: string
  /** Raw error text for the failed row's error box, else null. */
  errorText: string | null
  /** Phase label for the running row, else null. */
  phaseText: string | null
  buttonLabel: string | null
  buttonPrimary: boolean
  buttonEnabled: boolean
  buttonAction: SystemOpButtonAction | null
}

export interface SystemOpsFacts {
  device: DeviceLike & { id: string; features?: string[] }
  diag: SystemOpsDiag | null
  update: PiUpdateInfo | null
  /** get_pi_update_info itself failed (command error), already phrased for the user. */
  updateCheckError: string | null
  busy: DeviceBusy
}

const OPERATION_TITLES: Record<OperationKind, string> = {
  update_pi: "更新 Pi",
  harness_restart: "重启 Pi",
  restart_host: "重启设备端",
  update_components: "更新设备端组件",
}

const RUNNING_DESCRIPTIONS: Record<OperationKind, string> = {
  update_pi: "安装完成后自动重启 Pi 并核对新版本，期间这台设备的其余操作暂停。",
  harness_restart: "重启完成后自动回到当前会话，期间这台设备的其余操作暂停。",
  restart_host: "设备端重新连上后自动恢复，期间这台设备短暂离线。",
  update_components: "校验通过后替换文件并重启设备端，期间这台设备短暂离线。",
}

function busyWarningOf(kind: OperationKind, busy: DeviceBusy): string | null {
  if (kind !== "update_pi" && kind !== "harness_restart") return null
  const parts: string[] = []
  if (busy.generating) {
    parts.push(
      kind === "harness_restart" ? "这台设备正在生成一轮回复，现在重启会打断它；" : "这台设备正在生成一轮回复，更新后的重启会打断它；",
    )
  }
  if (busy.pendingDialog) {
    parts.push(kind === "harness_restart" ? "这台设备有尚未回答的提问，重启后提问会失效；" : "这台设备有尚未回答的提问，更新后的重启会使提问失效；")
  }
  return parts.length ? parts.join("") : null
}

function baseRow(kind: OperationKind): SystemOpRow {
  return {
    kind,
    title: OPERATION_TITLES[kind],
    failed: false,
    warningText: null,
    description: "",
    errorText: null,
    phaseText: null,
    buttonLabel: null,
    buttonPrimary: false,
    buttonEnabled: false,
    buttonAction: null,
  }
}

function updatePiRow(facts: SystemOpsFacts, otherRunning: boolean): SystemOpRow {
  const row = baseRow("update_pi")
  const { update, updateCheckError, busy } = facts
  if (updateCheckError) {
    row.description = `无法检查更新：${updateCheckError}`
    row.buttonLabel = "重新检查"
    row.buttonEnabled = !otherRunning
    row.buttonAction = "recheck"
    return row
  }
  if (!update) {
    row.description = "正在检查更新…"
    row.buttonLabel = "检查中…"
    return row
  }
  if (update.installMethod !== "npm-global") {
    row.description =
      update.installMethod === "other" ? "这台设备上的 Pi 不是通过 npm 安装，无法在此更新" : "无法确认这台设备上 Pi 的安装方式，无法在此更新"
    row.buttonLabel = "无法更新"
    return row
  }
  if (!update.latestVersion) {
    row.description = update.checkError ? `版本检查失败：${update.checkError}` : "版本检查失败"
    row.buttonLabel = "重新检查"
    row.buttonEnabled = !otherRunning
    row.buttonAction = "recheck"
    return row
  }
  if (!update.canUpdate) {
    row.description = `当前 ${update.currentVersion || "版本未知"}，已是最新版本。`
    row.buttonLabel = "已是最新"
    return row
  }
  row.warningText = busyWarningOf("update_pi", busy)
  row.description = `把这台设备上的 Pi 更新到 ${update.latestVersion}（当前 ${update.currentVersion}）。更新完成后自动重启 Pi，会话不丢失。`
  row.buttonLabel = `更新到 ${update.latestVersion}`
  row.buttonPrimary = true
  row.buttonEnabled = !otherRunning
  row.buttonAction = "run"
  return row
}

/** Availability fact with its two sources: the update-info reply first
 *  (answered by attach), the diag fields second (absent when the extension
 *  answered get_host_diag during an active session). */
function attachFactOf<T extends boolean | number>(facts: SystemOpsFacts, key: "supervised" | "launchedPiCount"): T | null {
  const fromUpdate = facts.update?.[key]
  if (fromUpdate != null) return fromUpdate as T
  return (facts.diag?.[key] as T | null | undefined) ?? null
}

function harnessRestartRow(facts: SystemOpsFacts, otherRunning: boolean): SystemOpRow {
  const row = baseRow("harness_restart")
  row.buttonLabel = "重启"
  row.buttonAction = "run"
  if (attachFactOf<number>(facts, "launchedPiCount") === 0) {
    row.description = "此 Pi 不是由 Pi-Remote 拉起，无法在此重启"
    row.buttonEnabled = false
    return row
  }
  row.warningText = busyWarningOf("harness_restart", facts.busy)
  row.description = "重启后自动回到当前会话。"
  row.buttonEnabled = !otherRunning
  return row
}

function supervisedReason(verb: string, supervised: boolean | null): string {
  return supervised === false ? `设备端不是常驻方式启动，无法${verb}` : `设备端未提供启动方式信息，无法${verb}`
}

function restartHostRow(facts: SystemOpsFacts, otherRunning: boolean): SystemOpRow {
  const row = baseRow("restart_host")
  row.buttonLabel = "重启"
  row.buttonAction = "run"
  const supervised = attachFactOf<boolean>(facts, "supervised")
  if (supervised !== true) {
    row.description = supervisedReason("远程重启", supervised)
    row.buttonEnabled = false
    return row
  }
  row.description = "重启这台设备上的 Pi-Remote 设备端（attach 与扩展连接）"
  row.buttonEnabled = !otherRunning
  return row
}

function updateComponentsRow(facts: SystemOpsFacts, otherRunning: boolean): SystemOpRow {
  const row = baseRow("update_components")
  row.buttonLabel = "更新"
  row.buttonAction = "run"
  const supervised = attachFactOf<boolean>(facts, "supervised")
  if (supervised !== true) {
    row.description = supervisedReason("在此更新", supervised)
    row.buttonEnabled = false
    return row
  }
  row.description = "下载最新版设备包，校验后替换扩展与 attach 文件"
  row.buttonEnabled = !otherRunning
  return row
}

/**
 * The four operation rows in sample order. The row of the running operation
 * turns into the progress row; the row of the failed operation carries the
 * raw error and a retry; every other row's button is disabled while any
 * operation runs on this device.
 */
export function operationRowsOf(facts: SystemOpsFacts, status: OperationStatus, now: number): SystemOpRow[] {
  const builders: Record<OperationKind, () => SystemOpRow> = {
    update_pi: () => updatePiRow(facts, status.state === "running" && status.kind !== "update_pi"),
    harness_restart: () => harnessRestartRow(facts, status.state === "running" && status.kind !== "harness_restart"),
    restart_host: () => restartHostRow(facts, status.state === "running" && status.kind !== "restart_host"),
    update_components: () => updateComponentsRow(facts, status.state === "running" && status.kind !== "update_components"),
  }
  return OPERATION_KINDS.map((kind) => {
    const row = builders[kind]()
    if (status.state === "running" && status.kind === kind) {
      row.phaseText = operationPhaseTextOf(status, facts.update)
      row.description = `${operationElapsedTextOf(status.startedAt, now)}。${RUNNING_DESCRIPTIONS[kind]}`
      row.warningText = null
      row.buttonLabel = null
      row.buttonAction = null
      row.buttonEnabled = false
      row.buttonPrimary = false
    } else if (status.state === "failed" && status.kind === kind) {
      row.failed = true
      row.title = `${OPERATION_TITLES[kind]} — 失败`
      row.warningText = null
      row.description = "操作未完成，错误原文："
      row.errorText = status.error || "设备没有给出错误信息"
      row.buttonLabel = "重试"
      row.buttonEnabled = true
      row.buttonAction = "retry"
      row.buttonPrimary = false
    }
    return row
  })
}

/* ------------------------------ result row ------------------------------ */

export interface OperationResult {
  title: string
  text: string
}

const RESULT_TITLES: Record<OperationKind, string> = {
  update_pi: "Pi 已更新",
  harness_restart: "Pi 已重启",
  restart_host: "设备端已重启",
  update_components: "设备端组件已更新",
}

function finishedTextOf(finishedAt: number | null, now: number): string {
  if (finishedAt == null) return "已完成"
  const diff = now - finishedAt
  if (diff >= 0 && diff < 60_000) return "刚刚完成"
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前完成`
  const when = lastOnlineTextOf(finishedAt, now)
  return when ? `${when} 完成` : "已完成"
}

/** The persisted success line; stays until the next operation starts. Null unless the last operation succeeded. */
export function operationResultOf(status: OperationStatus, now: number): OperationResult | null {
  if (status.state !== "succeeded" || !status.kind) return null
  const finished = finishedTextOf(status.finishedAt, now)
  return {
    title: RESULT_TITLES[status.kind],
    text: status.detail ? `${finished} · ${status.detail}` : finished,
  }
}

/* ------------------------------ confirm dialog copy ------------------------------ */

export interface OperationConfirmCopy {
  title: string
  body: string
  confirmLabel: string
  pendingLabel: string
}

export interface OperationConfirmInput {
  deviceName: string
  busy: DeviceBusy
  update: PiUpdateInfo | null
}

/**
 * Confirm-dialog copy, written from the facts at hand (the PiDeleteDialog
 * discipline): a busy device is told exactly what the operation interrupts;
 * an idle device gets only the plain consequences.
 */
export function operationConfirmOf(kind: OperationKind, input: OperationConfirmInput): OperationConfirmCopy {
  const name = input.deviceName
  const busyParts: string[] = []
  if (input.busy.generating) busyParts.push("正在生成一轮回复，重启会打断这一轮。")
  if (input.busy.pendingDialog) busyParts.push("尚未回答的提问会随之失效。")
  switch (kind) {
    case "harness_restart": {
      const lead = input.busy.generating || input.busy.pendingDialog ? `${name} 上的 Pi ${busyParts.join("")}` : `${name} 上的 Pi 会结束并重新启动。`
      return {
        title: "重启这台设备的 Pi？",
        body: `${lead}会话记录不会丢失，重启完成后自动回到当前会话。`,
        confirmLabel: "重启 Pi",
        pendingLabel: "重启中…",
      }
    }
    case "update_pi": {
      const latest = input.update?.latestVersion
      const current = input.update?.currentVersion
      const range = latest ? (current ? `从 ${current} 更新到 ${latest}` : `更新到 ${latest}`) : "更新到最新版"
      const busy = busyParts.length ? `${busyParts.join("")}` : ""
      return {
        title: "更新这台设备的 Pi？",
        body: `把 ${name} 上的 Pi ${range}，更新完成后自动重启 Pi。${busy}安装失败时现有 Pi 不受影响，会话记录不会丢失。`,
        confirmLabel: latest ? `更新到 ${latest}` : "更新 Pi",
        pendingLabel: "更新中…",
      }
    }
    case "restart_host":
      return {
        title: "重启这台设备的设备端？",
        body: `${name} 上的 Pi-Remote 设备端会退出并重新启动，这台设备会短暂离线。Pi 本身不会停止，重新连上后会话自动恢复。`,
        confirmLabel: "重启设备端",
        pendingLabel: "重启中…",
      }
    case "update_components":
      return {
        title: "更新这台设备的设备端组件？",
        body: `给 ${name} 下载最新版设备包，校验通过后替换扩展与 attach 文件（保留备份），然后重启设备端。校验或替换失败时自动恢复原文件，这台设备会短暂离线。`,
        confirmLabel: "更新组件",
        pendingLabel: "更新中…",
      }
  }
}

/* ------------------------------ command errors ------------------------------ */

const OPERATION_ERROR_COPY: Record<string, string> = {
  no_launched_pi: "这台设备上没有由 Pi-Remote 拉起的 Pi",
  not_supervised: "设备端不是常驻方式启动，无法远程执行此操作",
  unsupported_install_method: "这台设备上的 Pi 不是通过 npm 安装，无法在此更新",
  update_check_failed: "检查更新失败，无法连接 npm 注册表",
  already_latest: "已是最新版本",
  operation_in_progress: "这台设备已有操作在进行中",
  device_update_required: "设备端版本过低，不支持系统操作",
  device_offline: "设备未连接：先在电脑上打开 attach 窗口",
  unknown_command: "设备端版本不支持此操作",
  unknown_type: "设备端版本不支持此操作",
  timeout: "设备没有回应：请重试",
}

/** Acceptance-rejection copy for the four operations; unknown codes fall back to the shared device error text. */
export function operationErrorTextOf(error: unknown): string {
  const code = errorCode(error)
  if (code && OPERATION_ERROR_COPY[code]) return OPERATION_ERROR_COPY[code]
  return deviceErrorText(error)
}
