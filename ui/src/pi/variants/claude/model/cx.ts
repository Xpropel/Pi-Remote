/** 变体自带的 className 拼接（不依赖 @/lib/utils） */
export function cx(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(" ")
}
