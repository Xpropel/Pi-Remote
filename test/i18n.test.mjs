import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createJiti } from 'jiti'
const require = createRequire(import.meta.url)
const ts = require('../ui/node_modules/typescript')
const root = new URL('../ui/', import.meta.url).pathname
const jiti = createJiti(import.meta.url, { interopDefault: false })
const { EN } = await jiti.import(path.join(root, 'src/i18n/en.ts'))
const { translate, template } = await jiti.import(path.join(root, 'src/i18n/index.ts'))
const { resolveLanguage, readLanguage, installLanguageSync } = await jiti.import(path.join(root, 'src/i18n/locale.ts'))
const { transformMessages, productModule, sourceMessage, excludedNode } = await jiti.import(path.join(root, 'i18n-plugin.ts'))

function evaluate(code) {
  const transformed = transformMessages(code, path.join(root, 'src/example.tsx'))
  const input = (transformed?.code ?? code).replace(/^import[^\n]+\n/, '')
  const compiled = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
  const exports = {}
  new Function('__piTranslate', '__piTemplate', '__piLocale', 'exports', compiled)(translate, template, () => 'en', exports)
  return exports
}

test('language resolution respects a saved choice and otherwise follows browser language', () => {
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en')
  assert.equal(resolveLanguage('zh-CN', 'en-US'), 'zh-CN')
  assert.equal(resolveLanguage(undefined, 'zh-TW'), 'zh-CN')
  assert.equal(resolveLanguage(undefined, 'en-GB'), 'en')
  assert.equal(resolveLanguage('invalid', 'de-DE'), 'en')
  assert.equal(resolveLanguage(undefined), 'en')
})

test('storage failure and malformed/old settings safely fall back to browser language', () => {
  const original = globalThis.window
  try {
    globalThis.window = { localStorage: { getItem: () => '{broken' } }
    assert.equal(readLanguage(), 'en')
    globalThis.window.localStorage.getItem = () => JSON.stringify({ v: 999, prefs: { language: 'zh-CN' } })
    assert.equal(readLanguage(), 'en')
    globalThis.window.localStorage.getItem = () => JSON.stringify({ v: 1, prefs: { language: 'zh-CN' } })
    assert.equal(readLanguage(), 'zh-CN')
    globalThis.window.localStorage.getItem = () => { throw new Error('denied') }
    assert.equal(readLanguage(), 'en')
  } finally { globalThis.window = original }
})

test('language changes update document language and reload on same-tab/cross-tab events', () => {
  const previous = { window: globalThis.window, document: globalThis.document }
  let saved = 'en', reloads = 0
  const listeners = new Map()
  globalThis.window = {
    localStorage: { getItem: () => JSON.stringify({ v: 1, prefs: { language: saved } }) },
    location: { reload: () => reloads++ },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  }
  globalThis.document = { documentElement: { lang: '' } }
  try {
    const dispose = installLanguageSync()
    assert.equal(document.documentElement.lang, 'en')
    listeners.get('pi-remote:settings-prefs')()
    assert.equal(reloads, 0)
    saved = 'zh-CN'
    listeners.get('storage')({ key: 'irrelevant' })
    assert.equal(reloads, 0)
    listeners.get('pi-remote:settings-prefs')()
    listeners.get('storage')({ key: 'pi_remote_pi_settings_v2' })
    assert.equal(reloads, 2)
    dispose()
    assert.equal(listeners.size, 0)
  } finally { Object.assign(globalThis, previous) }
})

test('catalog preserves all placeholders and has English translations', () => {
  assert.ok(Object.keys(EN).length > 2000)
  for (const [source, english] of Object.entries(EN)) {
    assert.ok(english.trim(), source)
    assert.ok(!/\p{Script=Han}/u.test(english), source)
    assert.deepEqual((english.match(/\{\d+\}/g) ?? []).sort(), (source.match(/\{\d+\}/g) ?? []).sort(), source)
  }
})

test('interpolation preserves user content, braces, code and unknown messages', () => {
  assert.equal(translate('已连接', [], 'en'), 'Connected')
  assert.equal(translate('已连接', [], 'zh-CN'), '已连接')
  const name = '用户 {0} <script>alert(1)</script>'
  assert.equal(translate('{0} 离线', [name], 'en'), name + ' offline')
  assert.equal(translate('not in catalog {0}', ['unchanged'], 'en'), 'not in catalog unchanged')
  assert.equal(translate('__proto__', [], 'en'), '__proto__')
})

test('compiled UI translates strings, templates and comparisons together, not dynamic content', () => {
  const { status, online, message, echo } = evaluate(`
    export const status = "已连接";
    export const online = status === "已连接";
    export const message = (name: string) => \`\${name} 离线\`;
    export const echo = (value: string) => value;
  `)
  assert.equal(status, 'Connected')
  assert.equal(online, true)
  assert.equal(message('我的电脑 {0}'), '我的电脑 {0} offline')
  assert.equal(echo('已连接'), '已连接')
})

test('JSX text/accessible props are translated while types, keys, selectors and code templates are untouched', () => {
  const code = `type State = "已连接"; const x = {"已连接": true};
    const selector = document.querySelector('[aria-label="搜索会话"]');
    const raw = String.raw\`已连接\`;
    export const view = <button title="确认">发送</button>;`
  const transformed = transformMessages(code, path.join(root, 'src/example.tsx')).code
  assert.match(transformed, /type State = "已连接"/)
  assert.match(transformed, /\{"已连接": true\}/)
  assert.match(transformed, /String.raw`已连接`/)
  assert.match(transformed, /querySelector\('\[aria-label="搜索会话"\]'\)/)
  assert.match(transformed, /title=\{__piTranslate\("确认"\)\}/)
  assert.match(transformed, /\{__piTranslate\("发送"\)\}/)
  assert.equal(transformMessages('"已连接"', path.join(root, 'src/pi/dev/fixture.ts')), null)
})

test('approval bridge values and unregistered device IDs remain protocol values in English', () => {
  const code = fs.readFileSync(path.join(root, 'src/pi/model/dialogCard.ts'), 'utf8')
  const gate = evaluate(code)
  const options = ['允许一次', '本会话都允许', '拒绝']
  assert.equal(gate.dialogIsApproval({ kind: 'select', options }), true)
  assert.equal(gate.dialogIsApproval({ kind: 'select', options: ['是', '否'] }), false)
  assert.deepEqual(options, ['允许一次', '本会话都允许', '拒绝'])
  assert.equal(translate(options[0], [], 'en'), 'Allow once')
  assert.equal(translate(options[2], [], 'en'), 'Deny')
  assert.deepEqual(gate.approvalPartsOf({ title: 'Allow edit outside the workspace? /tmp/用户文件' }), {
    question: 'Allow edit outside the workspace?', command: '/tmp/用户文件',
  })
  assert.deepEqual(gate.approvalPartsOf({ title: 'Allow bash? echo ok', message: 'echo ok\necho next' }), {
    question: 'Allow bash?', command: 'echo ok\necho next',
  })
  const marker = evaluate('export const id = /* i18n-ignore: protocol value */ "未登记设备"')
  assert.equal(marker.id, '未登记设备')
})

test('JSX entities and inline whitespace survive translation', () => {
  const code = '<p>deploy/attach.sh --pair &lt;配对码&gt;</p>'
  const output = transformMessages(code, path.join(root, 'src/example.tsx')).code
  assert.ok(output.includes(JSON.stringify('deploy/attach.sh --pair <配对码>')))
  assert.equal(translate('deploy/attach.sh --pair <配对码>', [], 'en'), 'deploy/attach.sh --pair <pairing code>')
  assert.equal(translate(' 已连接 ', [], 'en'), ' Connected ')
})

test('all product-owned Chinese messages have a catalog entry', () => {
  const missing = []
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { if (!['dev', 'i18n'].includes(entry.name)) walk(file); continue }
      if (!productModule(file)) continue
      const code = fs.readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      function visit(node) {
        if (excludedNode(node)) return
        const message = sourceMessage(node)
        if (message && /\p{Script=Han}/u.test(message) && !Object.hasOwn(EN, message) && !Object.hasOwn(EN, message.trim())) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          missing.push({ file: path.relative(root, file), line, message })
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  walk(path.join(root, 'src'))
  assert.deepEqual(missing, [])
})
