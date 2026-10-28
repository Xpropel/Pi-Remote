// UI·relay 连接/状态正确性回归（纯函数 + 静态接线；不启动浏览器）：
//  - 全量快照防陈旧：同世代 seq 小于现值整帧忽略；
//  - 重连退避只在鉴权成功后归零（onopen 不再清零）；
//  - 别房回合种子按时间覆盖（断线期间第二回合不会被旧的「已完成」盖住）；
//  - archivesRef LRU 上限 + 登出清空。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { emptySync, eventStep, snapshotStep } from "../ui/src/relay/sync.ts"
import { emptyRoomTurnTracker, roomTurnEndsOf, seedRoomTurnEnds } from "../ui/src/relay/attention.ts"
import {
  SESSION_ARCHIVE_MAX_ENTRIES,
  rememberSessionArchive,
  touchSessionArchive,
} from "../ui/src/relay/sessionArchive.ts"
import { isViaTunnelHostname, TUNNEL_COPY } from "../ui/src/relay/devices.ts"

const relaySource = () => readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
const archiveOf = (id) => ({ id, messages: [{ id: `${id}-m1`, role: "user", text: "hi" }] })

test("全量快照防陈旧：同世代 seq 更小按 ignore；等于/更大照常 full；换世代或旧 relay 照常 full", () => {
  const sync = { room: "r", rev: "A", seq: 10 }
  assert.equal(snapshotStep(sync, { rev: "A", seq: 9 }).action, "ignore", "迟到的旧全量不能把序号/正文打回去")
  assert.deepEqual(snapshotStep(sync, { rev: "A", seq: 9 }).next, sync)
  assert.equal(snapshotStep(sync, { rev: "A", seq: 10 }).action, "full", "同一快照重发仍按全量重置")
  assert.deepEqual(snapshotStep(sync, { rev: "A", seq: 10 }).next, { room: "r", rev: "A", seq: 10 })
  assert.equal(snapshotStep(sync, { rev: "B", seq: 3 }).action, "full", "换世代（rev 变）必须以新快照重建")
  assert.deepEqual(snapshotStep(sync, { rev: "B", seq: 3 }).next, { room: "r", rev: "B", seq: 3 })
  // 旧 relay 不带 rev 或帧里没带 seq：没有世代可比，保持原口径整份接受
  assert.equal(snapshotStep(emptySync("r"), { seq: 0 }).action, "full")
  assert.equal(snapshotStep({ room: "r", rev: null, seq: 8 }, { seq: 7 }).action, "full")
  assert.equal(snapshotStep(sync, { rev: "A" }).action, "full")
})

test("增量路径不受影响：append/ignore/resync-since/resync-full 语义保持", () => {
  const sync = { room: "r", rev: "A", seq: 10 }
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 10, seq: 12 }).action, "append")
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 5, seq: 9 }).action, "ignore")
  assert.equal(snapshotStep(sync, { delta: true, rev: "A", baseSeq: 11, seq: 13 }).action, "resync-since")
  assert.equal(snapshotStep(sync, { delta: true, rev: "B", baseSeq: 10, seq: 12 }).action, "resync-full")
  assert.equal(eventStep({ room: "r", rev: "A", seq: 4 }, 5, "A").action, "apply")
})

test("重连退避：socket onopen 不再清零，鉴权成功分支才重置", () => {
  const relay = relaySource()
  const onopenAt = relay.indexOf("ws.onopen = () => {")
  assert.ok(onopenAt > 0, "onopen 必须还在")
  const onopen = relay.slice(onopenAt, relay.indexOf("function leaveRoster()", onopenAt))
  assert.doesNotMatch(onopen, /backoffRef\.current\s*=\s*1000/, "onopen 打开就清零会让失败发生在打开后退化成无限 1s 重试")

  const authAt = relay.indexOf('if (type === "auth_result") {')
  const authOk = relay.slice(authAt, relay.indexOf("const pendingResync", authAt))
  assert.match(authOk, /backoffRef\.current = 1000/, "鉴权成功（auth_result.ok）才把退避归零")
  const closeAt = relay.indexOf("ws.onclose = () => {")
  const close = relay.slice(closeAt, relay.indexOf("// onmessage 闭包里用到", closeAt))
  assert.match(close, /backoffRef\.current = Math\.min\(wait \* 2, 20000\)/, "断开仍按退避翻倍")
})

test("陈旧全量快照不置 snapshotPending：先判定 ignore 再动 pending 标记（防永久转圈）", () => {
  const relay = relaySource()
  const at = relay.indexOf('if (type === "snapshot") {')
  const branch = relay.slice(at, relay.indexOf('if (type === "room_event") {', at))
  const stepAt = branch.indexOf("snapshotStep(syncRef.current, msg)")
  const ignoreAt = branch.indexOf('if (step.action === "ignore") return')
  const pendingAt = branch.indexOf("setSnapshotPending(true)")
  assert.ok(stepAt >= 0 && ignoreAt > stepAt && pendingAt > ignoreAt, "判定顺序：step → ignore → pending")
})

test("别房回合种子：更晚的落定覆盖旧记录（错误回合不再被旧「已完成」盖住）", () => {
  let tracker = emptyRoomTurnTracker()
  tracker = seedRoomTurnEnds(tracker, [{ roomId: "r1", kind: "done", at: 1000 }], "current")
  assert.equal(roomTurnEndsOf(tracker)[0].error, false)

  // 断线期间同一房间跑完第二回合（出错）：更晚的种子必须覆盖
  const later = seedRoomTurnEnds(tracker, [{ roomId: "r1", kind: "error", at: 2000 }], "current")
  assert.notEqual(later, tracker, "覆盖必须产生新引用，归约层才会重渲染")
  assert.equal(roomTurnEndsOf(later).length, 1)
  assert.equal(roomTurnEndsOf(later)[0].error, true)
  assert.equal(roomTurnEndsOf(later)[0].at, 2000)

  // 更旧/相同时刻的种子不翻案（先到者胜，避免回放抖动）
  assert.equal(seedRoomTurnEnds(later, [{ roomId: "r1", kind: "done", at: 1500 }], "current"), later)
  assert.equal(seedRoomTurnEnds(later, [{ roomId: "r1", kind: "done", at: 2000 }], "current"), later)

  // 当前房间不种；没有实际变化时引用不变；新房间的空缺仍能种（at=0 也接受）
  assert.equal(seedRoomTurnEnds(later, [{ roomId: "current", kind: "done", at: 3000 }], "current"), later)
  assert.equal(seedRoomTurnEnds(later, [{ roomId: "r1", kind: "done", at: 900 }], "current"), later)
  const fresh = seedRoomTurnEnds(later, [{ roomId: "r2", kind: "done", at: 0 }], "current")
  assert.notEqual(fresh, later)
  assert.equal(roomTurnEndsOf(fresh).length, 2)
})

test("会话正文缓存 LRU：上限淘汰最久未读，读取刷新位置，覆盖写不涨条数", () => {
  assert.equal(SESSION_ARCHIVE_MAX_ENTRIES, 32)
  const map = new Map()
  for (let i = 0; i < 5; i += 1) rememberSessionArchive(map, `dev\\ns${i}`, archiveOf(`s${i}`), 3)
  assert.deepEqual([...map.keys()], ["dev\\ns2", "dev\\ns3", "dev\\ns4"], "只留最近 3 条")
  assert.equal(map.has("dev\\ns0"), false)

  // 读 s2 → 挪到末尾；再写一条应淘汰 s3 而不是 s2
  assert.equal(touchSessionArchive(map, "dev\\ns2")?.id, "s2")
  rememberSessionArchive(map, "dev\\ns5", archiveOf("s5"), 3)
  assert.deepEqual([...map.keys()], ["dev\\ns4", "dev\\ns2", "dev\\ns5"])
  assert.equal(touchSessionArchive(map, "dev\\nmissing"), undefined)

  // 覆盖同 key 不涨条数
  rememberSessionArchive(map, "dev\\ns2", archiveOf("s2b"), 3)
  assert.equal(map.size, 3)
  assert.equal(map.get("dev\\ns2")?.id, "s2b")

  // limit 至少 1，且 0/负数不会清空缓存
  rememberSessionArchive(map, "dev\\ns9", archiveOf("s9"), 0)
  assert.equal(map.size, 1)
  assert.equal(map.has("dev\\ns9"), true)
})

test("接线：session_archive 写入走 LRU、读取 touch、登出清空；历史窗口缓存随房间/全量快照作废", () => {
  const relay = relaySource()
  assert.match(relay, /rememberSessionArchive\(archivesRef\.current/, "写入必须走 LRU 上限")
  assert.match(relay, /touchSessionArchive\(archivesRef\.current/, "读取要刷新 LRU 位置")
  assert.match(relay, /archivesRef\.current\.clear\(\)/, "退出登录要清空正文缓存")
  assert.match(relay, /historyCacheRef\.current = null/, "全量快照/换房/清房要作废旧补拉窗口")
  assert.match(relay, /mergeHistoryWindow\(cache, room, page\)/)
  assert.match(relay, /historyCacheCovers\(cache, fromIndex\) \? historyWindowFrom\(cache, fromIndex\) : null/, "缓存覆盖时零请求切页")
  assert.doesNotMatch(relay, /fetchWindow\(probe\.total - cursor\.index \+ window\)/, "旧的整段重拉路径必须移除")
})

test("接线：退出登录连管理员令牌一并清除（UI 中-2 回归）", () => {
  const relay = relaySource()
  const start = relay.indexOf("const logout = useCallback")
  assert.notEqual(start, -1, "logout 必须存在")
  const logoutBody = relay.slice(start, relay.indexOf("/** retryKey", start))
  // setAdminToken("") 是既有 setter 的清空口径：传空即清状态并 remove ADMIN_TOKEN_STORAGE_KEY
  assert.match(logoutBody, /setAdminToken\(""\)/, "logout 必须调用 setAdminToken(\"\") 清管理员令牌（状态 + localStorage）")
  assert.match(logoutBody, /\}, \[[^\]]*setAdminToken[^\]]*\]\)/, "setAdminToken 必须进 logout 的 useCallback 依赖")
  assert.match(relay, /else safeStore\.remove\(ADMIN_TOKEN_STORAGE_KEY\)/, "setAdminToken 传空删存储键的口径不能被改掉")
})

test("经隧道判定：hostname 以 .trycloudflare.com 结尾才为真（免服务器模式 §4.3）", () => {
  assert.equal(isViaTunnelHostname("abc-def.trycloudflare.com"), true, "quick tunnel 网址应判真")
  assert.equal(isViaTunnelHostname("ABC-DEF.trycloudflare.com"), true, "大小写不敏感")
  assert.equal(isViaTunnelHostname("trycloudflare.com"), false, "裸域名（无子域）不算")
  assert.equal(isViaTunnelHostname("eviltrycloudflare.com"), false, "仿冒域名不算")
  assert.equal(isViaTunnelHostname("x.trycloudflare.com.evil.com"), false, "后缀在中间不算")
  assert.equal(isViaTunnelHostname("192.168.1.10"), false, "局域网 IP 不算")
  assert.equal(isViaTunnelHostname("pi-remote.upropel2.xyz"), false, "自有服务器域名不算")
  assert.equal(isViaTunnelHostname(""), false)
})

test("接线：useRelay 回传 isViaTunnel，PiApp 据此出示隧道徽标（免服务器模式 §4.3）", () => {
  const relay = relaySource()
  assert.match(relay, /const isViaTunnel = isViaTunnelHostname\(location\.hostname\)/, "useRelay 必须按页面源 hostname 判定")
  assert.match(relay, /\n    isViaTunnel,\n/, "isViaTunnel 必须进 useRelay 返回对象")
  const app = readFileSync(new URL("../ui/src/pi/PiApp.tsx", import.meta.url), "utf8")
  assert.match(app, /relay\.isViaTunnel/, "PiApp 必须消费 relay.isViaTunnel")
  assert.match(app, /TUNNEL_COPY\.badge/, "徽标文案必须走 TUNNEL_COPY")
  assert.equal(TUNNEL_COPY.badge, "经 Cloudflare 隧道连接")
  const fake = readFileSync(new URL("../ui/src/pi/dev/fakeRelay.ts", import.meta.url), "utf8")
  assert.match(fake, /isViaTunnel: false/, "假 relay 默认值必须补 isViaTunnel（类型闸门）")
})
