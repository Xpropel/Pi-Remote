import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = path.join(ROOT, 'ui', 'src');
const WEB_ASSETS = path.join(ROOT, 'web', 'assets');

const SQUIRCLE_CSS_FILES = [
  'ui/src/components/pi/shared/pi-theme.css',
  'ui/src/pi/sidebar/sidebar.css',
  'ui/src/pi/settings/settings.css',
  'ui/src/pi/settings/pages/about.css',
  'ui/src/pi/settings/pages/appearance.css',
  'ui/src/pi/settings/pages/devices.css',
  'ui/src/pi/settings/pages/extensions.css',
  'ui/src/pi/settings/pages/shortcuts.css',
  'ui/src/pi/settings/pages/usage.css',
  'ui/src/pi/settings/mobile/mobile.css',
  'ui/src/pi/mobile/mobile.css',
  'ui/src/pi/usage/usage.css',
];

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectCssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCssFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

function extractLeafBlocks(css) {
  const clean = stripCssComments(css);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    const selector = match[1].trim();
    const body = match[2];
    if (!selector || selector.startsWith('@')) continue;
    blocks.push({ selector, body });
  }
  return blocks;
}

test('all Pi card, sidebar, settings, mobile, and usage CSS files declare corner-shape: squircle', () => {
  for (const rel of SQUIRCLE_CSS_FILES) {
    const full = path.join(ROOT, rel);
    const content = fs.readFileSync(full, 'utf8');
    assert.match(
      content,
      /corner-shape:\s*squircle\b/,
      `${rel} must declare corner-shape: squircle`,
    );
  }
});

test('every squircle rule pairs corner-shape: squircle with border-radius fallback (except Section 7 Tailwind bridge)', () => {
  const bridgeMarkers = [
    '[class*="rounded"]',
    '[data-pi-mark]',
    '[data-slot="pane-tab"]',
  ];

  for (const rel of SQUIRCLE_CSS_FILES) {
    const full = path.join(ROOT, rel);
    const content = fs.readFileSync(full, 'utf8');
    for (const { selector, body } of extractLeafBlocks(content)) {
      if (!/corner-shape:\s*squircle\b/.test(body)) continue;
      const isTailwindBridge =
        rel === 'ui/src/components/pi/shared/pi-theme.css' &&
        bridgeMarkers.every((m) => selector.includes(m));
      if (isTailwindBridge) continue;
      assert.match(
        body,
        /border(?:-[a-z]+){0,2}-radius\s*:/,
        `${rel} rule "${selector}" sets corner-shape: squircle without a border-radius fallback`,
      );
    }
  }
});

test('pi-theme.css Tailwind squircle bridge excludes circles, pills, zero-radius, and composer capsules', () => {
  const piTheme = fs.readFileSync(
    path.join(ROOT, 'ui/src/components/pi/shared/pi-theme.css'),
    'utf8',
  );
  const blocks = extractLeafBlocks(piTheme);
  const bridge = blocks.find(
    ({ selector, body }) =>
      selector.includes('[class*="rounded"]') &&
      /corner-shape:\s*squircle\b/.test(body),
  );
  assert.ok(bridge, 'pi-theme.css must define the Section 7 squircle bridge rule');
  for (const excluded of [
    '.rounded-full',
    '.rounded-none',
    '--cw-radius-pill)',
    '--cw-radius-composer)',
    'before:rounded-full',
  ]) {
    assert.ok(
      bridge.selector.includes(excluded),
      `pi-theme.css squircle bridge must exclude ${excluded}`,
    );
  }
});

test('zero circular or pill CSS rules (50%, 999px, 99px, 0) combine with corner-shape: squircle', () => {
  const allCss = collectCssFiles(UI_SRC);
  assert.ok(allCss.length > 0, 'expected CSS files under ui/src');
  for (const full of allCss) {
    const rel = path.relative(ROOT, full);
    const content = fs.readFileSync(full, 'utf8');
    for (const { selector, body } of extractLeafBlocks(content)) {
      if (!/corner-shape:\s*squircle\b/.test(body)) continue;
      assert.doesNotMatch(
        body,
        /border(?:-[a-z]+){0,2}-radius\s*:\s*(?:50%|999px|99px|0(?:\s+0){0,3})\s*(?:;|$)/m,
        `${rel} rule "${selector}" must not pair circular/pill/zero border-radius with corner-shape: squircle`,
      );
    }
  }
});

test('left sidebar, tablet float drawer, and mobile drawer apply 4-corner squircle island rounding across all viewports', () => {
  const piTheme = fs.readFileSync(
    path.join(ROOT, 'ui/src/components/pi/shared/pi-theme.css'),
    'utf8',
  );
  assert.doesNotMatch(
    piTheme,
    /\[data-pi-shell="desktop"\]:not\(\[data-pi-tablet\]\)/,
    'desktop island squircle rules must not exclude tablet viewports',
  );
  assert.match(
    piTheme,
    /\[data-pi-shell="desktop"\]\s+\.sb-root\[data-pi-sidebar\]\s*\{[^}]*border-radius:\s*22px;[^}]*corner-shape:\s*squircle;/s,
  );
  assert.match(
    piTheme,
    /\[data-pi-shell="desktop"\]\s+\[data-pi-sidebar-float\]\s*\{[^}]*border-radius:\s*22px;[^}]*corner-shape:\s*squircle;/s,
  );
  assert.match(
    piTheme,
    /\[data-pi-root\]\[data-pi-mode="product"\]\s+\.pm-drawer\s*\{[^}]*border-radius:\s*22px;[^}]*corner-shape:\s*squircle;/s,
  );
});

test('built web production CSS bundle preserves corner-shape: squircle', () => {
  assert.ok(fs.existsSync(WEB_ASSETS), 'web/assets directory must exist');
  const cssFiles = fs
    .readdirSync(WEB_ASSETS)
    .filter((name) => name.endsWith('.css'));
  assert.ok(cssFiles.length > 0, 'expected built CSS bundle in web/assets');
  const totalMatches = cssFiles.reduce((acc, name) => {
    const css = fs.readFileSync(path.join(WEB_ASSETS, name), 'utf8');
    const matches = css.match(/corner-shape:\s*squircle\b/g);
    return acc + (matches ? matches.length : 0);
  }, 0);
  assert.ok(
    totalMatches > 100,
    `expected >100 corner-shape: squircle declarations in web/assets/*.css, got ${totalMatches}`,
  );
});
