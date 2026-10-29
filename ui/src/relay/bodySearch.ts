/**
 * 正文搜索按房间并发（P8 8.1b；编排 10-25 22:20 决定，F-R6 的延伸）：目标选择和结果合并的纯函数，不依赖 React / DOM。
 * - 为什么：扩展只扫回答它的那个 pi 所在项目的会话目录（pi 的会话目录按 cwd 分，extension cmdSearchSessionBodies）；
 *   按 deviceId 寻址时 relay 只交给这台设备最后上线的那个房间（relay/viewer.js routeDeviceCommand）。
 *   同一台设备开着几个项目时，原来只有一个项目的会话能被搜到。
 * - 做法：这台设备的在线房间按 cwd 分组，每组选一个房间，按房间寻址发 search_session_bodies（relay 的房间命令原样转发）；
 *   结果按会话文件路径合并、去重；有房间超时或失败，结果带 unanswered（「部分结果」，写明是哪个项目）；
 *   全部失败按第一个失败报错；这台设备没有在线房间时，才退回按设备寻址。
 * - 没跑 pi 的项目仍然搜不到：要扩展扫全设备的会话目录（R2/protocol-followups.md F-R6）。
 * - relay 收到房间命令会刷新那个房间的 lastActivity（relay/rooms.js touch）。每组选组里最近活动的房间（打开的房间优先），
 *   所以侧栏组内的顺序不会因为搜索而变；被搜到的房间行尾时间会跟着刷新（同原来按设备寻址时的那一个房间）。
 */
import { bodySearchPageOf, type BodySearchHit, type BodySearchPage, type BodySearchUnanswered } from "../shell/searchModel.ts"
import { errorCode, RelayError, roomDeviceId, type RoomInfo } from "./devices.ts"

export type BodySearchRoom = Pick<RoomInfo, "id" | "online" | "deviceId" | "cwd" | "lastActivity" | "enc">

/** 按房间发（一个 cwd 一个房间），或按设备发（这台设备没有在线房间时的退路） */
export type BodySearchTarget =
  | { kind: "room"; roomId: string; cwd: string; enc?: boolean }
  | { kind: "device"; deviceId: string }

/** 一个目标的回包：allSettled 的结果配上目标 */
export type BodySearchReply = { target: BodySearchTarget; ok: true; data: unknown } | { target: BodySearchTarget; ok: false; error: unknown }

/** cwd 的分组键：只统一斜杠和末尾的斜杠，大小写照原样（pi 的会话目录按 cwd 原文算，大小写不同就是两个目录） */
function cwdKey(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** 同一组里要不要换成 room：打开的房间优先；否则取最近活动的（相同时取列表里更靠后的，同 devices.ts pickEntryRoom） */
function preferred(room: BodySearchRoom, pick: BodySearchRoom, openRoomId: string | null): boolean {
  if (pick.id === openRoomId) return false
  if (room.id === openRoomId) return true
  return (room.lastActivity || 0) >= (pick.lastActivity || 0)
}

/**
 * 选目标：这台设备（roomDeviceId 同侧栏的归属口径）的在线房间，每个 cwd 选一个；没有 cwd 的房间（旧扩展）不知道扫哪个目录，各算一个。
 * 顺序：打开的房间那一组在前，其余按最近活动新到旧（合并时同一会话文件以先到的为准，见 mergeBodySearchReplies）。
 * 一个在线房间都没有时只回一个按设备寻址的目标。
 */
export function bodySearchTargetsOf(deviceId: string, rooms: readonly BodySearchRoom[], openRoomId: string | null = null): BodySearchTarget[] {
  const picks = new Map<string, BodySearchRoom>()
  for (const room of rooms) {
    if (!room.online || roomDeviceId(room) !== deviceId) continue
    const key = room.cwd ? `cwd:${cwdKey(room.cwd)}` : `room:${room.id}`
    const pick = picks.get(key)
    if (!pick || preferred(room, pick, openRoomId)) picks.set(key, room)
  }
  if (!picks.size) return [{ kind: "device", deviceId }]
  return [...picks.values()]
    .sort((a, b) => Number(b.id === openRoomId) - Number(a.id === openRoomId) || (b.lastActivity || 0) - (a.lastActivity || 0))
    .map((room): BodySearchTarget => ({ kind: "room", roomId: room.id, cwd: room.cwd ?? "", ...(room.enc !== undefined ? { enc: room.enc } : {}) }))
}

const BAD_REPLY = "正文搜索回包形状不对，请重试"

/**
 * 合并各房间的回包。
 * - 每个回包先用 bodySearchPageOf 归一，形状不对的按这个目标失败算（bad_reply），不硬撑。
 * - 去重按会话文件路径（斜杠统一，大小写照原样）：同一个文件被两个目标回了，留命中条数多的，一样多留 mtime 新的，再一样留先到的。
 * - 排序按 mtime 新到旧（每个扩展自己也是这样排的），一样时命中条数多的在前。
 * - truncated：任一页没扫完就算；已扫 / 总数是各页之和。
 * - 有目标失败、也有成功的：page.unanswered 记下失败目标的 cwd 和错误码（呈现层写「部分结果」）。
 * - 全部失败：返回第一个失败的原错误（保留协议码，SearchContainer 按码出离线 / 超时等文案）。
 */
export function mergeBodySearchReplies(
  query: string,
  replies: readonly BodySearchReply[],
): { ok: true; page: BodySearchPage } | { ok: false; error: unknown } {
  const pages: BodySearchPage[] = []
  const unanswered: BodySearchUnanswered[] = []
  let firstError: unknown = null
  let encFailures = 0
  for (const reply of replies) {
    const cwd = reply.target.kind === "room" ? reply.target.cwd : ""
    const page = reply.ok ? bodySearchPageOf(reply.data) : null
    if (page) {
      pages.push(page)
      continue
    }
    const error = reply.ok ? new RelayError("bad_reply", BAD_REPLY) : reply.error
    // An enc room's extension refuses body search with "unsupported"
    // because the ciphertext cannot be searched in the relay path
    // (crypto Phase 3, design 4.1 t). Rewrite that one case to the
    // dedicated "encrypted" code so the UI can say the room is
    // encrypted instead of claiming the extension is too old.
    const encUnsupported =
      reply.target.kind === "room" && reply.target.enc === true && errorCode(error) === "unsupported"
    if (firstError === null) firstError = error ?? new RelayError("result_unknown", "命令没有回应")
    unanswered.push({ cwd, code: encUnsupported ? "encrypted" : errorCode(error) || (reply.ok ? "bad_reply" : "") })
    if (encUnsupported) encFailures += 1
  }
  if (!pages.length) {
    // Every target was an enc room refusing search: the honest headline
    // is "encrypted", not the first target's raw unsupported error.
    if (encFailures > 0 && encFailures === replies.length) {
      return { ok: false, error: new RelayError("encrypted", "该房间已加密，无法在中转侧搜索") }
    }
    return { ok: false, error: firstError ?? new RelayError("bad_reply", BAD_REPLY) }
  }
  const byPath = new Map<string, BodySearchHit>()
  for (const page of pages) {
    for (const hit of page.results) {
      const key = hit.session.replace(/\\/g, "/")
      const seen = byPath.get(key)
      if (!seen || hit.matchCount > seen.matchCount || (hit.matchCount === seen.matchCount && hit.mtime > seen.mtime)) byPath.set(key, hit)
    }
  }
  const merged: BodySearchPage = {
    query,
    results: [...byPath.values()].sort((a, b) => b.mtime - a.mtime || b.matchCount - a.matchCount),
    truncated: pages.some((page) => page.truncated),
    scannedFiles: pages.reduce((sum, page) => sum + page.scannedFiles, 0),
    totalFiles: pages.reduce((sum, page) => sum + page.totalFiles, 0),
  }
  if (unanswered.length) merged.unanswered = unanswered
  return { ok: true, page: merged }
}
