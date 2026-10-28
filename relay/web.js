"use strict";
/** viewer 端口的 HTTP：静态页面与 GET /healthz */
const fs = require("node:fs");
const path = require("node:path");
const PROTOCOL = require("./protocol.json");
const { log } = require("./util");
const { RELAY_VERSION } = require("./wire");
const { UNREGISTERED_DEVICE } = require("./devices");

const WEB_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function makeServeWeb(webRoot) {
  const sendStatus = (res, code) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(code === 404 ? "not found" : String(code));
  };

  // 只有 ENOENT/ENOTDIR 是"路径不存在"；权限、符号链接循环、IO 错误等必须记日志并回 500，
  // 不能继续伪装成 404（否则线上静态资源坏了只看到一片"页面不存在"）。
  const isNotFound = (err) => !!err && (err.code === "ENOENT" || err.code === "ENOTDIR");
  const logReadError = (req, pathname, err) => {
    log("静态资源读取失败:", req.method, JSON.stringify(pathname), (err && err.code) || "-", (err && err.message) || String(err));
  };

  /**
   * stat + createReadStream 发送单个文件，避免把整份静态资源读进内存。
   * isIndex=true 表示这是 SPA 回退的 index.html：它自己不存在时只能 404，不能再回退。
   */
  function sendFile(req, res, file, pathname, isIndex) {
    fs.stat(file, (statErr, st) => {
      if (statErr) {
        if (isNotFound(statErr)) {
          if (!isIndex && !path.extname(pathname)) sendIndex(req, res);
          else sendStatus(res, 404);
          return;
        }
        logReadError(req, pathname, statErr);
        sendStatus(res, 500);
        return;
      }
      if (!st.isFile()) {
        // readFile 面对目录会报 EISDIR：沿用旧口径——带扩展名 404，无扩展名走 SPA 回退。
        // 这是客户端路径写法问题，不升级成 500，也不尝试流式读取目录。
        if (!isIndex && !path.extname(pathname)) sendIndex(req, res);
        else sendStatus(res, 404);
        return;
      }
      // 带内容 hash 的构建产物可长缓存；入口 HTML 必须 no-cache（否则部署后手机端一直跑旧前端）
      const immutable = !isIndex && /^\/assets\//.test(pathname) && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(pathname);
      const headers = {
        "Content-Type": WEB_TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      const stream = fs.createReadStream(file);
      let opened = false;
      stream.once("open", () => {
        opened = true;
        if (res.headersSent || res.writableEnded) { stream.destroy(); return; }
        res.writeHead(200, headers);
        stream.pipe(res);
      });
      stream.once("error", (err) => {
        if (!opened && !res.headersSent) {
          logReadError(req, pathname, err);
          if (isNotFound(err)) {
            if (!isIndex && !path.extname(pathname)) sendIndex(req, res);
            else sendStatus(res, 404);
          } else {
            sendStatus(res, 500);
          }
          return;
        }
        log("静态资源传输中断:", req.method, JSON.stringify(pathname), (err && err.code) || "-", (err && err.message) || String(err));
        if (!res.headersSent) sendStatus(res, 500);
        else { try { res.destroy(); } catch {} }
      });
      // 客户端提前断开时停止读盘，避免为已关闭的响应继续占用文件句柄/内存。
      res.once("close", () => {
        if (!res.writableEnded) stream.destroy();
      });
    });
  }

  function sendIndex(req, res) {
    sendFile(req, res, path.join(webRoot, "index.html"), "/index.html", true);
  }

  return function serveWeb(req, res) {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      } catch {
        sendStatus(res, 400);
        return;
      }
      // NUL 字节会让 fs 同步抛 ERR_INVALID_ARG_VALUE（不走回调）：请求挂起、异常逃逸到进程级
      if (pathname.includes("\0")) {
        sendStatus(res, 400);
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      const file = path.join(webRoot, pathname);
      const rel = path.relative(webRoot, file);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        sendStatus(res, 403);
        return;
      }
      sendFile(req, res, file, pathname, false);
    } catch (e) {
      log("静态资源请求异常:", e.message);
      sendStatus(res, 500);
    }
  };
}

/** GET /healthz 的正文：只给计数和版本，不给房间名、路径、设备名 */
function healthBody(rooms, startedAt, serverName) {
  const list = rooms.list();
  let devices = [];
  try {
    devices = rooms.deviceSnapshot().filter((d) => d.id !== UNREGISTERED_DEVICE);
  } catch (e) {
    log("healthz 读设备名册失败:", e.message);
  }
  return {
    ok: true,
    proto: PROTOCOL.proto,
    version: RELAY_VERSION,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...(serverName ? { serverName } : null),
    rooms: { online: list.filter((r) => r.online).length, total: list.length },
    devices: { online: devices.filter((d) => d.online).length, total: devices.length },
    viewers: rooms.viewers.size,
  };
}

module.exports = { makeServeWeb, healthBody };
