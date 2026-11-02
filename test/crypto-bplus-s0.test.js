// (b+) S-0: protocol registration + relay dumb pipe for sealed dialog text
// (crypto.dialog). No producer seals yet -- these tests feed hand-built
// sealed frames through a real relay and pin: (a) sealed fields round-trip
// verbatim to cap-holding connections, (b) plaintext frames behave exactly
// as before on every surface, (c) capability negotiation with and without
// crypto.dialog never breaks, and no-cap connections only ever receive the
// downgrade form (no text envelopes, no sealed titles, no answerable).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { RELAY_CAPS, parseHello } = require("../relay/wire.js");
const { InboxStore } = require("../relay/inbox.js");
const proto = require("../protocol/v4.json");

const LOCAL_TOKEN = "bplus-s0-local-token";
const VIEWER_TOKEN = "bplus-s0-viewer-token";
const ROOM = "room-bplus-1";
const ROOM2 = "room-bplus-2";

const FULL_CAPS = ["err.v4", "msg.cid", "dialog.respond", "dialog.multiselect", "room.dialogs", "room.inbox", "crypto.dialog"];
const NOCAP_CAPS = ["err.v4", "msg.cid", "dialog.respond", "dialog.multiselect", "room.dialogs", "room.inbox"];
const READONLY_CAPS = ["err.v4", "room.dialogs", "room.inbox", "crypto.dialog"];

const TEXT_ENC = { enc: 1, ct: "BPLUS-TEXT-CT-0001" };
const TITLE_ENC = { enc: 1, ct: "BPLUS-TITLE-CT-0001" };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-bplus-s0-"));
}

function boot(overrides = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true,
    ...overrides,
  });
}

/** Frame-collecting client (same pattern as relay-waiting.test.js). */
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout waiting for ${what}; got: ${frames.map((f) => f.type).join(",")}`));
        }, ms) };
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      ws.terminate();
    },
  };
  return api;
}

async function extensionRoom(relay, roomId) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId } });
  await c.type("room_registered");
  return c;
}

async function viewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const hello = { type: "auth", role: "viewer", token: VIEWER_TOKEN };
  if (Array.isArray(caps)) hello.caps = caps;
  v.send(hello);
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return { v, auth };
}

const sealedOpen = (dialogId, extra = {}) => ({
  type: "dialog_open",
  dialogId,
  kind: "select",
  startedAt: 4242,
  timeout: 120000,
  answerable: true,
  optionsTotal: 2,
  textEnc: TEXT_ENC,
  titleEnc: TITLE_ENC,
  ...extra,
});

const isOpenFor = (id) => (f) => f.type === "room_event" && f.event && f.event.type === "dialog_open" && f.event.dialogId === id;
const waitingFor = (room, id) => (f) => f.type === "room_waiting" && f.room === room && Array.isArray(f.waiting) && f.waiting.some((w) => w.dialogId === id);
const inboxUpsertFor = (key) => (f) => f.type === "inbox_update" && (f.upserts || []).some((e) => e.key === key);

/* ---------- 1) protocol registration & negotiation ---------- */

test("protocol: crypto.dialog cap, limits, RELAY_CAPS, hello filtering", () => {
  assert.equal(typeof proto.caps["crypto.dialog"], "string");
  assert.ok(proto.caps["crypto.dialog"].length > 0);
  assert.equal(proto.limits.dialogTextEncMax, 12288);
  assert.equal(proto.limits.dialogTitleEncMax, 1024);
  assert.equal(proto.limits.extNotifyEncMax, 12288);
  assert.equal(proto.limits.inboxTitleEncMax, 1024);
  assert.ok(RELAY_CAPS.includes("crypto.dialog"), "relay advertises crypto.dialog once the pipe exists");
  // Negotiation: the cap survives hello filtering when declared, and a hello
  // without it parses exactly as before (nothing explodes either way).
  assert.ok(parseHello({ proto: 4, caps: ["crypto.dialog"] }).caps.has("crypto.dialog"));
  assert.ok(!parseHello({ proto: 4, caps: ["dialog.respond"] }).caps.has("crypto.dialog"));
  assert.ok(!parseHello({ proto: 4 }).caps.has("crypto.dialog"));
});

test("inbox ledger: titleEnc whitelisted for dialog and ask entries, capped, round-trips", () => {
  const dir = tmpDir();
  const store = new InboxStore(dir);
  const r = store.upsert({
    key: "dialog:dlg-x", accountId: "default", roomId: "r1", deviceId: null,
    kind: "waiting", subkind: "dialog", dialogKind: "select",
    titleEnc: "BPLUS-LEDGER-CT", answerable: true, at: 1000,
  });
  assert.ok(r && r.entry.titleEnc === "BPLUS-LEDGER-CT");
  assert.ok(!("title" in r.entry), "sealed entry carries no plaintext title field");
  const snap = store.snapshot();
  assert.equal(snap[0].titleEnc, "BPLUS-LEDGER-CT");
  // On disk: the sealed title is what persists, verbatim.
  const accDir = fs.readdirSync(path.join(dir)).length ? dir : dir;
  const file = path.join(dir, fs.readdirSync(dir)[0], "inbox.json");
  assert.ok(fs.readFileSync(file, "utf8").includes("BPLUS-LEDGER-CT"));
  assert.ok(accDir);
  // The ask subkind (entry point exists, no producer yet) reserves the same
  // sealed carriage so a future producer cannot write plaintext titles.
  const ask = store.upsertAsk({
    key: "ask:a1", accountId: "default", roomId: "r1", deviceId: null,
    titleEnc: "BPLUS-ASK-CT", at: 2000,
  });
  assert.ok(ask && ask.entry.titleEnc === "BPLUS-ASK-CT");
  assert.ok(!("title" in ask.entry));
  // Overlong ct is truncated to the whitelist cap (same capStr discipline as
  // the plaintext title), never stored unbounded.
  const long = store.upsert({
    key: "dialog:dlg-y", accountId: "default", roomId: "r1", deviceId: null,
    kind: "waiting", subkind: "dialog", dialogKind: "confirm",
    titleEnc: "x".repeat(1025), at: 3000,
  });
  assert.ok(long && long.entry.titleEnc.length === 1024);
});

/* ---------- 2) sealed round-trip + downgrade ---------- */

test("sealed dialog_open: verbatim to crypto.dialog viewers, downgrade card to others, verbatim resend", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  const nocap = await viewer(relay, NOCAP_CAPS);
  t.after(() => nocap.v.close());
  const readonly = await viewer(relay, READONLY_CAPS);
  t.after(() => readonly.v.close());
  // The relay advertises the new cap in auth_result.
  assert.ok(full.auth.caps.includes("crypto.dialog"));
  for (const { v } of [full, nocap, readonly]) v.send({ type: "subscribe", room: ROOM });
  await full.v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: sealedOpen("dlg-s1") });

  // Full viewer: envelopes byte-identical, answerable kept.
  const fFull = await full.v.wait(isOpenFor("dlg-s1"), 3000, "sealed open (full)");
  assert.deepEqual(fFull.event.textEnc, TEXT_ENC);
  assert.deepEqual(fFull.event.titleEnc, TITLE_ENC);
  assert.equal(fFull.event.answerable, true);
  assert.equal(fFull.event.optionsTotal, 2);

  // Read-only crypto.dialog viewer (no dialog.respond): envelopes kept,
  // answerable stripped -- it may read the sealed card but not answer it.
  const fRo = await readonly.v.wait(isOpenFor("dlg-s1"), 3000, "sealed open (readonly)");
  assert.deepEqual(fRo.event.textEnc, TEXT_ENC);
  assert.ok(!("answerable" in fRo.event));

  // No-cap viewer: downgrade card -- structural fields only.
  const fNo = await nocap.v.wait(isOpenFor("dlg-s1"), 3000, "sealed open (nocap)");
  assert.equal(fNo.event.kind, "select");
  assert.equal(fNo.event.dialogId, "dlg-s1");
  assert.ok(!("textEnc" in fNo.event), "downgrade card must not carry textEnc");
  assert.ok(!("titleEnc" in fNo.event), "downgrade card must not carry titleEnc");
  assert.ok(!("answerable" in fNo.event), "downgrade card must not carry answerable");
  assert.ok(!JSON.stringify(fNo).includes("BPLUS"), "no sealed bytes leak to a no-cap connection");

  // Late subscribers: the cached slot resends verbatim to cap holders and as
  // a downgrade card to no-cap connections.
  const lateFull = await viewer(relay, FULL_CAPS);
  t.after(() => lateFull.v.close());
  lateFull.v.send({ type: "subscribe", room: ROOM });
  const fLate = await lateFull.v.wait(isOpenFor("dlg-s1"), 3000, "sealed resend (full)");
  assert.deepEqual(fLate.event.textEnc, TEXT_ENC);
  assert.deepEqual(fLate.event.titleEnc, TITLE_ENC);
  const lateNo = await viewer(relay, NOCAP_CAPS);
  t.after(() => lateNo.v.close());
  lateNo.v.send({ type: "subscribe", room: ROOM });
  const fLateNo = await lateNo.v.wait(isOpenFor("dlg-s1"), 3000, "sealed resend (nocap)");
  assert.ok(!("textEnc" in fLateNo.event) && !("titleEnc" in fLateNo.event) && !("answerable" in fLateNo.event));
});

test("sealed frame with plaintext fields riding along: plaintext dropped everywhere, dialog kept", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  full.v.send({ type: "subscribe", room: ROOM });
  await full.v.type("snapshot");

  c.send({
    type: "event", room: ROOM,
    event: sealedOpen("dlg-s2", { title: "LEAK-TITLE-9", options: ["LEAK-OPT-9"], message: "LEAK-MSG-9" }),
  });
  const f = await full.v.wait(isOpenFor("dlg-s2"), 3000, "sealed open with leaked fields");
  assert.deepEqual(f.event.textEnc, TEXT_ENC);
  assert.ok(!("title" in f.event) && !("options" in f.event) && !("message" in f.event));
  assert.ok(!JSON.stringify(f).includes("LEAK"), "plaintext fields must not reach any surface");
  // The derived waiting summary is clean too.
  const w = await full.v.wait(waitingFor(ROOM, "dlg-s2"), 3000, "waiting for dlg-s2");
  assert.ok(!JSON.stringify(w).includes("LEAK"));
});

test("envelope presence rule: invalid textEnc with plaintext riding along yields a text-less card, never a plaintext fallback", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  const nocap = await viewer(relay, NOCAP_CAPS);
  t.after(() => nocap.v.close());
  for (const { v } of [full, nocap]) v.send({ type: "subscribe", room: ROOM });
  await full.v.type("snapshot");

  // Invalid textEnc (ct not a string) + plaintext fields riding along: the
  // frame declares the sealed form, so the plaintext is stripped on every
  // surface and the invalid envelope itself is carried nowhere -- the
  // result is a text-less card, not a plaintext dialog.
  c.send({
    type: "event", room: ROOM,
    event: {
      type: "dialog_open", dialogId: "dlg-bad", kind: "confirm", startedAt: 1, answerable: true,
      textEnc: { enc: 1, ct: 42 }, title: "LEAK-TITLE-BAD", message: "LEAK-MSG-BAD",
    },
  });
  const fBadFull = await full.v.wait(isOpenFor("dlg-bad"), 3000, "invalid-envelope open (full)");
  assert.ok(!("title" in fBadFull.event) && !("message" in fBadFull.event) && !("textEnc" in fBadFull.event));
  assert.ok(!("sealed" in fBadFull.event), "the slot-internal sealed marker never goes upstream");
  assert.ok(!JSON.stringify(fBadFull).includes("LEAK"), "plaintext must not reach the live surface");
  // The no-cap viewer gets the sealed-form downgrade posture (no
  // answerable), not the plaintext observation card.
  const fBadNo = await nocap.v.wait(isOpenFor("dlg-bad"), 3000, "invalid-envelope open (nocap)");
  assert.ok(!("answerable" in fBadNo.event) && !("textEnc" in fBadNo.event) && !("title" in fBadNo.event));
  // Resend from the cached slot: also text-less, no envelope, no plaintext.
  const lateBad = await viewer(relay, FULL_CAPS);
  t.after(() => lateBad.v.close());
  lateBad.v.send({ type: "subscribe", room: ROOM });
  const fBad = await lateBad.v.wait(isOpenFor("dlg-bad"), 3000, "invalid-envelope resend");
  assert.ok(!("textEnc" in fBad.event) && !("title" in fBad.event) && !("message" in fBad.event) && !("sealed" in fBad.event));
  assert.ok(!JSON.stringify(fBad).includes("LEAK"), "plaintext must not reach the resend surface");
  // Derived surfaces: the waiting summary and the inbox entry carry
  // neither a plaintext title nor a sealed one.
  const wBad = await full.v.wait(waitingFor(ROOM, "dlg-bad"), 3000, "waiting for dlg-bad");
  const wEntry = wBad.waiting.find((x) => x.dialogId === "dlg-bad");
  assert.ok(wEntry && !("title" in wEntry) && !("titleEnc" in wEntry));
  const upBad = await full.v.wait(inboxUpsertFor("dialog:dlg-bad"), 3000, "inbox upsert for dlg-bad");
  const iEntry = upBad.upserts.find((e) => e.key === "dialog:dlg-bad");
  assert.ok(iEntry && !("title" in iEntry) && !("titleEnc" in iEntry));
  assert.ok(!JSON.stringify(upBad).includes("LEAK"), "plaintext must not reach the ledger surface");

  // Valid textEnc + oversized titleEnc: card seals, summary title is dropped.
  c.send({
    type: "event", room: ROOM,
    event: sealedOpen("dlg-big", { titleEnc: { enc: 1, ct: "y".repeat(1025) } }),
  });
  const fBig = await full.v.wait(isOpenFor("dlg-big"), 3000, "oversized titleEnc open");
  assert.deepEqual(fBig.event.textEnc, TEXT_ENC);
  const w = await full.v.wait(waitingFor(ROOM, "dlg-big"), 3000, "waiting for dlg-big");
  const entry = w.waiting.find((x) => x.dialogId === "dlg-big");
  assert.ok(entry && !("titleEnc" in entry) && !("title" in entry), "oversized titleEnc must not reach the summary");
});

/* ---------- 3) waiting + inbox titleEnc pipe ---------- */

test("waiting summary and inbox ledger carry titleEnc; no-cap connections get neither titleEnc nor answerable", async (t) => {
  const dataDir = tmpDir();
  const relay = await boot({ dataDir });
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  const nocap = await viewer(relay, NOCAP_CAPS);
  t.after(() => nocap.v.close());

  c.send({ type: "event", room: ROOM, event: sealedOpen("dlg-w1") });

  const wFull = await full.v.wait(waitingFor(ROOM, "dlg-w1"), 3000, "waiting (full)");
  const eFull = wFull.waiting.find((x) => x.dialogId === "dlg-w1");
  assert.equal(eFull.titleEnc, TITLE_ENC.ct, "summary carries the bare ct string");
  assert.ok(!("title" in eFull));
  assert.equal(eFull.answerable, true);

  const wNo = await nocap.v.wait(waitingFor(ROOM, "dlg-w1"), 3000, "waiting (nocap)");
  const eNo = wNo.waiting.find((x) => x.dialogId === "dlg-w1");
  assert.ok(eNo && !("titleEnc" in eNo) && !("title" in eNo) && !("answerable" in eNo));

  // room_list view: same split.
  full.v.send({ type: "list_rooms" });
  const listFull = await full.v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === ROOM && (r.waiting || []).length));
  const lwFull = listFull.rooms.find((r) => r.id === ROOM).waiting.find((x) => x.dialogId === "dlg-w1");
  assert.equal(lwFull.titleEnc, TITLE_ENC.ct);
  nocap.v.send({ type: "list_rooms" });
  const listNo = await nocap.v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === ROOM && (r.waiting || []).length));
  const lwNo = listNo.rooms.find((r) => r.id === ROOM).waiting.find((x) => x.dialogId === "dlg-w1");
  assert.ok(lwNo && !("titleEnc" in lwNo) && !("answerable" in lwNo));

  // Inbox ledger: full viewer sees titleEnc on the upsert and on disk;
  // the no-cap viewer sees the entry with neither titleEnc nor answerable.
  const upFull = await full.v.wait(inboxUpsertFor("dialog:dlg-w1"), 3000, "inbox upsert (full)");
  const ieFull = upFull.upserts.find((e) => e.key === "dialog:dlg-w1");
  assert.equal(ieFull.titleEnc, TITLE_ENC.ct);
  assert.ok(!("title" in ieFull));
  const upNo = await nocap.v.wait(inboxUpsertFor("dialog:dlg-w1"), 3000, "inbox upsert (nocap)");
  const ieNo = upNo.upserts.find((e) => e.key === "dialog:dlg-w1");
  assert.ok(ieNo && !("titleEnc" in ieNo) && !("answerable" in ieNo));

  const accountsDir = path.join(dataDir, "accounts");
  const sub = fs.readdirSync(accountsDir).find((n) => fs.existsSync(path.join(accountsDir, n, "inbox.json")));
  const raw = fs.readFileSync(path.join(accountsDir, sub, "inbox.json"), "utf8");
  assert.ok(raw.includes(TITLE_ENC.ct), "ledger persists the sealed title ct");
  const diskEntry = JSON.parse(raw).entries.find((e) => e.key === "dialog:dlg-w1");
  assert.ok(diskEntry && !("title" in diskEntry), "ledger persists no plaintext title for a sealed dialog");
});

test("ui_prompt sealed title: cache, waitingPrompt and prompt inbox entry carry titleEnc only", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM2);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  const nocap = await viewer(relay, NOCAP_CAPS);
  t.after(() => nocap.v.close());

  const PROMPT_ENC = { enc: 1, ct: "BPLUS-PROMPT-CT-0001" };
  c.send({ type: "event", room: ROOM2, event: { type: "ui_prompt_start", reason: "dialog", kind: "confirm", titleEnc: PROMPT_ENC } });

  const promptWaiting = (v) => v.wait(
    (f) => f.type === "room_waiting" && f.room === ROOM2 && f.waitingPrompt,
    3000, "waitingPrompt",
  );
  const wpFull = (await promptWaiting(full.v)).waitingPrompt;
  assert.equal(wpFull.titleEnc, PROMPT_ENC.ct);
  assert.ok(!("title" in wpFull));
  const wpNo = (await promptWaiting(nocap.v)).waitingPrompt;
  assert.ok(wpNo && !("titleEnc" in wpNo) && !("title" in wpNo));

  // Late subscriber gets the cached ui_prompt_start resent with the envelope.
  const late = await viewer(relay, FULL_CAPS);
  t.after(() => late.v.close());
  late.v.send({ type: "subscribe", room: ROOM2 });
  const resent = await late.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ui_prompt_start",
    3000, "cached ui_prompt_start",
  );
  assert.deepEqual(resent.event.titleEnc, PROMPT_ENC);
  assert.ok(!resent.event.title, "cached resend carries no plaintext title");

  // Presence rule: a malformed titleEnc still marks the frame sealed-form,
  // so a plaintext title riding along reaches no surface -- live frame,
  // waiting summary, and the cache resend all stay title-less.
  c.send({
    type: "event", room: ROOM2,
    event: { type: "ui_prompt_start", reason: "dialog", kind: "confirm", titleEnc: { enc: 1, ct: 42 }, title: "LEAK-PROMPT-TITLE" },
  });
  const liveBad = await late.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ui_prompt_start" && !("titleEnc" in f.event),
    3000, "live ui_prompt_start (malformed titleEnc)",
  );
  assert.ok(!liveBad.event.title, "live frame carries no plaintext title");
  assert.ok(!JSON.stringify(liveBad).includes("LEAK-PROMPT"));
  const wpBad = (await full.v.wait(
    (f) => f.type === "room_waiting" && f.room === ROOM2 && f.waitingPrompt && !("titleEnc" in f.waitingPrompt),
    3000, "waitingPrompt (malformed titleEnc)",
  )).waitingPrompt;
  assert.ok(!wpBad.title, "summary carries no title for a malformed envelope");
  const late2 = await viewer(relay, FULL_CAPS);
  t.after(() => late2.v.close());
  late2.v.send({ type: "subscribe", room: ROOM2 });
  const resent2 = await late2.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ui_prompt_start",
    3000, "cached ui_prompt_start (malformed titleEnc)",
  );
  assert.ok(!("titleEnc" in resent2.event) && !resent2.event.title, "cached resend is title-less after a malformed envelope");
});

/* ---------- 4) close noteEnc + ext_notify passthrough ---------- */

test("dialog_close noteEnc: valid ct passes through, malformed noteEnc dropped; ext_notify messageEnc passes through", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  full.v.send({ type: "subscribe", room: ROOM });
  await full.v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: sealedOpen("dlg-c1") });
  await full.v.wait(isOpenFor("dlg-c1"), 3000, "open dlg-c1");
  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-c1", outcome: "denied", reason: "denied", noteEnc: "BPLUS-NOTE-CT-0001" } });
  const close1 = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "dialog_close" && f.event.dialogId === "dlg-c1",
    3000, "close dlg-c1",
  );
  assert.equal(close1.event.noteEnc, "BPLUS-NOTE-CT-0001");

  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-c2", outcome: "answered", reason: "answered", noteEnc: { enc: 1, ct: "wrong-shape" } } });
  const close2 = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "dialog_close" && f.event.dialogId === "dlg-c2",
    3000, "close dlg-c2",
  );
  assert.ok(!("noteEnc" in close2.event), "noteEnc on dialog_close is a bare ct string; object form is dropped");

  c.send({ type: "event", room: ROOM, event: { type: "ext_notify", messageEnc: { enc: 1, ct: "BPLUS-NOTIFY-CT-0001" }, level: "warning" } });
  const note = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ext_notify",
    3000, "ext_notify",
  );
  assert.deepEqual(note.event.messageEnc, { enc: 1, ct: "BPLUS-NOTIFY-CT-0001" });
  assert.equal(note.event.level, "warning");

  // Presence rule on the close path: a malformed noteEnc still marks the
  // close sealed-form, so a plaintext note riding along is dropped too --
  // neither field reaches the broadcast.
  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-c3", outcome: "denied", reason: "denied", noteEnc: 12345, note: "LEAK-NOTE-C3" } });
  const close3 = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "dialog_close" && f.event.dialogId === "dlg-c3",
    3000, "close dlg-c3",
  );
  assert.ok(!("noteEnc" in close3.event) && !("note" in close3.event));
  assert.ok(!JSON.stringify(close3).includes("LEAK-NOTE"));

  // Presence rule on the ext_notify pass-through: a malformed messageEnc
  // drops the plaintext message as well; a valid messageEnc with a
  // plaintext message riding along forwards only the envelope.
  c.send({ type: "event", room: ROOM, event: { type: "ext_notify", messageEnc: { enc: 1, ct: 7 }, message: "LEAK-NOTIFY-1", level: "info" } });
  const note2 = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ext_notify" && f.event.level === "info",
    3000, "ext_notify (malformed messageEnc)",
  );
  assert.ok(!("messageEnc" in note2.event) && !("message" in note2.event));
  assert.ok(!JSON.stringify(note2).includes("LEAK-NOTIFY"));
  c.send({ type: "event", room: ROOM, event: { type: "ext_notify", messageEnc: { enc: 1, ct: "BPLUS-NOTIFY-CT-0002" }, message: "LEAK-NOTIFY-2", level: "error" } });
  const note3 = await full.v.wait(
    (f) => f.type === "room_event" && f.event && f.event.type === "ext_notify" && f.event.level === "error",
    3000, "ext_notify (valid messageEnc + plaintext)",
  );
  assert.deepEqual(note3.event.messageEnc, { enc: 1, ct: "BPLUS-NOTIFY-CT-0002" });
  assert.ok(!("message" in note3.event));
  assert.ok(!JSON.stringify(note3).includes("LEAK-NOTIFY"));
});

/* ---------- 5) plaintext regression: legacy frames unchanged ---------- */

test("plaintext dialog_open: every surface behaves exactly as before (no titleEnc anywhere)", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await extensionRoom(relay, ROOM);
  t.after(() => c.close());
  const full = await viewer(relay, FULL_CAPS);
  t.after(() => full.v.close());
  const nocap = await viewer(relay, NOCAP_CAPS);
  t.after(() => nocap.v.close());
  const legacy = await viewer(relay); // no caps at all: oldest client shape
  t.after(() => legacy.v.close());
  for (const { v } of [full, nocap]) v.send({ type: "subscribe", room: ROOM });
  await full.v.type("snapshot");

  c.send({
    type: "event", room: ROOM,
    event: { type: "dialog_open", dialogId: "dlg-p1", kind: "select", title: "选一个", options: ["甲", "乙"], startedAt: 7, answerable: true },
  });
  for (const { v } of [full, nocap]) {
    const f = await v.wait(isOpenFor("dlg-p1"), 3000, "plaintext open");
    assert.equal(f.event.title, "选一个");
    assert.deepEqual(f.event.options, ["甲", "乙"]);
    assert.ok(!("textEnc" in f.event) && !("titleEnc" in f.event));
  }
  const w = await full.v.wait(waitingFor(ROOM, "dlg-p1"), 3000, "plaintext waiting");
  const entry = w.waiting.find((x) => x.dialogId === "dlg-p1");
  assert.equal(entry.title, "选一个");
  assert.ok(!("titleEnc" in entry));
  const up = await full.v.wait(inboxUpsertFor("dialog:dlg-p1"), 3000, "plaintext inbox upsert");
  const ie = up.upserts.find((e) => e.key === "dialog:dlg-p1");
  assert.equal(ie.title, "选一个");
  assert.ok(!("titleEnc" in ie));
  // The cap-less legacy viewer still gets its auth and room list untouched.
  assert.equal(legacy.auth.ok, true);
  legacy.v.send({ type: "list_rooms" });
  const list = await legacy.v.type("room_list");
  const roomEntry = list.rooms.find((r) => r.id === ROOM);
  assert.ok(roomEntry && !("waiting" in roomEntry), "legacy room_list keeps the pre-dialogs shape");
});
