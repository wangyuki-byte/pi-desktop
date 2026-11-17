import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const openedUrls = [];
const notifications = [];
// Mocked modules live in data: URLs without closure access; bridge through the shared global.
globalThis.__uiExtOpenedUrls = openedUrls;
globalThis.__uiExtNotifications = notifications;

registerHooks({
  resolve(specifier, context, nextResolve) {
    let source;
    if (specifier === 'electron') source = `
      export const Notification = Object.assign(function MockNotification(options) {
        globalThis.__uiExtNotifications?.push(options);
      }, { isSupported: () => true });
    `;
    if (specifier === './appLocale') source = "export const getAppLocale = () => 'zh-CN';";
    if (specifier === './externalLinks') source = 'export const openExternalHttpUrl = (url) => globalThis.__uiExtOpenedUrls.push(url);';
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { parseUiExtensionConfig } = await import('../packages/shared/src/uiExtensions.ts');
const { createUiExtensionsService } = await import('../packages/desktop/src/main/uiExtensionsService.ts');

function validElement(overrides = {}) {
  return { id: 'run-tests', slot: 'top-bar', icon: 'play', label: 'Run tests', order: 10, action: { type: 'prompt', value: '跑一下测试' }, ...overrides };
}

function createServiceHome() {
  const home = mkdtempSync(join(tmpdir(), 'pi-ui-extensions-'));
  // The watcher targets ~/.pi; it must exist before startWatching runs.
  mkdirSync(join(home, '.pi'), { recursive: true });
  return home;
}

function writeConfig(home, payload) {
  mkdirSync(join(home, '.pi', 'desktop-ui'), { recursive: true });
  writeFileSync(join(home, '.pi', 'desktop-ui', 'extensions.json'), typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function createService(home, broadcasts = []) {
  const service = createUiExtensionsService({ homeDir: home, broadcast: (snapshot) => broadcasts.push(snapshot) });
  service.start();
  return service;
}

test('config parser accepts a healthy elements array and sorts by order', () => {
  const parsed = parseUiExtensionConfig({ version: 1, elements: [validElement({ id: 'b', order: 30 }), validElement({ id: 'a', order: 20 })] });
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.elements.map((element) => element.id), ['a', 'b']);
});

test('config parser allows an absent elements array as an empty healthy state', () => {
  assert.deepEqual(parseUiExtensionConfig({}), { elements: [], error: null });
  assert.deepEqual(parseUiExtensionConfig({ version: 1 }), { elements: [], error: null });
});

test('config parser rejects malformed elements with a diagnostic', () => {
  const cases = [
    [null, '根节点'],
    [{ elements: 'nope' }, '数组'],
    [{ elements: [validElement({ id: 'bad id!' })] }, 'id'],
    [{ elements: [validElement({ slot: 'status-bar' })] }, 'top-bar'],
    [{ elements: [validElement({ icon: '' })] }, 'icon'],
    [{ elements: [validElement({ label: '' })] }, 'label'],
    [{ elements: [validElement({ action: { type: 'eval', value: 'x' } })] }, 'action.type'],
    [{ elements: [validElement({ action: { type: 'url', value: 'javascript:alert(1)' } })] }, 'http'],
    [{ elements: [validElement({ action: { type: 'script', value: 'C:\\evil.cmd' } })] }, '相对路径'],
    [{ elements: [validElement({ action: { type: 'script', value: '..\\evil.cmd' } })] }, '".."'],
    [{ elements: [validElement(), validElement()] }, '重复'],
    [{ elements: Array.from({ length: 33 }, (_, index) => validElement({ id: `e${index}` })) }, '32'],
    [{ elements: [validElement({ source: 'extension:pix' })] }, 'source'],
  ];
  for (const [payload, fragment] of cases) {
    const parsed = parseUiExtensionConfig(payload);
    assert.notEqual(parsed.error, null, `expected rejection for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.ok(parsed.elements.length === 0);
    assert.ok(parsed.error.includes(fragment), `diagnostic "${parsed.error}" should mention ${fragment}`);
  }
});

test('service reports an empty healthy snapshot without a config file', async () => {
  const home = createServiceHome();
  const broadcasts = [];
  const service = createService(home, broadcasts);
  assert.deepEqual(service.getSnapshot(), { version: 1, elements: [], error: null });
  // The startup broadcast goes through the settle debounce; wait it out.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(broadcasts.length, 1);
  service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('service surfaces diagnostics for invalid JSON and invalid elements', async () => {
  const home = createServiceHome();
  const service = createService(home);
  // Diagnostics arrive through the watcher debounce; wait for each write to settle.
  writeConfig(home, '{ not json');
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(service.getSnapshot().error?.includes('JSON'));
  writeConfig(home, { elements: [validElement({ id: 'x y' })] });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(service.getSnapshot().error?.includes('id'));
  service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('service loads a valid config and executes url/script actions', async () => {
  const home = createServiceHome();
  writeConfig(home, { version: 1, elements: [validElement({ id: 'open-docs', action: { type: 'url', value: 'https://example.com/docs' } }), validElement({ id: 'run-sync', action: { type: 'script', value: 'noop.cmd' } })] });
  mkdirSync(join(home, '.pi', 'desktop-ui', 'scripts'), { recursive: true });
  writeFileSync(join(home, '.pi', 'desktop-ui', 'scripts', 'noop.cmd'), '@echo ok\r\n');
  const service = createService(home);
  assert.deepEqual(service.getSnapshot().elements.map((element) => element.id), ['open-docs', 'run-sync']);
  await service.invoke('open-docs');
  assert.deepEqual(openedUrls, ['https://example.com/docs']);
  await service.invoke('run-sync');
  // Let the spawned cmd.exe settle so its exit callback lands inside the test.
  await new Promise((resolve) => setTimeout(resolve, 500));
  service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('service rejects unknown elements and renderer-side actions', async () => {
  const home = createServiceHome();
  writeConfig(home, { version: 1, elements: [validElement({ id: 'ask', action: { type: 'prompt', value: 'hi' } })] });
  const service = createService(home);
  await assert.rejects(() => service.invoke('missing'), /不存在/);
  await assert.rejects(() => service.invoke('ask'), /会话侧/);
  service.stop();
  rmSync(home, { recursive: true, force: true });
});

test('service notices config edits through the filesystem watch', async () => {
  const home = createServiceHome();
  const broadcasts = [];
  const service = createService(home, broadcasts);
  writeConfig(home, { version: 1, elements: [validElement({ id: 'watched' })] });
  // Watcher + refresh + broadcast debounces together settle well under 1.5s.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(broadcasts.some((snapshot) => snapshot.elements.some((element) => element.id === 'watched')), 'expected a broadcast carrying the new element');
  service.stop();
  rmSync(home, { recursive: true, force: true });
});
