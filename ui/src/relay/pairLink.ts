/**
 * 二维码设备链接的纯逻辑（设计：findings/qr-pairing-design.md §3.2 落地流程、§5 安全、§6 兜底）。
 *
 * 流程：pi 运行端 `attach --link` 出示二维码，内容是 `<viewer 源>/#pair=<裸码>`；手机扫码打开本页，
 * SPA 启动时在这里取走码并立即清掉 hash，进入「设备链接确认」落地视图（pi/PairLinkLanding.tsx）：
 * pair_lookup 查待链接设备元数据 → 管理员核对设备名 / 平台 / 核对字 → pair_approve 才核销签发。
 * 码仍是 relay 同一张一次性配对码表：10 分钟、一次性、失败按来源限速；本模块只管网页侧的
 * hash 解析、码形校验、lookup 回包清洗、过期判定与错误码 → 落地页处置，不依赖 React。
 * 带副作用的只有 takePairLinkFromLocation（读 location、replaceState 清 hash）。
 */
import { ADMIN_TOKEN_COPY, RelayError, deviceErrorText, errorCode } from "./devices.ts"

/** 与 protocol/v4.json limits 同口径：8 位、字母表去掉易混字符（relay/pairing.js 生成与规整的同一套）。 */
export const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
export const PAIR_CODE_LENGTH = 8

/**
 * 用户侧的码规整（与 relay/pairing.js normalizePairCode 同口径）：不分大小写，忽略空格、短横线
 * 与其余分隔符；长度或字符不对返回空串。扫码得到的裸码、手输的 XXXX-XXXX 都走这一条。
 */
export function normalizePairCodeInput(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "")
  return s.length === PAIR_CODE_LENGTH && [...s].every((ch) => PAIR_CODE_ALPHABET.includes(ch)) ? s : ""
}

/** 形对不对（8 位、字母表内）。落地页手输框提交前先过这一关，不把明知不对的码发给 relay 记限速账。 */
export function isPairCodeShape(raw: unknown): boolean {
  return normalizePairCodeInput(raw) !== ""
}

/** hash 里 pair 键的值（未规整）；没有 pair 键返回 null。hash 形如 "#pair=K7Q4MX2P"（也可能是 "#/live" 这类路由，一律不命中）。 */
function pairParamOf(hash: string): string | null {
  const body = (hash || "").replace(/^#/, "")
  if (!body) return null
  for (const part of body.split("&")) {
    const eq = part.indexOf("=")
    if (eq < 0 || part.slice(0, eq) !== "pair") continue
    let value = part.slice(eq + 1)
    try {
      value = decodeURIComponent(value)
    } catch {
      /* 解码不了就按原文走规整，反正过不了码形校验 */
    }
    return value
  }
  return null
}

/** hash 里有没有 pair 键（哪怕值为空 / 非法）：有就进落地视图（手输兜底），没有就当普通打开。 */
export function pairHashHit(hash: string): boolean {
  return pairParamOf(hash) !== null
}

/** 从 location.hash 取配对码（规整后的裸码）；没有 pair 键、或值过不了码形校验，返回 null。 */
export function pairCodeFromHash(hash: string): string | null {
  const raw = pairParamOf(hash)
  if (raw === null) return null
  return normalizePairCodeInput(raw) || null
}

/** 落地入口：code = 扫码带来的码；code 为 null = 命中了 pair 键但码不可用，进视图先手输。 */
export type PairLinkEntry = { code: string | null }

type LocationLike = { hash: string; pathname: string; search: string }
type HistoryLike = { replaceState: (data: unknown, unused: string, url?: string | null) => void }

let takenEntry: PairLinkEntry | null | undefined

function readPairLink(loc: LocationLike, hist: HistoryLike | null): PairLinkEntry | null {
  if (!pairHashHit(loc.hash || "")) return null
  const code = pairCodeFromHash(loc.hash || "")
  // 码在 fragment 里本就不发往服务器；再立刻清掉 hash，缩短它在地址栏 / 浏览器历史里的停留时间。
  if (hist) {
    try {
      hist.replaceState(null, "", loc.pathname + loc.search)
    } catch {
      /* 清不掉也不挡流程：码一次性、10 分钟过期 */
    }
  }
  return { code }
}

/**
 * SPA 启动时取一次链接入口。无参调用（产品路径）只取一次并记住结果：
 * StrictMode 双跑、组件重挂都拿同一份，不会第二次读到已清掉的 hash 而丢码。
 * 测试可显式传假的 location / history，此时不走记忆、也不碰真实 window。
 */
export function takePairLinkFromLocation(loc?: LocationLike, hist?: HistoryLike): PairLinkEntry | null {
  if (!loc && takenEntry !== undefined) return takenEntry
  const l = loc ?? (typeof window !== "undefined" ? window.location : null)
  const h = hist ?? (typeof window !== "undefined" ? window.history : null)
  const result = l ? readPairLink(l, h) : null
  if (!loc) takenEntry = result
  return result
}

/** pair_lookup 回包：只有非秘密元数据；checkDigits 是 relay 下发的 2 位核对字，页面只显示、不计算。 */
export type PairLookupInfo = {
  name: string
  platform: string
  expiresAt: number
  checkDigits: string
}

/** lookup 回包清洗：expiresAt 与 checkDigits 缺一不可（缺了没法倒计时 / 没法核对），其余字段宽容缺省。 */
export function parsePairLookup(data: unknown): PairLookupInfo {
  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
  const expiresAt = typeof rec.expiresAt === "number" && Number.isFinite(rec.expiresAt) ? rec.expiresAt : 0
  const checkDigits = typeof rec.checkDigits === "string" ? rec.checkDigits.trim() : ""
  if (!expiresAt || !checkDigits) throw new RelayError("server_error", "服务端回包不完整，请重试")
  return {
    name: typeof rec.name === "string" ? rec.name : "",
    platform: typeof rec.platform === "string" ? rec.platform : "",
    expiresAt,
    checkDigits,
  }
}

/** 剩余毫秒（可为负）。倒计时文案用 devices.ts 的 pairRemainText，这里只管判定。 */
export function pairLinkRemainMs(expiresAt: number, now: number): number {
  return expiresAt - now
}

/** 到期判定：剩余 <= 0 即过期（与 PiDevicePairing 里 pair.expiresAt - now <= 0 同口径）。 */
export function pairLinkExpired(expiresAt: number, now: number): boolean {
  return pairLinkRemainMs(expiresAt, now) <= 0
}

/**
 * 落地页的错误处置：kind 决定页面怎么走（invalid / expired 换整页态、admin 回到令牌输入、
 * unknown-result 引导去设备列表确认），text 是给人看的文案。错误码与 protocol/v4.json 的 errors 对齐。
 */
export type PairLinkErrorKind = "invalid" | "expired" | "admin" | "mismatch" | "unsupported" | "offline" | "unknown-result" | "generic"

export function pairLinkError(error: unknown): { kind: PairLinkErrorKind; text: string } {
  switch (errorCode(error)) {
    case "pair_invalid":
      return { kind: "invalid", text: "这个链接无效或已经被用过了" }
    case "pair_expired":
      return { kind: "expired", text: "这个链接已过期" }
    case "admin_required":
      return { kind: "admin", text: ADMIN_TOKEN_COPY.invalid }
    case "device_mismatch":
      return { kind: "mismatch", text: "设备身份与原来的令牌对不上，链接已取消" }
    case "unknown_type":
      return { kind: "unsupported", text: "这个服务端还不支持扫码链接（版本太旧），请升级 relay，或在电脑上用手输配对码的方式链接" }
    case "offline":
      return { kind: "offline", text: "连接已断开，请检查网络后重试" }
    case "result_unknown":
      return { kind: "unknown-result", text: "没收到服务端的确认，链接可能已经成功了，请到设备列表里确认" }
    default:
      return { kind: "generic", text: deviceErrorText(error) }
  }
}
