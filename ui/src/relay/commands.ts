/**
 * viewer → relay 命令通道（不依赖 React，便于单测）。
 *
 * 超时协调：发出后先等 relay 的 command_accepted（ACCEPT_TIMEOUT_MS），收到后按其中的
 * timeoutMs（relay 的权威超时）+ 余量重设计时器，前端不再自己猜每条命令要多久。
 *
 * 重传与去重：每个逻辑请求生成一个 dedupeKey，重发时保持不变。relay 按 (room, dedupeKey)
 * 在飞合并、完成后回放结果，所以在同一个 relay 进程内重发任何命令都不会重复执行。
 *  - 没等到受理回执 → 同一连接上重发一次
 *  - 连接断开 → 先挂起，重连后若 relay boot 未变就重发（取回结果），boot 变了（relay 重启、
 *    去重表已丢）只重发只读命令，有副作用的命令明确报"结果未知"
 */

export type SocketLike = { readyState: number; send(data: string): void }

type Pending = {
  id: string
  command: string
  frame: string
  resolve: (data?: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  boot: string
  sends: number
  retry: boolean
  parked: boolean
  lostMessage: string
  /** 设备级命令的等待截止时刻：受理前是前端给的上限；收到 command_accepted 后改为 relay 的 timeoutMs + 余量 */
  deadlineAt: number | null
}

export type CommandChannelOptions = {
  acceptTimeoutMs?: number
  /** 收到 command_accepted 后在 relay 超时之外再等的余量 */
  slackMs?: number
  /** 断线后等重连的最长时间，超过即判失败 */
  graceMs?: number
}

const OPEN = 1

export type CodedError = Error & { code: string; retryable?: boolean }

/** 通道自己判的失败也带码（DOC/71 §2）：没等到回应或断线后取不回结果 result_unknown（命令可能已执行），发不出去 offline */
function coded(code: string, message: string, retryable?: unknown): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  if (typeof retryable === "boolean") error.retryable = retryable
  return error
}

export function isReadOnlyCommand(command: string): boolean {
  return /^(get_|list_)/.test(command)
}

export class CommandChannel {
  private pending = new Map<string, Pending>()
  private seq = 0
  private boot = ""
  private ws: SocketLike | null = null
  private readonly acceptTimeoutMs: number
  private readonly slackMs: number
  private readonly graceMs: number

  constructor(opts: CommandChannelOptions = {}) {
    this.acceptTimeoutMs = opts.acceptTimeoutMs ?? 10000
    this.slackMs = opts.slackMs ?? 5000
    this.graceMs = opts.graceMs ?? 20000
  }

  get size(): number {
    return this.pending.size
  }

  /** 当前连接（新建 socket 时换上；在飞命令仍只认发出时的那条连接做受理重发） */
  attach(ws: SocketLike | null): void {
    this.ws = ws
  }

  /** 通用命令（带 dedupeKey，可安全重发）。dedupeKey 缺省用帧 id；outbox 回放传条目自己的 key */
  command(room: string, command: string, args?: Record<string, unknown>, lostMessage = "命令没有回应", dedupeKey?: string): Promise<unknown> {
    const id = this.nextId("c")
    const frame = JSON.stringify({ type: "command", id, room, command, args: args ?? {}, dedupeKey: dedupeKey || id })
    return this.start(id, command, frame, true, lostMessage, null)
  }

  /**
   * 设备级命令：用 deviceId 寻址，不自动重发。
   * deadlineMs 是等受理回执的上限；收到 command_accepted 后按 relay 回执里的 timeoutMs（relay 配置是唯一口径）+ 余量重新计时，
   * 这样 relay 改了 harnessStartTimeoutMs，前端不会比它先判超时。
   */
  deviceCommand(deviceId: string, command: string, args: Record<string, unknown> | undefined, deadlineMs: number, lostMessage: string): Promise<unknown> {
    const id = this.nextId("c")
    const frame = JSON.stringify({ type: "command", id, deviceId, command, args: args ?? {}, dedupeKey: id })
    return this.start(id, command, frame, false, lostMessage, Date.now() + Math.max(0, deadlineMs))
  }

  /** 非命令帧（relay 直接 ack、不去重）：只发一次，绝不重发 */
  raw(frame: Record<string, unknown>, lostMessage = "没有收到回应"): Promise<unknown> {
    const id = this.nextId("r")
    return this.start(id, String(frame.type || ""), JSON.stringify({ ...frame, id }), false, lostMessage, null)
  }

  /** 处理 command_accepted；返回是否属于本通道 */
  accepted(id: unknown, timeoutMs: unknown): boolean {
    const p = typeof id === "string" ? this.pending.get(id) : undefined
    if (!p) return false
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 60000
    const want = ms + this.slackMs
    if (p.deadlineAt) p.deadlineAt = Date.now() + want
    this.arm(p, want, () => this.fail(p, coded("result_unknown", p.lostMessage)))
    return true
  }

  /** 处理 ack；返回是否属于本通道。v4 下失败必带 code（旧 relay 可能没有，code 为空串） */
  ack(msg: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown; code?: unknown; retryable?: unknown }): boolean {
    const p = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined
    if (!p) return false
    this.clear(p)
    this.pending.delete(p.id)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(coded(typeof msg.code === "string" ? msg.code : "", String(msg.error || "失败"), msg.retryable))
    return true
  }

  /**
   * relay 回了带 id 的 error 帧（rate_limited / no_device 等）：对应命令立刻失败，不用干等超时。
   * 返回是否属于本通道。
   */
  error(msg: { id?: unknown; code?: unknown; message?: unknown; retryable?: unknown }): boolean {
    const p = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined
    if (!p) return false
    this.fail(p, coded(typeof msg.code === "string" ? msg.code : "", String(msg.message || msg.code || "失败"), msg.retryable))
    return true
  }

  /** 连接断开：可重发的挂起等重连，其余立即失败 */
  disconnected(): void {
    for (const p of [...this.pending.values()]) {
      if (!p.retry) {
        this.fail(p, coded("offline", "连接已断开"))
        continue
      }
      p.parked = true
      this.arm(p, this.graceMs, () => this.fail(p, coded("result_unknown", "连接已断开，命令结果未知")))
    }
  }

  /** 重新认证成功（boot = relay 进程实例 id） */
  connected(boot: string): void {
    const previous = this.boot
    this.boot = boot || ""
    for (const p of [...this.pending.values()]) {
      if (!p.parked) continue
      const sameRelay = !!this.boot && this.boot === p.boot
      if (sameRelay || isReadOnlyCommand(p.command)) {
        p.boot = this.boot
        p.sends = 0
        this.transmit(p)
      } else {
        this.fail(p, coded("result_unknown", previous && this.boot !== previous ? "relay 已重启，命令结果未知，请确认后再操作" : "连接已断开，命令结果未知"))
      }
    }
  }

  /** 卸载 / 换 token：全部失败 */
  dispose(reason = "连接已关闭"): void {
    for (const p of [...this.pending.values()]) this.fail(p, coded("closed", reason))
  }

  private nextId(prefix: string): string {
    this.seq += 1
    return prefix + this.seq + "_" + Math.random().toString(36).slice(2, 8)
  }

  private start(id: string, command: string, frame: string, retry: boolean, lostMessage: string, deadlineAt: number | null): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const p: Pending = { id, command, frame, resolve, reject, timer: null, boot: this.boot, sends: 0, retry, parked: false, lostMessage, deadlineAt }
      this.pending.set(id, p)
      this.transmit(p)
    })
  }

  private transmit(p: Pending): void {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN) {
      this.fail(p, coded("offline", "连接不可用"))
      return
    }
    p.parked = false
    p.sends += 1
    try {
      ws.send(p.frame)
    } catch {
      this.fail(p, coded("offline", "发送失败"))
      return
    }
    const initial = p.deadlineAt ? Math.max(0, p.deadlineAt - Date.now()) : this.acceptTimeoutMs
    this.arm(p, initial, () => {
      if (p.retry && p.sends < 2 && this.ws === ws && ws.readyState === OPEN) this.transmit(p)
      else this.fail(p, coded("result_unknown", p.lostMessage))
    })
  }

  private arm(p: Pending, ms: number, fire: () => void): void {
    this.clear(p)
    p.timer = setTimeout(() => {
      p.timer = null
      if (this.pending.get(p.id) === p) fire()
    }, ms)
  }

  private clear(p: Pending): void {
    if (p.timer) clearTimeout(p.timer)
    p.timer = null
  }

  private fail(p: Pending, error: Error): void {
    this.clear(p)
    if (this.pending.get(p.id) !== p) return
    this.pending.delete(p.id)
    p.reject(error)
  }
}
