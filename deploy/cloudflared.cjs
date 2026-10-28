"use strict";
/**
 * cloudflared 托管 —— 免服务器（本地）模式的公网隧道（Cloudflare quick tunnel）。
 *
 * 职责只有三件：找到/下载 cloudflared 二进制、按写死的安全参数拉起 quick tunnel、
 * 把这次的 *.trycloudflare.com 网址抓出来交给调用方出示，并在结束时回收进程（组）。
 *
 * 安全铁规（设计 §3/§5，本模块是执行点）：
 *   - 隧道目标写死 http://127.0.0.1:<viewerPort>，全模块只允许这一个源；
 *     本地通道端口（localPort）永不进隧道——buildTunnelArgs 在 viewerPort === localPort 时直接抛错，
 *     verifyTunnelArgsSafe 供 doctor 对运行中记录的参数再核对一遍。
 *   - 二进制来源：PI_REMOTE_CLOUDFLARED_BIN 显式指定 > 系统 PATH 已装 > 本地缓存 >
 *     官方 GitHub Release 钉死版本下载；下载与缓存都必须过 SHA256 校验（下表），对不上就删、就报错，
 *     绝不执行没验过的二进制。
 *   - 子进程用专属隔离 HOME 拉起：用户 ~/.cloudflared 里若有 named tunnel 的 config.yaml，
 *     quick tunnel 会拒绝运行（官方已知行为）；隔离后与用户现网配置互不干扰。
 *   - quick tunnel 网址每次启动都会变：本模块不承诺稳定性，调用方必须每次重新出示。
 *
 * 钉死版本与校验表来源：https://github.com/cloudflare/cloudflared/releases/tag/2026.10.4
 *   （2026-10-26 发布；各资产 sha256 取自 GitHub Release API 的 asset digest 字段，
 *    2026-10-28 核对，且 linux-amd64 已实下载复核哈希一致。升级版本时整表一起换，不要只改版本号。）
 * darwin 官方只发 .tgz（内含单个 cloudflared 二进制）：下载验的是压缩包哈希，解压用系统 tar。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const HOST_PLATFORM = process.platform;

const CLOUDFLARED_VERSION = "2026.10.4";
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/** 平台-架构 → 官方资产。键：`${platform}-${arch}`（Node 的 process.platform / process.arch）。 */
const RELEASE_ASSETS = {
  "linux-x64": { file: "cloudflared-linux-amd64", sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42" },
  "linux-arm64": { file: "cloudflared-linux-arm64", sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6" },
  "linux-arm": { file: "cloudflared-linux-arm", sha256: "f29b44e97ec18dd2971dfdd9bad0c6d460aaa78223b91b186219f02135c08d8c" },
  "linux-ia32": { file: "cloudflared-linux-386", sha256: "a759230628a894c9262cfc0535926ba1e0cc54260e0b35a6e6cf3833919c67f2" },
  "darwin-x64": { file: "cloudflared-darwin-amd64.tgz", sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d", archive: "tgz" },
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f", archive: "tgz" },
  "win32-x64": { file: "cloudflared-windows-amd64.exe", sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8" },
  "win32-ia32": { file: "cloudflared-windows-386.exe", sha256: "6d38146a071184959adde89c299e87132d89777ee5318dcb066e6fac861ec63c" },
};

/* ---------------- 纯函数：资产 / 参数 / 网址解析 ---------------- */

function releaseAsset(platform = HOST_PLATFORM, arch = process.arch, table = RELEASE_ASSETS) {
  return table[`${platform}-${arch}`] || null;
}

function releaseDownloadUrl(asset) {
  return `${RELEASE_BASE}/${asset.file}`;
}

function validPort(n) {
  return Number.isSafeInteger(n) && n >= 1 && n <= 65535;
}

/**
 * 拼 cloudflared 参数（纯函数，可单测断言）：目标写死回环 viewer 端口这一个源；
 * viewerPort 与 localPort 相同 = 配置事故（会把本地通道推出公网），直接抛错不许拉起。
 * --metrics 给独立回环端口：调用方轮询它的 /ready 核对隧道真就绪，不靠日志猜。
 */
function buildTunnelArgs({ viewerPort, localPort, metricsPort } = {}) {
  const vp = Number(viewerPort);
  const lp = Number(localPort);
  const mp = Number(metricsPort);
  if (!validPort(vp)) throw new Error("buildTunnelArgs：viewerPort 不是合法端口：" + viewerPort);
  if (!validPort(lp)) throw new Error("buildTunnelArgs：localPort 不是合法端口：" + localPort);
  if (!validPort(mp)) throw new Error("buildTunnelArgs：metricsPort 不是合法端口：" + metricsPort);
  if (vp === lp) {
    throw new Error(`隧道目标端口（${vp}）与本地通道端口相同：本地通道永不进隧道，已拒绝拉起隧道`);
  }
  return ["tunnel", "--url", `http://127.0.0.1:${vp}`, "--no-autoupdate", "--metrics", `127.0.0.1:${mp}`];
}

/**
 * 核对一组参数是不是本模块会拼出来的那种安全参数（doctor §5.3 用：对 attach 记录的
 * 运行中隧道参数再验一遍）。安全返回 ""，有问题返回原因字符串。
 */
function verifyTunnelArgsSafe(args, { viewerPort, localPort } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const vp = Number(viewerPort);
  const lp = Number(localPort);
  if (!validPort(vp) || !validPort(lp)) return "端口配置不合法，无法核对隧道参数";
  if (vp === lp) return `viewer 端口与本地通道端口相同（${vp}），本身就是事故配置`;
  if (list[0] !== "tunnel") return "参数不是 tunnel 子命令";
  const urlIdx = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--url") urlIdx.push(i);
    if (/^https?:\/\//i.test(list[i]) && list[i - 1] !== "--url") return `参数里混入了 --url 以外的网址：${list[i]}`;
  }
  if (urlIdx.length !== 1) return `--url 应当恰好一个，实际 ${urlIdx.length} 个`;
  const target = list[urlIdx[0] + 1] || "";
  let u;
  try {
    u = new URL(target);
  } catch {
    return `--url 目标无法解析：${target}`;
  }
  if (u.protocol !== "http:") return `--url 目标协议不是 http：${target}`;
  if (u.hostname !== "127.0.0.1") return `--url 目标不是回环地址：${target}（隧道只许指向本机回环）`;
  if (Number(u.port) !== vp) return `--url 目标端口是 ${u.port || "(缺省)"}，不是 viewer 端口 ${vp}`;
  if (Number(u.port) === lp) return `--url 目标正是本地通道端口 ${lp}：本地通道进了隧道`;
  return "";
}

/** 从 cloudflared 的输出文本里提取 quick tunnel 网址（纯函数）。抓不到返回 null。 */
function extractTunnelUrl(text) {
  const m = String(text == null ? "" : text).match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

/* ---------------- 二进制解析：env > PATH > 缓存 > 下载 ---------------- */

function defaultCacheDir(environ = process.env) {
  const fromEnv = String((environ && environ.PI_REMOTE_CLOUDFLARED_DIR) || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".pi-remote", "cloudflared");
}

function cachedBinaryPath(cacheDir, platform = HOST_PLATFORM, version = CLOUDFLARED_VERSION) {
  return path.join(cacheDir, version, platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

function isExecutableFile(file, platform = HOST_PLATFORM) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里按文件名找可执行文件（口径与 attach.findOnPath 一致，这里独立一份保持模块自足） */
function findOnPath(names, platform = HOST_PLATFORM, environ = process.env) {
  const raw = String((environ && (environ.PATH || environ.Path || environ.path)) || "");
  if (!raw) return "";
  const dirs = raw.split(platform === "win32" ? ";" : path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return "";
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function probeVersion(bin, spawnSyncImpl = spawnSync) {
  try {
    const r = spawnSyncImpl(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (!r || r.error || r.status !== 0) return "";
    const m = String(r.stdout || r.stderr || "").match(/cloudflared version (\S+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/** 默认下载实现：https 跟随重定向（GitHub Release 先 302 到资产域），流式落到目标文件。 */
function downloadHttps(url, dest) {
  return new Promise((resolve, reject) => {
    const attempt = (current, redirectsLeft) => {
      const req = https.get(current, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("下载重定向次数过多：" + url));
            return;
          }
          attempt(new URL(res.headers.location, current).toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`下载失败（HTTP ${status}）：${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(dest)));
        file.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(120000, () => req.destroy(new Error("下载超时：" + url)));
    };
    attempt(url, 5);
  });
}

/** tar 解压 .tgz（darwin 资产）到目录，返回解出的 cloudflared 路径。系统 tar 在三平台都自带。 */
function extractTgzBinary(tgzPath, destDir, spawnSyncImpl = spawnSync) {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSyncImpl("tar", ["-xzf", tgzPath, "-C", destDir], { encoding: "utf8", timeout: 60000 });
  if (!r || r.error || r.status !== 0) {
    throw new Error("解压 cloudflared 压缩包失败：" + ((r && (r.stderr || r.error)) || "tar 不可用"));
  }
  const bin = path.join(destDir, "cloudflared");
  if (!fs.existsSync(bin)) throw new Error("压缩包里没有 cloudflared 二进制");
  return bin;
}

/**
 * 解析 cloudflared 二进制。返回 { bin, source, version }：
 *   source: "env"（PI_REMOTE_CLOUDFLARED_BIN 指定）| "path"（系统已装）| "cache"（此前下载且验过）| "download"（本次下载）
 * 找不到且不许下载 / 不支持的平台 / 校验失败 → 抛带人话的 Error。
 */
async function resolveCloudflared(opts = {}) {
  const platform = opts.platform || HOST_PLATFORM;
  const arch = opts.arch || process.arch;
  const environ = opts.environ || process.env;
  const cacheDir = opts.cacheDir || defaultCacheDir(environ);
  const allowDownload = opts.allowDownload !== false;
  const spawnSyncImpl = opts.spawnSyncImpl || spawnSync;
  const table = opts.releaseTable || RELEASE_ASSETS;
  const version = opts.version || CLOUDFLARED_VERSION;
  const log = typeof opts.log === "function" ? opts.log : () => {};

  const fromEnv = String((environ && environ.PI_REMOTE_CLOUDFLARED_BIN) || "").trim();
  if (fromEnv) {
    if (!isExecutableFile(fromEnv, platform)) throw new Error(`PI_REMOTE_CLOUDFLARED_BIN 指向的文件不存在或不可执行：${fromEnv}`);
    return { bin: fromEnv, source: "env", version: probeVersion(fromEnv, spawnSyncImpl) || "unknown" };
  }

  const onPath = findOnPath(platform === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"], platform, environ);
  if (onPath) {
    const v = probeVersion(onPath, spawnSyncImpl);
    if (v) return { bin: onPath, source: "path", version: v };
    log(`PATH 上的 cloudflared 无法运行（${onPath}），改用缓存/下载`);
  }

  const asset = releaseAsset(platform, arch, table);
  const cached = cachedBinaryPath(cacheDir, platform, version);
  if (fs.existsSync(cached)) {
    if (!asset) throw new Error(`缓存里有 cloudflared 但当前平台（${platform}-${arch}）不在钉死校验表内，拒绝使用`);
    const digest = await sha256File(cached);
    if (digest === asset.sha256) {
      if (platform !== "win32") {
        try {
          fs.chmodSync(cached, 0o755);
        } catch {}
      }
      return { bin: cached, source: "cache", version };
    }
    log("缓存的 cloudflared 哈希对不上钉死表，删掉重新下载");
    try {
      fs.unlinkSync(cached);
    } catch {}
  }

  if (!allowDownload) {
    throw new Error("cloudflared 还没装（PATH 与缓存都没有），且本次不许下载");
  }
  if (!asset) {
    throw new Error(`暂不支持在 ${platform}-${arch} 上自动下载 cloudflared；请手动安装后重试（或用 PI_REMOTE_CLOUDFLARED_BIN 指定）`);
  }
  const url = opts.downloadBase ? `${opts.downloadBase}/${asset.file}` : releaseDownloadUrl(asset);
  const downloadImpl = opts.downloadImpl || downloadHttps;
  const extractImpl = opts.extractImpl || extractTgzBinary;
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const tmp = `${cached}.download-${process.pid}`;
  log(`正在下载 cloudflared ${version}（${asset.file}，约 ${asset.archive ? "20" : "40"}MB，来自官方 GitHub Release）…`);
  try {
    await downloadImpl(url, tmp);
    const digest = await sha256File(tmp);
    if (digest !== asset.sha256) {
      throw new Error(`下载的 cloudflared 哈希校验失败（期望 ${asset.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…），已丢弃；请检查网络后重试`);
    }
    let finalTmp = tmp;
    if (asset.archive === "tgz") {
      const extractDir = `${cached}.extract-${process.pid}`;
      try {
        finalTmp = extractImpl(tmp, extractDir, spawnSyncImpl);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
      fs.renameSync(finalTmp, cached);
      try {
        fs.rmdirSync(extractDir);
      } catch {}
    } else {
      fs.renameSync(tmp, cached);
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  if (platform !== "win32") {
    try {
      fs.chmodSync(cached, 0o755);
    } catch {}
  }
  if (!isExecutableFile(cached, platform)) throw new Error("cloudflared 下载完成但不可执行：" + cached);
  return { bin: cached, source: "download", version };
}

/* ---------------- 隧道生命周期 ---------------- */

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** 默认就绪探针：GET /ready，200 才算隧道连接已建立（cloudflared metrics 端点语义） */
function probeReady(metricsPort, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: metricsPort, path: "/ready", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function killChildTree(child, signal, opts = {}) {
  const platform = opts.platform || HOST_PLATFORM;
  const killImpl = opts.killImpl || ((pid, sig) => process.kill(pid, sig));
  if (!child || child.pid == null) return;
  if (platform === "win32") {
    try {
      (opts.spawnSyncImpl || spawnSync)("taskkill", ["/pid", String(child.pid), "/T", signal === "SIGKILL" ? "/F" : ""].filter(Boolean), { timeout: 5000 });
    } catch {}
    try {
      child.kill();
    } catch {}
    return;
  }
  // POSIX：startTunnel 以 detached 拉起，子进程是进程组组长；负 pid 连组一起收，避免留孤儿
  try {
    killImpl(-child.pid, signal);
    return;
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

function waitChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve(true);
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    child.once("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

/**
 * 拉起 quick tunnel。返回句柄：
 *   { args, metricsPort, url(), state(), ready: Promise<{url}>, stop(): Promise<void>, child }
 * state: "starting" → "ready" | "failed"（异常退出/就绪超时） | "stopped"（stop 后或被回收）。
 * 网址出现（日志里抓到）与就绪（/ready 200）是两步：onUrl 在抓到网址时先行回调（出示可以先走），
 * ready 在探针确认后 resolve。子进程异常退出时 onExit 回调，调用方据此回落出示源。
 */
function startTunnel(opts = {}) {
  const platform = opts.platform || HOST_PLATFORM;
  const spawnImpl = opts.spawnImpl || spawn;
  const probe = opts.probeReady || probeReady;
  const readyTimeoutMs = opts.readyTimeoutMs != null ? Number(opts.readyTimeoutMs) : 90000;
  const pollMs = opts.pollMs != null ? Number(opts.pollMs) : 400;
  const environ = opts.environ || process.env;

  let state = "starting";
  let url = "";
  let child = null;
  let stopped = false;
  let pollTimer = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // 调用方可能只用回调不用 ready：挂一个空 catch 防未处理拒绝刷屏，await ready 的人照样能拿到结果
  ready.catch(() => {});

  const tailLines = [];
  const pushTail = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      tailLines.push(line);
      if (tailLines.length > 40) tailLines.shift();
    }
  };
  const tailText = () => tailLines.slice(-12).join("\n");

  const handle = {
    args: null,
    metricsPort: 0,
    ready,
    url: () => url,
    state: () => state,
    child: () => child,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (state === "starting" || state === "ready") state = "stopped";
      if (!child) return;
      killChildTree(child, "SIGTERM", { platform, spawnSyncImpl: opts.spawnSyncImpl, killImpl: opts.killImpl });
      const exited = await waitChildExit(child, 2500);
      if (!exited) {
        killChildTree(child, "SIGKILL", { platform, spawnSyncImpl: opts.spawnSyncImpl, killImpl: opts.killImpl });
        await waitChildExit(child, 1500);
      }
    },
  };

  (async () => {
    try {
      const metricsPort = opts.metricsPort != null ? Number(opts.metricsPort) : await pickFreePort();
      const args = buildTunnelArgs({ viewerPort: opts.viewerPort, localPort: opts.localPort, metricsPort });
      handle.args = args;
      handle.metricsPort = metricsPort;
      const home = opts.home || path.join(defaultCacheDir(environ), "tunnel-home");
      fs.mkdirSync(home, { recursive: true });
      const env = { ...environ, HOME: home };
      if (platform === "win32") env.USERPROFILE = home;
      child = spawnImpl(opts.bin, args, {
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      if (typeof child.unref === "function") child.unref();
      const onData = (chunk) => {
        pushTail(chunk);
        if (!url) {
          const found = extractTunnelUrl(tailLines.join("\n"));
          if (found) {
            url = found;
            if (typeof opts.onUrl === "function") {
              try {
                opts.onUrl(url);
              } catch {}
            }
          }
        }
        if (typeof opts.onOutput === "function") {
          try {
            opts.onOutput(String(chunk));
          } catch {}
        }
      };
      if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", onData);
      if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", onData);
      child.on("error", (e) => {
        if (state === "starting") {
          state = "failed";
          readyReject(new Error("cloudflared 启动失败：" + (e && e.message ? e.message : e)));
        }
      });
      child.on("exit", (code, signal) => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        if (stopped) return;
        const was = state;
        state = "failed";
        if (was === "starting") {
          readyReject(new Error(`cloudflared 在隧道就绪前退出（code ${code}${signal ? " signal " + signal : ""}）：\n${tailText()}`));
        }
        if (typeof opts.onExit === "function") {
          try {
            opts.onExit({ code, signal });
          } catch {}
        }
      });
      const deadline = Date.now() + readyTimeoutMs;
      pollTimer = setInterval(async () => {
        if (stopped || state !== "starting") return;
        let ok = false;
        try {
          ok = await probe(metricsPort);
        } catch {}
        if (ok && !stopped && state === "starting") {
          state = "ready";
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          readyResolve({ url });
          if (typeof opts.onReady === "function") {
            try {
              opts.onReady(url);
            } catch {}
          }
          return;
        }
        if (Date.now() > deadline && state === "starting") {
          state = "failed";
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          readyReject(new Error(`隧道 ${Math.round(readyTimeoutMs / 1000)}s 内没就绪（metrics /ready 一直没通）：\n${tailText()}`));
          // 就绪超时的隧道留着也没用：回收掉，调用方按失败回落局域网
          handle.stop();
        }
      }, pollMs);
      if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
    } catch (e) {
      state = "failed";
      readyReject(e);
    }
  })();

  return handle;
}

module.exports = {
  CLOUDFLARED_VERSION,
  RELEASE_BASE,
  RELEASE_ASSETS,
  releaseAsset,
  releaseDownloadUrl,
  buildTunnelArgs,
  verifyTunnelArgsSafe,
  extractTunnelUrl,
  defaultCacheDir,
  cachedBinaryPath,
  findOnPath,
  isExecutableFile,
  sha256File,
  probeVersion,
  downloadHttps,
  extractTgzBinary,
  resolveCloudflared,
  pickFreePort,
  probeReady,
  killChildTree,
  startTunnel,
};
