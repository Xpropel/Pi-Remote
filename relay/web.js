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
  const sendStatus = (response, statusCode) => {
    if (response.headersSent) { try { response.end(); } catch {} return; }
    response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(statusCode === 404 ? "not found" : String(statusCode));
  };

  // 只有 ENOENT/ENOTDIR 是"路径不存在"；权限、符号链接循环、IO 错误等必须记日志并回 500，
  // 不能继续伪装成 404（否则线上静态资源坏了只看到一片"页面不存在"）。
  const isNotFound = (readError) => !!readError && (readError.code === "ENOENT" || readError.code === "ENOTDIR");
  const logReadError = (request, pathname, readError) => {
    log("静态资源读取失败:", request.method, JSON.stringify(pathname), (readError && readError.code) || "-", (readError && readError.message) || String(readError));
  };

  /**
   * stat + createReadStream 发送单个文件，避免把整份静态资源读进内存。
   * isIndex=true 表示这是 SPA 回退的 index.html：它自己不存在时只能 404，不能再回退。
   */
  function sendFile(request, response, file, pathname, isIndexFallback) {
    fs.stat(file, (statError, fileStat) => {
      if (statError) {
        if (isNotFound(statError)) {
          if (!isIndexFallback && !path.extname(pathname)) sendIndex(request, response);
          else sendStatus(response, 404);
          return;
        }
        logReadError(request, pathname, statError);
        sendStatus(response, 500);
        return;
      }
      if (!fileStat.isFile()) {
        // readFile 面对目录会报 EISDIR：沿用旧口径——带扩展名 404，无扩展名走 SPA 回退。
        // 这是客户端路径写法问题，不升级成 500，也不尝试流式读取目录。
        if (!isIndexFallback && !path.extname(pathname)) sendIndex(request, response);
        else sendStatus(response, 404);
        return;
      }
      // 带内容 hash 的构建产物可长缓存；入口 HTML 必须 no-cache（否则部署后手机端一直跑旧前端）
      const cacheable = !isIndexFallback && /^\/assets\//.test(pathname) && /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(pathname);
      const headers = {
        "Content-Type": WEB_TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
      };
      if (request.method === "HEAD") {
        response.writeHead(200, headers);
        response.end();
        return;
      }
      const stream = fs.createReadStream(file);
      let opened = false;
      stream.once("open", () => {
        opened = true;
        if (response.headersSent || response.writableEnded) { stream.destroy(); return; }
        response.writeHead(200, headers);
        stream.pipe(response);
      });
      stream.once("error", (streamError) => {
        if (!opened && !response.headersSent) {
          logReadError(request, pathname, streamError);
          if (isNotFound(streamError)) {
            if (!isIndexFallback && !path.extname(pathname)) sendIndex(request, response);
            else sendStatus(response, 404);
          } else {
            sendStatus(response, 500);
          }
          return;
        }
        log("静态资源传输中断:", request.method, JSON.stringify(pathname), (streamError && streamError.code) || "-", (streamError && streamError.message) || String(streamError));
        if (!response.headersSent) sendStatus(response, 500);
        else { try { response.destroy(); } catch {} }
      });
      // 客户端提前断开时停止读盘，避免为已关闭的响应继续占用文件句柄/内存。
      response.once("close", () => {
        if (!response.writableEnded) stream.destroy();
      });
    });
  }

  function sendIndex(request, response) {
    sendFile(request, response, path.join(webRoot, "index.html"), "/index.html", true);
  }

  return function serveWeb(request, response) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end();
        return;
      }
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      } catch {
        sendStatus(response, 400);
        return;
      }
      // NUL 字节会让 fs 同步抛 ERR_INVALID_ARG_VALUE（不走回调）：请求挂起、异常逃逸到进程级
      if (pathname.includes("\0")) {
        sendStatus(response, 400);
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      const file = path.join(webRoot, pathname);
      const relativePath = path.relative(webRoot, file);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        sendStatus(response, 403);
        return;
      }
      sendFile(request, response, file, pathname, false);
    } catch (requestError) {
      log("静态资源请求异常:", requestError.message);
      sendStatus(response, 500);
    }
  };
}

/** GET /healthz 的正文：只给计数和版本，不给房间名、路径、设备名 */
function healthBody(rooms, startedAt, serverName) {
  const roomList = rooms.list();
  let devices = [];
  try {
    devices = rooms.deviceSnapshot().filter((device) => device.id !== UNREGISTERED_DEVICE);
  } catch (rosterError) {
    log("healthz 读设备名册失败:", rosterError.message);
  }
  return {
    ok: true,
    proto: PROTOCOL.proto,
    version: RELAY_VERSION,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...(serverName ? { serverName } : null),
    rooms: { online: roomList.filter((room) => room.online).length, total: roomList.length },
    devices: { online: devices.filter((device) => device.online).length, total: devices.length },
    viewers: rooms.viewers.size,
  };
}

module.exports = { makeServeWeb, healthBody };
