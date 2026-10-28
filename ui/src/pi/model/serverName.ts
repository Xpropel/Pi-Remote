/**
 * P11 身份行「中转服务器名」显示规则（arch 冻结，纯函数，node --test 直载）。
 *
 * 数据来源优先级：relay 配置的可选 serverName（auth_result/healthz additive）→ window.location.hostname。
 * 铁规：身份位是中转服务器，不是用户名/账号/邮箱；relay 为空时回退 hostname（去端口），不报错、不虚构。
 */
export const SERVER_NAME_FALLBACK = "本机 relay"

function stripControl(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim()
}

/** hostname 去端口（`example.com:7002` → `example.com`）；IPv6 保留方括号内原文，纯 IP 原样。 */
export function hostnameOnlyOf(hostname: string | undefined | null): string {
  const value = stripControl(String(hostname || ""))
  if (!value) return ""
  // [::1]:7002 / [::1] / example.com:7002
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value)
  if (bracket) return bracket[1]
  const host = value.replace(/:\d+$/, "")
  return host || value
}

/** 身份行显示名：serverName 非空取它（≤64）；否则 hostname 去端口；再空用固定兜底。绝不返回用户身份。 */
export function serverDisplayName(serverName: string | undefined | null, hostname: string | undefined | null): string {
  const configured = stripControl(String(serverName || "")).slice(0, 64)
  if (configured) return configured
  return hostnameOnlyOf(hostname) || SERVER_NAME_FALLBACK
}

/** 身份行 tooltip：优先完整 relay URL（可含协议/端口），不含 token；否则显示名。 */
export function serverTooltipOf(serverName: string | undefined | null, hostname: string | undefined | null, serverUrl?: string | null): string {
  const url = stripControl(String(serverUrl || ""))
  if (url) return url
  return serverDisplayName(serverName, hostname)
}
