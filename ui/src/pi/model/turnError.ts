/**
 * 回合结束原因 → 流里的一行字（design §3.4 stream-errors、D18；PLAN 5.4 b 线）。纯函数，node --test 直接加载。
 * 错误原文对中文：pi 的 AssistantMessage.errorMessage 有时是错误类型本身（"overloaded_error"），
 * 有时是带类型的整段原文（`529 {"type":"error","error":{"type":"overloaded_error",…}}`）。认得出类型就写中文 +（原文或类型），
 * 认不出就只写原文；原文太长截短。没有原文写"未知原因"，不编原因。
 * components/pi/conversation/tools.ts 的 stopReasonText 委托到这里（流内的 PiTurnError / PiReceipt 用它）。
 */

/** 认得出的错误类型 → 中文 */
export const TURN_ERROR_TEXT: Readonly<Record<string, string>> = {
  overloaded_error: "服务繁忙",
  rate_limit_error: "请求太频繁",
  api_error: "服务出错",
  authentication_error: "模型凭据无效",
  permission_error: "没有权限使用这个模型",
  invalid_request_error: "请求无效",
  not_found_error: "找不到这个模型",
  request_too_large: "请求太大",
  context_length_exceeded: "上下文超出模型上限",
}

/** 原文超过这么多字就截短（括号里放不下整段 JSON） */
export const TURN_ERROR_RAW_MAX = 60

const KNOWN = Object.keys(TURN_ERROR_TEXT)

/** 上下文溢出的常见说法：Anthropic 是 invalid_request_error + "prompt is too long"，OpenAI 兼容服务是 code context_length_exceeded / "maximum context length" */
const CONTEXT_OVERFLOW = /context_length_exceeded|maximum context length|prompt is too long|context window (exceeded|is full)|exceeds? the context window/
/** 从错误原文里认出错误类型：先认整串，再认上下文溢出（比 invalid_request_error 更具体，先认），再认原文里出现的类型名，最后认几个常见说法（"Overloaded"、"rate limit"） */
export function turnErrorKindOf(message: string | null | undefined): string | null {
  const raw = typeof message === "string" ? message.trim() : ""
  if (!raw) return null
  if (TURN_ERROR_TEXT[raw]) return raw
  const lower = raw.toLowerCase()
  if (CONTEXT_OVERFLOW.test(lower)) return "context_length_exceeded"
  for (const kind of KNOWN) if (lower.includes(kind)) return kind
  if (/\boverloaded\b/.test(lower)) return "overloaded_error"
  if (/\brate[ _-]?limit/.test(lower)) return "rate_limit_error"
  return null
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > TURN_ERROR_RAW_MAX ? `${one.slice(0, TURN_ERROR_RAW_MAX)}…` : one
}

export type PiTurnEnd = { text: string; error: boolean }
/** AbortSignal / AbortError 的原文（DOMException、undici、pi 自己的写法） */
const ABORT_MESSAGE = /^(?:this operation was aborted|the operation was aborted|request was aborted|aborterror)\.?$/i

/**
 * stopReason（+ errorMessage）→ 一行字；正常结束（stop / toolUse / 缺失）返回 null。
 * - error："这一轮出错了：服务繁忙（overloaded_error）"；认不出类型时"这一轮出错了：<原文>"；没有原文"这一轮出错了：未知原因"。
 * - aborted："已停止生成"；length："达到长度上限，回复被截断"。
 */
export function turnErrorOf(stopReason: string | null | undefined, errorMessage?: string | null): PiTurnEnd | null {
  switch (stopReason) {
    case "error": {
      const raw = typeof errorMessage === "string" ? errorMessage.trim() : ""
      if (!raw) return { text: "这一轮出错了：未知原因", error: true }
      // 用户打断（排队「立即发送」= 先 abort 再发）时，pi 1.3 有时把被打断的那次模型调用记成 stopReason "error"、
      // errorMessage 是 AbortSignal 的原文。这是停止，不是出错（D18：停止写"已停止生成"）
      if (ABORT_MESSAGE.test(raw)) return { text: "已停止生成", error: false }
      const kind = turnErrorKindOf(raw)
      const shown = raw.length > TURN_ERROR_RAW_MAX && kind ? kind : shorten(raw)
      return { text: kind ? `这一轮出错了：${TURN_ERROR_TEXT[kind]}（${shown}）` : `这一轮出错了：${shown}`, error: true }
    }
    case "aborted":
      return { text: "已停止生成", error: false }
    case "length":
      return { text: "达到长度上限，回复被截断", error: false }
    default:
      return null
  }
}
