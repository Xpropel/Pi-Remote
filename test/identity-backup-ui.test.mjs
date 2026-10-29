// Viewer identity settings surface (design A phase 2): passphrase backup
// package roundtrip + failure modes, identity state shaping branches, and
// the mandatory honesty copy (unrecoverable-history warning, revoke notice).
import test from "node:test"
import assert from "node:assert/strict"
import {
  ackFingerprintOf,
  createIdentityBackup,
  openIdentityBackup,
  parseIdentityBackup,
  serializeIdentityBackup,
  IdentityBackupError,
  BACKUP_PBKDF2_MIN_ITERATIONS,
} from "../ui/src/pi/settings/pages/identityBackup.ts"
import {
  authorizedViewerRowOf,
  authorizedViewerRowsOf,
  backupStatusTextOf,
  formatFingerprintText,
  identityStateViewOf,
  isSelfViewerRow,
  viewerStatusTextOf,
  IDENTITY_PHASE_NOTE,
  IDENTITY_UNRECOVERABLE_WARNING,
  IDENTITY_WAITING_ACK_TEXT,
  VIEWER_REVOKE_ACK_NOTICE,
} from "../ui/src/pi/settings/pages/identityLogic.ts"

const FAST = { iterations: BACKUP_PBKDF2_MIN_ITERATIONS }

function randomAck() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

async function makePackage(passphrase = "correct horse battery") {
  const ack = randomAck()
  const pkg = await createIdentityBackup({
    ack,
    passphrase,
    meta: { accountId: "acct-1", viewerId: "viewer-1" },
    now: 1761715200000,
    ...FAST,
  })
  return { ack, pkg }
}

test("backup package: create -> serialize -> parse -> open roundtrip", async () => {
  const { ack, pkg } = await makePackage()
  assert.equal(pkg.app, "pi-remote")
  assert.equal(pkg.kind, "identity-backup")
  assert.equal(pkg.kdf.iterations, BACKUP_PBKDF2_MIN_ITERATIONS)
  assert.equal(pkg.ackFp, await ackFingerprintOf(ack))
  assert.match(pkg.ackFp, /^[0-9a-f]{16}$/)

  const parsed = parseIdentityBackup(serializeIdentityBackup(pkg))
  assert.deepEqual(parsed, pkg)

  const opened = await openIdentityBackup(parsed, "correct horse battery")
  assert.deepEqual(opened.ack, ack)
  assert.equal(opened.ackFp, pkg.ackFp)
  assert.equal(opened.accountId, "acct-1")
  assert.equal(opened.viewerId, "viewer-1")
})

test("backup package: wrong passphrase fails cleanly with open_failed", async () => {
  const { pkg } = await makePackage()
  await assert.rejects(openIdentityBackup(pkg, "wrong passphrase entirely"), (error) => {
    assert.ok(error instanceof IdentityBackupError)
    assert.equal(error.code, "open_failed")
    return true
  })
})

test("backup package: tampered ciphertext fails with open_failed", async () => {
  const { pkg } = await makePackage()
  const tampered = { ...pkg, ct: (pkg.ct.startsWith("A") ? "B" : "A") + pkg.ct.slice(1) }
  await assert.rejects(openIdentityBackup(tampered, "correct horse battery"), (error) => {
    assert.ok(error instanceof IdentityBackupError)
    assert.equal(error.code, "open_failed")
    return true
  })
})

test("backup package: parse rejects bad files with typed errors", () => {
  assert.throws(() => parseIdentityBackup("not json"), (e) => e instanceof IdentityBackupError && e.code === "bad_format")
  assert.throws(
    () => parseIdentityBackup(JSON.stringify({ app: "pi-remote", kind: "something-else", v: 1 })),
    (e) => e instanceof IdentityBackupError && e.code === "bad_format",
  )
})

test("backup package: parse rejects unsupported version and absurd KDF params", async () => {
  const { pkg } = await makePackage()
  assert.throws(
    () => parseIdentityBackup(serializeIdentityBackup({ ...pkg, v: 99 })),
    (e) => e instanceof IdentityBackupError && e.code === "unsupported_version",
  )
  assert.throws(
    () => parseIdentityBackup(serializeIdentityBackup({ ...pkg, kdf: { ...pkg.kdf, iterations: 10 } })),
    (e) => e instanceof IdentityBackupError && e.code === "bad_params",
  )
})

test("backup package: weak passphrase and wrong-size ACK are refused at creation", async () => {
  await assert.rejects(createIdentityBackup({ ack: randomAck(), passphrase: "short", ...FAST }), (e) => {
    assert.ok(e instanceof IdentityBackupError)
    assert.equal(e.code, "weak_passphrase")
    return true
  })
  await assert.rejects(createIdentityBackup({ ack: new Uint8Array(16), passphrase: "long enough passphrase", ...FAST }), (e) => {
    assert.ok(e instanceof IdentityBackupError)
    assert.equal(e.code, "bad_ack")
    return true
  })
})

test("identity state shaping: none / waiting-ack / ready branches", () => {
  assert.equal(identityStateViewOf(null).phase, "none")
  assert.equal(identityStateViewOf({}).phase, "none")
  assert.equal(identityStateViewOf("garbage").phase, "none")

  const waiting = identityStateViewOf({ viewerId: "v-1", keyFp: "3f9ac41d77b002e5" })
  assert.equal(waiting.phase, "waiting-ack")
  assert.equal(waiting.viewerId, "v-1")
  assert.equal(waiting.ackFp, null)

  const ready = identityStateViewOf({ viewerId: "v-1", ackFp: "aaaaaaaabbbbbbbb", backedUpAt: 1761715200000 })
  assert.equal(ready.phase, "ready")
  assert.equal(ready.backedUp, true)
  assert.equal(ready.backedUpAt, 1761715200000)
})

test("identity state shaping: backup status text follows the phase", () => {
  const notBackedUp = identityStateViewOf({ viewerId: "v-1", ackFp: "aaaaaaaabbbbbbbb" })
  assert.match(backupStatusTextOf(notBackedUp), /尚未备份/)
  const backedUp = identityStateViewOf({ viewerId: "v-1", ackFp: "aaaaaaaabbbbbbbb", backedUp: true })
  assert.match(backupStatusTextOf(backedUp), /已建口令备份/)
  const waiting = identityStateViewOf({ viewerId: "v-1" })
  assert.equal(backupStatusTextOf(waiting), "")
})

test("authorized viewers: row shaping, wrapping shapes, revoked sorting", () => {
  const rows = authorizedViewerRowsOf({
    viewers: [
      { viewerId: "v-old", name: "旧浏览器", createdAt: 1000, revokedAt: 2000 },
      { viewerId: "v-admin", name: "主浏览器", admin: true, createdAt: 3000, signFp: "3f9ac41d77b002e5" },
      { name: "没有 id 的行" },
      { viewerId: "v-plain", createdAt: 2500 },
    ],
  })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].viewerId, "v-admin")
  assert.equal(rows[0].admin, true)
  assert.equal(rows[0].keyFp, "3f9ac41d77b002e5")
  assert.equal(rows[1].viewerId, "v-plain")
  assert.equal(rows[1].name, "v-plain")
  assert.equal(rows[2].viewerId, "v-old")
  assert.equal(rows[2].revoked, true)

  assert.deepEqual(authorizedViewerRowsOf([{ viewerId: "v-1" }]).length, 1)
  assert.deepEqual(authorizedViewerRowsOf(null), [])
  assert.equal(authorizedViewerRowOf({ name: "无 id" }), null)
})

test("authorized viewers: status text and self detection", () => {
  const now = 1761715200000
  const admin = authorizedViewerRowOf({ viewerId: "v-1", admin: true, createdAt: now - 60_000 })
  assert.match(viewerStatusTextOf(admin, now), /可管理/)
  assert.match(viewerStatusTextOf(admin, now), /登记于/)
  const revoked = authorizedViewerRowOf({ viewerId: "v-2", revokedAt: now - 1000 })
  assert.match(viewerStatusTextOf(revoked, now), /已撤销/)

  const view = identityStateViewOf({ viewerId: "v-1" })
  assert.equal(isSelfViewerRow(admin, view), true)
  assert.equal(isSelfViewerRow(revoked, view), false)
})

test("fingerprint display groups hex in fours and dashes when missing", () => {
  assert.equal(formatFingerprintText("3F9AC41D77B002E5"), "3f9a c41d 77b0 02e5")
  assert.equal(formatFingerprintText(null), "—")
  assert.equal(formatFingerprintText(""), "—")
  assert.equal(formatFingerprintText("not-hex"), "not-hex")
})

test("mandatory honesty copy: unrecoverable-history warning is not softened", () => {
  assert.match(IDENTITY_UNRECOVERABLE_WARNING, /永久无法恢复/)
  assert.match(IDENTITY_UNRECOVERABLE_WARNING, /管理员令牌都救不回来/)
  assert.match(IDENTITY_UNRECOVERABLE_WARNING, /解不开内容钥/)
  assert.match(IDENTITY_UNRECOVERABLE_WARNING, /口令备份/)
})

test("mandatory honesty copy: revoke notice admits the ACK copy stays valid", () => {
  assert.match(VIEWER_REVOKE_ACK_NOTICE, /不会失效/)
  assert.match(VIEWER_REVOKE_ACK_NOTICE, /轮换/)
  assert.match(VIEWER_REVOKE_ACK_NOTICE, /不会假装/)
})

test("mandatory honesty copy: waiting state and phase note stay truthful", () => {
  assert.match(IDENTITY_WAITING_ACK_TEXT, /内容钥（ACK）/)
  assert.match(IDENTITY_PHASE_NOTE, /仍未加密/)
  assert.match(IDENTITY_PHASE_NOTE, /不要据此认为内容已被加密/)
})
