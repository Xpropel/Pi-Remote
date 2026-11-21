import { EN } from "./en.ts"
import { JA } from "./ja.ts"
import { KO } from "./ko.ts"
import { ES } from "./es.ts"
import { FR } from "./fr.ts"
import { getLanguage, type Language } from "./locale.ts"
export { getLanguage } from "./locale.ts"

/** Non-source catalogs by language; zh-CN is the source language and needs none. */
export const CATALOGS: Partial<Record<Language, Record<string, string>>> = { en: EN, ja: JA, ko: KO, es: ES, fr: FR }

function lookup(catalog: Record<string, string>, source: string): string | null {
  if (Object.hasOwn(catalog, source)) return catalog[source]
  const trimmed = source.trim()
  if (Object.hasOwn(catalog, trimmed)) {
    return (source.match(/^\s+/)?.[0] ?? "") + catalog[trimmed] + (source.match(/\s+$/)?.[0] ?? "")
  }
  return null
}

/** Exact source copy and recognized approval labels only; never free-form user/session text. */
export function translate(source: string, values: readonly unknown[] = [], language: Language = getLanguage()): string {
  let message = source
  if (language !== "zh-CN") {
    const catalog = CATALOGS[language]
    // A missing entry falls back to English before the Chinese source, so a
    // lagging catalog degrades to English instead of mixing in Chinese.
    message = (catalog ? lookup(catalog, source) : null) ?? lookup(EN, source) ?? source
  }
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const position = Number(index)
    return position < values.length ? String(values[position]) : placeholder
  })
}

/** Tagged templates preserve evaluation order and keep values out of the catalog. */
export function template(parts: TemplateStringsArray, ...values: unknown[]): string {
  const source = parts.reduce((message, part, index) => message + (index ? `{${index - 1}}` : "") + part, "")
  return translate(source, values)
}
