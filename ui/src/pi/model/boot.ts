/**
 * 启动分支与空态（plan §7.1 boot-loading / no-devices、P5.3；design §3.3、§5 加载行）。纯函数，node --test 直接加载。
 * 口径照旧界面 shell/Shell.tsx 的 firstDataReady + shell/skeletonModel.ts：
 *   - 还没连上过（!authed && !everConnected）= 首次连接：列表骨架 + 主区 Spinner，绝不出空会话卡（修 U-12）；
 *   - 会话清单在拉、手里一行都没有 = 列表骨架；
 *   - 名册生效（rosterActive）而一台设备都没有 = no-devices 空态（relay 声明了 device.token 才给"配对新设备"）。
 * 打开会话后快照未到（snapshotPending）是对话流自己的状态（b 线），不在这里。
 */
import { rosterActive } from "../../relay/devices.ts"

export type PiBootInput = {
  token: string
  authed: boolean
  everConnected: boolean
  deviceMode: boolean
  devices: readonly { id: string; online: boolean }[]
  rooms: readonly { id: string }[]
  sessionsLoading: boolean
  /** 侧栏手里的会话行数（所有设备合起来） */
  sessionCount: number
  /** relay 声明了 device.token（能配对） */
  canManageDevices: boolean
  roomId: string
}

/** relay 的切片 → PiBootInput（字段名同 useRelay 的返回值；sessionCount = 侧栏手里的会话行数） */
export function bootInputOf(r: Omit<PiBootInput, "sessionCount">, sessionCount: number): PiBootInput {
  return {
    token: r.token,
    authed: r.authed,
    everConnected: r.everConnected,
    deviceMode: r.deviceMode,
    devices: r.devices,
    rooms: r.rooms,
    sessionsLoading: r.sessionsLoading,
    sessionCount,
    canManageDevices: r.canManageDevices,
    roomId: r.roomId,
  }
}

export type PiBootView =
  /** 还没连上过：列表骨架 + 主区"正在连接 <host>…" */
  | { kind: "connecting" }
  /** 名册生效、一台设备都没有 */
  | { kind: "no-devices"; pairing: boolean }
  /** 有设备，但都未连接、也没打开会话：主区写"N 台设备都未连接" */
  | { kind: "all-offline"; count: number }
  | { kind: "ready" }

export function bootViewOf(input: PiBootInput): PiBootView {
  if (input.token && !input.authed && !input.everConnected) return { kind: "connecting" }
  if (rosterActive({ deviceMode: input.deviceMode, devices: [...input.devices], rooms: [...input.rooms] }) && input.devices.length === 0) {
    return { kind: "no-devices", pairing: input.canManageDevices }
  }
  if (!input.roomId && input.devices.length > 0 && input.devices.every((d) => !d.online)) return { kind: "all-offline", count: input.devices.length }
  return { kind: "ready" }
}

/** 侧栏是不是该画骨架行：首次连接，或清单在拉、手里一行都没有（同 firstDataReady 的第二条） */
export function listLoadingOf(input: Pick<PiBootInput, "token" | "authed" | "everConnected" | "sessionsLoading" | "sessionCount">): boolean {
  if (input.token && !input.authed && !input.everConnected) return true
  return input.sessionsLoading && input.sessionCount === 0
}

/**
 * relay 的 host（登录卡脚注"连接到 …"、主区"正在连接 …"）：口径同 useRelay 的 wsUrl（构建时的 VITE_RELAY_URL > 同源 > 本机兜底 127.0.0.1:7002）。
 */
export function relayHostOf(envUrl: string | null | undefined, loc: { host: string; protocol: string }): string {
  if (envUrl) {
    try {
      return new URL(envUrl).host || envUrl
    } catch {
      return envUrl
    }
  }
  if (loc.host && loc.protocol.startsWith("http")) return loc.host
  return "127.0.0.1:7002"
}

/** 主区"正在连接 relay.example.com…" */
export function connectingText(host: string | null | undefined): string {
  return host ? `正在连接 ${host}…` : "正在连接…"
}
