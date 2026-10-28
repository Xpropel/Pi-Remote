/**
 * 新建会话页的预选种子（内存态，不碰浏览器存储）：
 * 侧栏组头「＋」/ 设备行「＋」先 setNewSessionSeed 再 act.newSession()；
 * 新建会话页挂载时 takeNewSessionSeed() 读一次并清空（同一会话内有效，刷新即清，符合"不直接碰存储"的独立性约束）。
 */
export type NewSessionSeed = { deviceId?: string; folder?: string }

let seed: NewSessionSeed | null = null

export function setNewSessionSeed(next: NewSessionSeed): void {
  seed = { ...next }
}

/** 读一次并清空（避免下次进新建页又带上次的预选） */
export function takeNewSessionSeed(): NewSessionSeed | null {
  const current = seed
  seed = null
  return current
}
