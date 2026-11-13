/**
 * 回合结束原因 → 流里的一行字（design §3.4 stream-errors、D18；PLAN 5.4 b 线）。纯函数，node --test 直接加载。
 * 出错写人话："这一轮出错了：<简短原因>（<HTTP 状态码>）"；服务返回的原文放进 detail（流里点"详情"才展开），行里不露 JSON。
 * pi 的 AssistantMessage.errorMessage 有几种写法（pi-ai formatProviderError、各家 SDK）：
 * - 错误类型本身："overloaded_error"；
 * - 状态码 + 原文：`529 {"type":"error","error":{"type":"overloaded_error",…}}`、`401: {"message":"Incorrect API key provided",…}`、
 *   `OpenAI API error (429): …`、`429 status code (no body)`；
 * - 网络层：`Connection error.`、`Request timed out.`、`fetch failed`、`terminated`、`socket hang up`、ECONNRESET / ENOTFOUND…
 * 认原因的顺序：上下文溢出、额度、密钥、繁忙（比状态码具体）→ 原文里的错误类型名 → 状态码 → 常见说法（限流、超时、断网）。
 * 都认不出：短的纯文字照写；长的或 JSON 写服务给的 message（没有就写"模型服务报错"），原文进 detail。没有原文写"未知原因"，不编原因。
 * components/pi/conversation/tools.ts 的 stopReasonText 委托到这里（流内的 PiTurnError / PiReceipt 用它）。
 */

/** 认得出的错误原因 → 中文（行里的简短原因） */
export const TURN_ERROR_TEXT: Readonly<Record<string, string>> = {
  overloaded_error: "模型服务繁忙",
  rate_limit_error: "请求太频繁",
  api_error: "模型服务出错",
  service_unavailable: "模型服务暂时不可用",
  timeout_error: "请求超时",
  network_error: "网络连接中断",
  connect_error: "连不上模型服务",
  authentication_error: "API 密钥无效或已过期",
  billing_error: "账户额度不足",
  permission_error: "没有权限使用这个模型",
  invalid_request_error: "请求无效",
  not_found_error: "找不到这个模型",
  request_too_large: "请求太大",
  context_length_exceeded: "上下文超出模型上限",
  content_filter: "回复被内容审核拦下",
  request_rejected: "请求被拒绝",
}

/** 认不出原因时，原文不超过这么多字才照写进行里；超过就截短（原文全文在 detail） */
export const TURN_ERROR_RAW_MAX = 60

const KNOWN = Object.keys(TURN_ERROR_TEXT)

/** 上下文溢出的常见说法：Anthropic 是 invalid_request_error + "prompt is too long"，OpenAI 兼容服务是 code context_length_exceeded / "maximum context length" */
const CONTEXT_OVERFLOW = /context_length_exceeded|maximum context length|prompt is too long|context window (exceeded|is full)|exceeds? the context window/
/** 比状态码更具体的说法（429 也可能是额度用完，400 也可能是上下文溢出，503 也可能是繁忙），最先认 */
const SPECIFIC: readonly (readonly [string, RegExp])[] = [
  ["context_length_exceeded", CONTEXT_OVERFLOW],
  ["billing_error", /insufficient_quota|exceeded your current quota|quota exceeded|billing|available balance|insufficient balance|credit balance|out of budget|usage limit/],
  ["authentication_error", /invalid_api_key|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|api key not valid|unauthorized|unauthenticated/],
  ["overloaded_error", /\boverloaded\b|server_busy|servers are currently busy|high demand|at capacity/],
]
/** 没有类型名、也没有状态码时认的常见说法（pi 自动重试认的也是这些，见 pi-ai RETRYABLE_PROVIDER_ERROR_PATTERN）；超时排在断网前 */
const PHRASES: readonly (readonly [string, RegExp])[] = [
  ["rate_limit_error", /\brate[ _-]?limit|too many requests|resource_?exhausted/],
  ["service_unavailable", /service (?:is )?(?:temporarily )?unavailable|bad gateway/],
  ["timeout_error", /timed? ?out|deadline exceeded/],
  ["connect_error", /econnrefused|connection refused|enotfound|eai_again|getaddrinfo|unable to connect|failedtoopensocket/],
  [
    "network_error",
    /connection error|network ?error|fetch failed|socket hang up|econnreset|other side closed|socket connection was closed|connection (?:lost|closed|reset)|\bterminated\b|stream (?:was interrupted|disconnected|ended)|ended without|reset before headers|upstream connect/,
  ],
  ["content_filter", /content[ _-]?filter|content[ _]policy/],
  ["api_error", /internal (?:server )?error|server error/],
]

/** 原文里的 HTTP 状态码（只认 4xx / 5xx）："401: {…}"、"529 {…}"、"OpenAI API error (429): …"、"status code 503"、{"code":429}、"HTTP 502" */
const STATUS_PATTERNS = [
  /^(\d{3})(?=[\s:]|$)/,
  /\((\d{3})\):/,
  /\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*(\d{3})\b/i,
  /"code"\s*:\s*(\d{3})\b/,
  /\bHTTP\/?[\d.]*\s+(\d{3})\b/i,
]
export function httpStatusOf(message: string | null | undefined): number | null {
  const raw = typeof message === "string" ? message.trim() : ""
  for (const re of STATUS_PATTERNS) {
    const m = re.exec(raw)
    const status = m ? Number(m[1]) : 0
    if (status >= 400 && status < 600) return status
  }
  return null
}

function kindOfStatus(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request_error"
    case 401:
      return "authentication_error"
    case 402:
      return "billing_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 408:
    case 504:
      return "timeout_error"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_error"
    case 529:
      return "overloaded_error"
    case 502:
    case 503:
    case 520:
    case 521:
    case 522:
    case 523:
    case 524:
      return "service_unavailable"
    default:
      return status >= 500 ? "api_error" : "request_rejected"
  }
}

/** 从错误原文里认出原因（TURN_ERROR_TEXT 的键），顺序见文件头 */
export function turnErrorKindOf(message: string | null | undefined): string | null {
  const raw = typeof message === "string" ? message.trim() : ""
  if (!raw) return null
  if (TURN_ERROR_TEXT[raw]) return raw
  const lower = raw.toLowerCase()
  for (const [kind, re] of SPECIFIC) if (re.test(lower)) return kind
  for (const kind of KNOWN) if (lower.includes(kind)) return kind
  const status = httpStatusOf(raw)
  if (status != null) return kindOfStatus(status)
  for (const [kind, re] of PHRASES) if (re.test(lower)) return kind
  return null
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > TURN_ERROR_RAW_MAX ? `${one.slice(0, TURN_ERROR_RAW_MAX)}…` : one
}

/** 原文里第一段 JSON（服务返回的错误体）；不完整（被 pi 截断）或不是 JSON 返回 null */
function jsonBodyOf(raw: string): { head: string; body: unknown; tail: string } | null {
  const start = raw.search(/[{[]/)
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"))
  if (start < 0 || end <= start) return null
  try {
    return { head: raw.slice(0, start).trim(), body: JSON.parse(raw.slice(start, end + 1)), tail: raw.slice(end + 1).trim() }
  } catch {
    return null
  }
}

/** 服务在错误体里给的那句话（error.message / message / error / detail） */
function providerMessageOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const b = body as { error?: unknown; message?: unknown; detail?: unknown }
  const nested = typeof b.error === "object" && b.error !== null ? (b.error as { message?: unknown }).message : undefined
  for (const m of [nested, b.message, b.error, b.detail]) if (typeof m === "string" && m.trim()) return m.trim()
  return null
}

/** 详情：原文，错误体排成缩进的 JSON 好读 */
function detailOf(raw: string): string {
  const json = jsonBodyOf(raw)
  if (!json) return raw
  return [json.head, JSON.stringify(json.body, null, 2), json.tail].filter(Boolean).join("\n")
}

/** text = 行里的字；detail = 可展开的原文（只在出错且行里没照写原文时给） */
export type PiTurnEnd = { text: string; error: boolean; detail?: string }
/** AbortSignal / AbortError 的原文（DOMException、undici、pi 自己的写法） */
const ABORT_MESSAGE = /^(?:(?:this |the )?operation (?:was )?aborted|request was aborted|aborterror|aborted)\.?$/i
/** pi 没拿到原因时的占位原文 */
const UNKNOWN_MESSAGE = /^an unknown error occurred\.?$/i

/**
 * stopReason（+ errorMessage）→ 一行字；正常结束（stop / toolUse / 缺失）返回 null。
 * - error："这一轮出错了：模型服务繁忙（529）"（detail = 原文）；认不出原因时短的照写原文；没有原文"这一轮出错了：未知原因"。
 * - aborted："已停止生成"；length："达到长度上限，回复被截断"。
 */
export function turnErrorOf(stopReason: string | null | undefined, errorMessage?: string | null): PiTurnEnd | null {
  switch (stopReason) {
    case "error": {
      const raw = typeof errorMessage === "string" ? errorMessage.trim() : ""
      if (!raw || UNKNOWN_MESSAGE.test(raw)) return { text: "这一轮出错了：未知原因", error: true }
      // 用户打断（排队「立即发送」= 先 abort 再发）时，pi 1.3 有时把被打断的那次模型调用记成 stopReason "error"、
      // errorMessage 是 AbortSignal 的原文。这是停止，不是出错（D18：停止写"已停止生成"）
      if (ABORT_MESSAGE.test(raw)) return { text: "已停止生成", error: false }
      const kind = turnErrorKindOf(raw)
      if (kind) {
        const status = httpStatusOf(raw)
        return { text: `这一轮出错了：${TURN_ERROR_TEXT[kind]}${status != null ? `（${status}）` : ""}`, error: true, detail: detailOf(raw) }
      }
      const json = jsonBodyOf(raw)
      if (!json && !/[{[]/.test(raw) && raw.length <= TURN_ERROR_RAW_MAX) return { text: `这一轮出错了：${shorten(raw)}`, error: true }
      const said = json ? providerMessageOf(json.body) : null
      return { text: `这一轮出错了：${shorten(said ?? (/[{[]/.test(raw) ? "模型服务报错" : raw))}`, error: true, detail: detailOf(raw) }
    }
    case "aborted":
      return { text: "已停止生成", error: false }
    case "length":
      return { text: "达到长度上限，回复被截断", error: false }
    default:
      return null
  }
}
