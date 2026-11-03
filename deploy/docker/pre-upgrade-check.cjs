"use strict";
/**
 * Pre-upgrade data check for the Pi-Remote relay.
 *
 * Read-only by design: it never writes, moves or deletes anything (the
 * writability probe uses access(2), not a test file). Run it before
 * replacing the relay -- new Docker image or new release -- to confirm
 * the data directory is intact, so an upgrade never starts on top of a
 * broken accounts index or an unreadable room store.
 *
 * What is a hard failure (exit 1, do not upgrade):
 *   - a data directory that exists but cannot be read or written;
 *   - an accounts/rooms file that cannot be read at all;
 *   - a non-empty JSONL index file without a single parseable record.
 * What is only a warning (exit 0):
 *   - individual unparseable JSONL lines -- the relay loader skips them
 *     the same way (relay/index.js readMap), so they must not block an
 *     upgrade; they are counted and reported for a later look;
 *   - a leftover .relay.lock whose pid is still alive (stop the old
 *     relay first), or low free disk space.
 * Missing directories mean "no data yet" and pass: a first install has
 * nothing to protect.
 *
 * Usage:
 *   node deploy/docker/pre-upgrade-check.cjs [--data-dir <roomsDir>]
 *                                            [--accounts-dir <accountsDir>]
 * Directory resolution matches relay/config.js: explicit flag >
 * PI_REMOTE_DATA_DIR / PI_REMOTE_ACCOUNTS_DIR > <root>/data/rooms and
 * <root>/data/accounts. Inside the Docker deployment the data lives
 * in the container's volume, so run the check there:
 *   docker compose -f deploy/docker/docker-compose.yml exec relay \
 *     node deploy/docker/pre-upgrade-check.cjs
 * In the image layout the defaults already resolve to the volume
 * subdirectories (/app/data/rooms and /app/data/accounts).
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

function resolveDir(flag, envName, fallback) {
  const raw = argValue(flag) || process.env[envName] || fallback;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

const dataDir = resolveDir("--data-dir", "PI_REMOTE_DATA_DIR", path.join("data", "rooms"));
const accountsDir = resolveDir("--accounts-dir", "PI_REMOTE_ACCOUNTS_DIR", path.join("data", "accounts"));

const failures = [];
const warnings = [];
let totalBytes = 0;
let totalFiles = 0;

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Recursively stat every file under dir; unreadable entries are failures. */
function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    failures.push(`cannot list directory ${dir}: ${e.message}`);
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (ent.isFile()) out.push(p);
  }
}

/** Parse one JSONL index file the way the relay loader does: count good
 *  records, tolerate (but report) bad lines, fail on unreadable files
 *  and on files with content but zero parseable records. */
function checkJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    failures.push(`cannot read index file ${file}: ${e.message}`);
    return;
  }
  let good = 0;
  let bad = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      JSON.parse(t);
      good++;
    } catch {
      bad++;
    }
  }
  if (bad > 0 && good === 0) {
    failures.push(`index file ${file} has ${bad} line(s) and none of them parse; treating it as corrupt`);
  } else if (bad > 0) {
    warnings.push(`index file ${file} has ${bad} unparseable line(s) (the relay skips them; inspect when convenient)`);
  }
}

function checkLock(dir) {
  const lock = path.join(dir, ".relay.lock");
  let raw;
  try {
    raw = fs.readFileSync(lock, "utf8");
  } catch {
    return; // no lock file: the common case
  }
  const pid = Number(String(raw).split("\n", 1)[0].trim());
  if (Number.isSafeInteger(pid) && pid > 0) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) warnings.push(`a relay process (pid ${pid}) still holds ${dir}; stop it before upgrading`);
  }
}

function checkTree(label, dir, { jsonl }) {
  if (!fs.existsSync(dir)) {
    console.log(`[check] ${label}: ${dir} does not exist yet (nothing to protect)`);
    return;
  }
  if (!isWritableDir(dir)) failures.push(`${label} directory ${dir} is not readable/writable by this user`);
  const files = [];
  walkFiles(dir, files);
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      totalBytes += st.size;
      totalFiles++;
      fs.accessSync(f, fs.constants.R_OK);
    } catch (e) {
      failures.push(`cannot read file ${f}: ${e.message}`);
    }
    if (jsonl && f.endsWith(".jsonl")) checkJsonl(f);
  }
  console.log(`[check] ${label}: ${files.length} file(s) under ${dir}`);
}

function main() {
  console.log(`[check] data directory (rooms):    ${dataDir}`);
  console.log(`[check] accounts directory:        ${accountsDir}`);
  checkTree("rooms", dataDir, { jsonl: false });
  checkTree("accounts", accountsDir, { jsonl: true });
  checkLock(dataDir);

  try {
    const free = fs.statfsSync(dataDir).bavail * fs.statfsSync(dataDir).bsize;
    if (free < totalBytes) {
      warnings.push(`free disk space (${free} bytes) is smaller than the data size (${totalBytes} bytes); a backup copy would not fit`);
    }
  } catch {
    /* statfs is best-effort only */
  }

  console.log(`[check] total data: ${totalFiles} file(s), ${totalBytes} byte(s)`);
  for (const w of warnings) console.log(`[check] WARNING: ${w}`);
  if (failures.length) {
    for (const f of failures) console.error(`[check] FAILURE: ${f}`);
    console.error("[check] result: STOP -- fix the failures above before upgrading. No data was modified.");
    process.exit(1);
  }
  console.log("[check] result: OK -- safe to upgrade. No data was modified.");
}

main();
