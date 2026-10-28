// 二维码设备链接（qr-pairing）网页侧纯逻辑测试。
// 覆盖：pair_lookup / pair_approve 帧构造、#pair= hash 解析与取码清 hash、码形规整、
// pair_lookup 回包清洗、过期判定、错误码 → 落地页处置映射（relay/pairLink.ts + relay/protocol.ts）。
// 注意：本文件不在根 package.json 的 test 列名清单里，需要登记后才会随 npm test 跑。
import test from "node:test"
import assert from "node:assert/strict"

const { pairApproveFrame, pairCreateFrame, pairLookupFrame } = await import("../ui/src/relay/protocol.ts")
const {
  isPairCodeShape,
  normalizePairCodeInput,
  pairCodeFromHash,
  pairHashHit,
  pairLinkError,
  pairLinkExpired,
  pairLinkRemainMs,
  parsePairLookup,
  takePairLinkFromLocation,
} = await import("../ui/src/relay/pairLink.ts")
const { ADMIN_TOKEN_COPY, RelayError } = await import("../ui/src/relay/devices.ts")

test("帧构造：pair_lookup 只带码，pair_approve 带码与管理员令牌，pair_create 不受影响", () => {
  assert.deepEqual(pairLookupFrame("K7Q4MX2P"), { type: "pair_lookup", code: "K7Q4MX2P" })
  assert.deepEqual(pairApproveFrame("K7Q4MX2P", "adm"), { type: "pair_approve", code: "K7Q4MX2P", adminToken: "adm" })
  assert.deepEqual(pairCreateFrame("adm"), { type: "pair_create", adminToken: "adm" })
})

test("码规整：不分大小写、忽略短横线与空格；长度/字母表不对返回空串", () => {
  assert.equal(normalizePairCodeInput("K7Q4MX2P"), "K7Q4MX2P")
  assert.equal(normalizePairCodeInput("k7q4-mx2p"), "K7Q4MX2P")
  assert.equal(normalizePairCodeInput(" K7Q4 MX2P "), "K7Q4MX2P")
  assert.equal(normalizePairCodeInput("K7Q4MX2"), "")
  assert.equal(normalizePairCodeInput("K7Q4MX2PP"), "")
  // 字母表去掉易混字符：0 / 1 / I / O 都不合法
  assert.equal(normalizePairCodeInput("K7Q4MX20"), "")
  assert.equal(normalizePairCodeInput("IIIIIIII"), "")
  assert.equal(normalizePairCodeInput(12345678), "")
  assert.equal(normalizePairCodeInput(null), "")
  assert.equal(isPairCodeShape("k7q4-mx2p"), true)
  assert.equal(isPairCodeShape("nope"), false)
})

test("hash 解析：只认 pair 键，路由 hash 不命中", () => {
  assert.equal(pairHashHit("#pair=K7Q4MX2P"), true)
  assert.equal(pairHashHit("#pair="), true)
  assert.equal(pairHashHit("#/live"), false)
  assert.equal(pairHashHit("#/pair=K7Q4MX2P"), false)
  assert.equal(pairHashHit("#other=1"), false)
  assert.equal(pairHashHit(""), false)
  assert.equal(pairHashHit("#"), false)
})

test("hash 取码：裸码直接用，带短横线/小写规整，非法值返回 null", () => {
  assert.equal(pairCodeFromHash("#pair=K7Q4MX2P"), "K7Q4MX2P")
  assert.equal(pairCodeFromHash("#pair=k7q4-mx2p"), "K7Q4MX2P")
  assert.equal(pairCodeFromHash("#pair=SHORT"), null)
  assert.equal(pairCodeFromHash("#pair="), null)
  assert.equal(pairCodeFromHash("#/live"), null)
  assert.equal(pairCodeFromHash("#x=1&pair=K7Q4MX2P"), "K7Q4MX2P")
})

test("takePairLinkFromLocation：命中即清 hash 并返回码；未命中不动 hash", () => {
  const calls = []
  const hist = { replaceState: (data, unused, url) => calls.push(url) }
  const hit = takePairLinkFromLocation({ hash: "#pair=K7Q4MX2P", pathname: "/", search: "" }, hist)
  assert.deepEqual(hit, { code: "K7Q4MX2P" })
  assert.deepEqual(calls, ["/"])

  calls.length = 0
  const empty = takePairLinkFromLocation({ hash: "#pair=", pathname: "/m", search: "?a=1" }, hist)
  assert.deepEqual(empty, { code: null })
  assert.deepEqual(calls, ["/m?a=1"])

  calls.length = 0
  const miss = takePairLinkFromLocation({ hash: "#/live", pathname: "/", search: "" }, hist)
  assert.equal(miss, null)
  assert.deepEqual(calls, [])
})

test("parsePairLookup：元数据齐全才认，name/platform 宽容缺省", () => {
  assert.deepEqual(parsePairLookup({ name: "工作站", platform: "windows", expiresAt: 123456, checkDigits: "47" }), {
    name: "工作站",
    platform: "windows",
    expiresAt: 123456,
    checkDigits: "47",
  })
  assert.deepEqual(parsePairLookup({ expiresAt: 5, checkDigits: " 09 " }), { name: "", platform: "", expiresAt: 5, checkDigits: "09" })
  for (const bad of [{ checkDigits: "47" }, { expiresAt: 5 }, { expiresAt: "5", checkDigits: "47" }, null, "x"]) {
    assert.throws(
      () => parsePairLookup(bad),
      (e) => e instanceof RelayError && e.code === "server_error",
    )
  }
})

test("过期判定：剩余 <= 0 即过期", () => {
  assert.equal(pairLinkRemainMs(1000, 400), 600)
  assert.equal(pairLinkRemainMs(1000, 1000), 0)
  assert.equal(pairLinkExpired(1000, 999), false)
  assert.equal(pairLinkExpired(1000, 1000), true)
  assert.equal(pairLinkExpired(1000, 1500), true)
})

test("错误映射：已知码给明确处置，未知码回退通用文案", () => {
  assert.equal(pairLinkError(new RelayError("pair_invalid", "配对码无效")).kind, "invalid")
  assert.equal(pairLinkError(new RelayError("pair_expired", "配对码已过期，请重新生成")).kind, "expired")
  const admin = pairLinkError(new RelayError("admin_required", "x"))
  assert.equal(admin.kind, "admin")
  assert.equal(admin.text, ADMIN_TOKEN_COPY.invalid)
  assert.equal(pairLinkError(new RelayError("device_mismatch", "x")).kind, "mismatch")
  assert.equal(pairLinkError(new RelayError("unknown_type", "x")).kind, "unsupported")
  assert.equal(pairLinkError(new RelayError("offline", "x")).kind, "offline")
  assert.equal(pairLinkError(new RelayError("result_unknown", "x")).kind, "unknown-result")
  const timeout = pairLinkError(new RelayError("timeout", "x"))
  assert.equal(timeout.kind, "generic")
  assert.equal(timeout.text, "本机没有回应，请重试")
  assert.deepEqual(pairLinkError(new Error("boom")), { kind: "generic", text: "boom" })
})
