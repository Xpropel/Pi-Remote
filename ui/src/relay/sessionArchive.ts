import type { Item } from "./transcript"

export type ArchiveMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp?: number
  /**
   * Crypto Phase 3: the text arrived sealed as an ACK-level envelope
   * (enc:1 + ct, plaintext is the UTF-8 text). useRelay decrypts these
   * on arrival and only ever stores the decrypted form in the cache.
   */
  enc?: number
  ct?: string
}

export type ArchiveSession = {
  id: string
  cwd?: string
  name?: string | null
  firstMessage?: string | null
  messageCount?: number
  truncated?: boolean
  omitted?: number
  messages: ArchiveMessage[]
  /**
   * Crypto Phase 3: whole-payload sealed form -- enc:1 + ct whose
   * plaintext (ACK key) is the JSON of { messages } (or a bare message
   * array). Decrypted on arrival in useRelay; the cached copy is the
   * decrypted session, never the blob.
   */
  enc?: number
  ct?: string
}

export type SessionArchiveView = {
  items: Item[]
  truncated: boolean
  omitted: number
  total: number
}

/** 把本机读到的会话正文变成现有消息流能渲染的条目。 */
export function archiveToItems(messages: ArchiveMessage[]): Item[] {
  const items: Item[] = []
  for (const message of messages) {
    const text = typeof message.text === "string" ? message.text : ""
    if (!text.trim()) continue
    const key = `archive-${message.id || items.length}`
    if (message.role === "user") {
      items.push({ kind: "user", key, text, images: [], timestamp: message.timestamp })
    } else if (message.role === "assistant") {
      items.push({
        kind: "assistant",
        key,
        blocks: [{ kind: "text", text }],
        timestamp: message.timestamp,
      })
    }
  }
  return items
}

export function archiveView(session: ArchiveSession | undefined): SessionArchiveView | null {
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) return null
  const items = archiveToItems(session.messages)
  if (!items.length) return null
  return {
    items,
    truncated: session.truncated === true,
    omitted: Number(session.omitted) || 0,
    total: Number(session.messageCount) || items.length,
  }
}

/* ── 会话正文缓存（UI·relay 中-4：只进不出） ─────────────────────────────────
 * 键是 `${deviceId}\n${sessionId}`（与 useRelay 的 archivesRef 一致）。Map 的插入顺序即
 * LRU 顺序：读取时 touch 到末尾，写入时也挪到末尾，超过上限从最旧开始淘汰。
 * 这样长寿命页面不会因为点开过很多未载入会话而单调涨内存。 */

/** 最多保留的会话正文条数（每条约 200KB 上限，32 条 ≈ 数 MB 量级）。 */
export const SESSION_ARCHIVE_MAX_ENTRIES = 32

/** 写入并维护 LRU 上限；返回被淘汰的键（便于调用方统一失效/打日志）。 */
export function rememberSessionArchive(
  map: Map<string, ArchiveSession>,
  key: string,
  session: ArchiveSession,
  limit = SESSION_ARCHIVE_MAX_ENTRIES,
): string[] {
  map.delete(key)
  map.set(key, session)
  const evicted: string[] = []
  const max = Math.max(1, Math.trunc(limit))
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined
    if (oldest === undefined) break
    map.delete(oldest)
    evicted.push(oldest)
  }
  return evicted
}

/** 读取并把命中的键挪到 LRU 末尾；未命中返回 undefined。 */
export function touchSessionArchive(map: Map<string, ArchiveSession>, key: string): ArchiveSession | undefined {
  const session = map.get(key)
  if (!session) return undefined
  map.delete(key)
  map.set(key, session)
  return session
}
