/**
 * 被控设备主机行为纯逻辑（Desktop / Mobile DevicesPage 共用，node --test 可直接加载）。
 *
 * 解析 `get_prevent_sleep` / `set_prevent_sleep` 回包：
 *   { supported: boolean, enabled: boolean, active: boolean, tool?: string }
 */

export interface PreventSleepState {
  supported: boolean
  enabled: boolean
  active: boolean
  tool: string | null
}

export function parsePreventSleepData(data: unknown): PreventSleepState | null {
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  if (typeof record.supported !== "boolean" && typeof record.enabled !== "boolean") return null
  return {
    supported: record.supported !== false,
    enabled: record.enabled === true,
    active: record.active === true,
    tool: typeof record.tool === "string" && record.tool.trim() ? record.tool.trim() : null,
  }
}

export function preventSleepDescriptionOf(input: {
  ready: boolean
  phase: "idle" | "loading" | "ready" | "error"
  errorText?: string
  state: PreventSleepState | null
  saving?: boolean
}): string {
  if (!input.ready) return "需默认设备在线后读写（在被控设备上生效，长任务过夜跑不会被系统睡眠打断）"
  if (input.saving) return "正在同步被控设备防休眠设置…"
  if (input.phase === "error" && !input.state) {
    return input.errorText ? `读取防休眠状态失败：${input.errorText}` : "读取防休眠状态失败"
  }
  if (input.state && !input.state.supported) {
    return "当前被控设备系统暂不支持防休眠抑制"
  }
  if (input.state?.enabled) {
    if (input.state.active && input.state.tool) {
      return `已开启（通过 ${input.state.tool} 在被控设备上防止系统休眠）`
    }
    return "已开启防休眠偏好，被控设备接入后保持唤醒"
  }
  if (input.phase === "loading" && !input.state) return "正在读取被控设备防休眠状态…"
  return "在被控设备上生效，长任务过夜跑不会被系统睡眠打断"
}

export function preventSleepViewOf(input: {
  ready: boolean
  phase: "idle" | "loading" | "ready" | "error"
  errorText?: string
  state: PreventSleepState | null
  saving: boolean
}): { checked: boolean; disabled: boolean; description: string } {
  const unsupported = input.state?.supported === false
  const disabled = !input.ready || input.saving || unsupported || (input.phase !== "ready" && !input.state)
  return {
    checked: Boolean(input.state?.enabled),
    disabled,
    description: preventSleepDescriptionOf(input),
  }
}
