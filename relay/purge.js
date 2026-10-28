"use strict";
/**
 * 删除后清理服务器副本（P9 B）。
 *
 * 设备确认删除成功以后，relay 上这个会话的每一份副本都要清掉：
 *   1. 房间表里的离线房间（在线房间跳过——正在运行的会话不该被删；RoomMap.delete 会一起清 resend/TTL 定时器）
 *   2. 正文存储（内存热缓存 + data/rooms/<id>.jsonl + 检查点）
 *   3. 会话库正文（dev.archives 里设备在线时转给网页的那份）
 *   4. 会话索引里的旧行 → 只留最小墓碑（index.forgetSession）
 * 清完向声明了 session.purge 的 viewer 广播 session_removed，并刷新 room_list。
 *
 * 幂等：已经不存在的副本再清一遍不报错；在线房间永远不动，也不会出现在广播的 ids 里。
 * 广播只包含「正文副本确实清掉、且索引墓碑确实立住」的 id：删文件失败还广播「已删除」会让网页误以为删成功，
 * relay 重启后会话完整复活（报告 relay 中-4）；forgetSession 返回 false 不抛错时同理，
 * 旧行还在却广播，同样会让会话复活成空壳（R-2）。
 */
const fs = require("node:fs");
const { broadcast, hasCap } = require("./wire");
const { log } = require("./util");

/**
 * 删掉存储里的正文副本，返回是否确实清掉。
 * store.drop() 的旧实现会吞掉 unlink 失败且不返回成败，所以这里在调用后用「房文件是否还在」
 * 兜底核对（新实现若显式返回 false，也按失败处理）。核对本身出错一律保守判失败，等下次重试。
 */
function dropStoredRoom(store, id) {
  let result;
  try {
    result = store.drop(id);
  } catch (e) {
    log("purge store.drop 失败:", id, e.message);
    return false;
  }
  if (result === false) return false;
  try {
    if (typeof store.roomFileExists === "function") return !store.roomFileExists(id);
    const file = typeof store._file === "function" ? store._file(id) : "";
    if (file) return !fs.existsSync(file);
  } catch (e) {
    log("purge 核对正文删除结果失败:", id, e.message);
    return false;
  }
  return true;
}

/**
 * @param {{accountId:string, deviceId:string, ids:string[], rooms:object, store:object,
 *          devices:Map<string,object>, index:object, cfg:object}} args
 * @returns {string[]} 真正清掉的 id（在线房间被跳过、正文删除失败的不算）
 */
function purgeSessions({ accountId, deviceId, ids, rooms, store, devices, index, cfg }) {
  const done = [];
  const dev = devices.get(deviceId);
  for (const raw of ids || []) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) continue;
    const room = rooms.peek(id);
    // 在线房间 = 会话正在运行：不删副本（routeDeleteSession 已先拦一道，这里兜底）
    if (room && room.online) continue;
    // 先删正文再动房间/索引：删失败时什么都不广播，网页仍看得到这条会话，用户重试还能真正清掉。
    if (!dropStoredRoom(store, id)) {
      log("purge 正文删除失败，保留会话等待重试:", id);
      continue;
    }
    if (room) {
      // 还有网页在看这个离线房间：先让它收成离线，再从房间表移除（不然界面停在幽灵会话上）
      if (room.viewers.size) broadcast([...room.viewers], { type: "room_offline", room: id }, cfg);
      rooms.map.delete(id);
    }
    if (dev && dev.archives) dev.archives.delete(id);
    // forgetSession 失败有两种形态：抛错，或返回 false 不抛错（参数不合/墓碑写盘失败）。
    // 只套 try/catch 会把 return false 当成功：索引旧行（带会话名/路径）还在，却广播了
    // session_removed，会话随即在清单里「复活」成空壳（R-2）。返回值也要查：
    // 墓碑没立住就不计入 done、不广播，索引行还留在盘上，下一轮 purge 能按它重试 forget。
    let forgot = false;
    try {
      forgot = index.forgetSession(accountId, deviceId, id, Date.now()) !== false;
    } catch (e) {
      log("purge 索引失败:", id, e.message);
    }
    if (!forgot) {
      log("purge 索引墓碑未立住，本轮不广播 session_removed，等待下轮重试:", id);
      continue;
    }
    done.push(id);
  }
  if (done.length) {
    // 新面只发给声明 session.purge 的端；旧网页靠自己的兼容逻辑（本地隐藏表）照常工作
    broadcast([...rooms.viewers].filter((v) => hasCap(v, "session.purge")), {
      type: "session_removed",
      deviceId,
      ids: done,
    }, cfg);
    rooms.broadcastRoomList();
  }
  return done;
}

module.exports = { purgeSessions };
