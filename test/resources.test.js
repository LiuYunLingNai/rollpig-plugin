import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Run with: node --test test/resources.test.js
// Node 20 supports VM modules behind a flag; enable it only in this suite's child process.
// Load production modules with a stub host: no plugin initialization, credentials or real HTTP.
const resourceTest = typeof vm.SourceTextModule === 'function' ? test : () => {};
if (typeof vm.SourceTextModule !== 'function') {
  test('resource lifecycle and security suite', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--experimental-vm-modules', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
const root = fileURLToPath(new URL('../', import.meta.url));
const BASE = 'https://pig.felislab.cc/resources/rollpig/manifest.json';
const GIF = 'https://pig.felislab.cc/resources/rollpig-gif/manifest.json';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollpig-resources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const Path = {
    data: dir,
    pigHubCache: path.join(dir, 'pighub.json'),
    resourceCache: path.join(dir, 'resources'),
    activeResourceDir: path.join(dir, 'resources', 'active'),
    activeImageDir: path.join(dir, 'resources', 'active', 'images'),
    resourceStateFile: path.join(dir, 'resources', 'state.json'),
    gifOverlayDir: path.join(dir, 'resources', 'gif-overlay'),
    gifOverlayImageDir: path.join(dir, 'resources', 'gif-overlay', 'images'),
    gifOverlayStateFile: path.join(dir, 'resources', 'gif-overlay', 'state.json'),
    image: path.join(dir, 'builtin', 'images'),
    pigJson: path.join(dir, 'builtin', 'pig.json'),
    rulesJson: path.join(dir, 'builtin', 'pig_rules.json'),
    exVariantsJson: path.join(dir, 'builtin', 'pig_ex_variants.json'),
  };
  const controller = new AbortController();
  const routes = new Map();
  const routeBodies = new WeakMap();
  const calls = [];
  const logs = [];
  let cfg = { ai_enabled: false, ai_api_key: '' };
  const host = {
    getContext: () => ({ signal: controller.signal }),
    logger: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push([level, ...args])])),
    async hostFetch(url, options = {}) {
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      signal.throwIfAborted();
      calls.push({ url, ...options, signal });
      assert.ok(routes.has(url), `Unmocked request: ${url}`);
      const route = routes.get(url);
      if (typeof route === 'function') return route({ ...options, signal });
      if (!routeBodies.has(route)) routeBodies.set(route, await route.arrayBuffer());
      return new Response(routeBodies.get(route), { status: route.status, headers: route.headers });
    },
  };
  const context = vm.createContext({ Buffer, URL, AbortController, setTimeout, clearTimeout });
  const cache = new Map();
  function synthetic(key, values) {
    if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context, identifier: key }));
    return cache.get(key);
  }
  async function resolve(specifier, parent) {
    if (specifier === 'fs') return synthetic('fs', { default: fs });
    if (specifier === 'path') return synthetic('path', { default: path });
    if (specifier === 'crypto') return synthetic('crypto', { default: crypto });
    const filename = path.resolve(path.dirname(parent.identifier), specifier);
    if (filename === path.join(root, 'host', 'index.js')) return synthetic(filename, host);
    if (filename === path.join(root, 'constants', 'path.js')) return synthetic(filename, { default: Path });
    if (filename === path.join(root, 'lib', 'model', 'config.js')) return synthetic(filename, { default: { get: () => cfg } });
    if (!cache.has(filename)) cache.set(filename, new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename }));
    return cache.get(filename);
  }
  async function load(relative) {
    const filename = path.join(root, relative);
    const module = await resolve(`./${path.basename(filename)}`, { identifier: path.join(path.dirname(filename), 'entry.js') });
    if (module.status === 'unlinked') await module.link(resolve);
    if (module.status === 'linked') await module.evaluate();
    return module.namespace;
  }
  function write(filename, content) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  }
  function meta(relative, content, filename) {
    const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content));
    const entry = { path: relative, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    if (filename) entry.filename = filename;
    return { entry, bytes };
  }
  function baseManifest(version = 'v1') {
    const pigs = meta('pig.json', [{ id: 'pig', name: '测试小猪' }]);
    const image = meta('images/pig.png', 'png-test-data', 'pig.png');
    const manifest = { resource_version: version, pig_json: pigs.entry, images: [image.entry] };
    routes.set(BASE, Response.json(manifest));
    routes.set(new URL(pigs.entry.path, BASE).href, new Response(pigs.bytes));
    routes.set(new URL(image.entry.path, BASE).href, new Response(image.bytes));
    return manifest;
  }
  return { Path, controller, routes, calls, logs, load, write, meta, baseManifest, setConfig: (value) => { cfg = value; } };
}

resourceTest('base and GIF sync preserve incrementality, version reporting and image priority', async (t) => {
  const f = await fixture(t);
  f.baseManifest();
  const sync = await f.load('lib/resource/resourceSync.js');
  const first = await sync.syncBaseResource();
  assert.equal(first.updated, true);
  assert.equal(first.images, 1);
  assert.equal(fs.readFileSync(path.join(f.Path.activeImageDir, 'pig.png'), 'utf8'), 'png-test-data');
  f.calls.length = 0;
  assert.equal((await sync.syncBaseResource()).skipped, true);
  assert.deepEqual(f.calls.map((call) => call.url), [BASE]);
  fs.writeFileSync(path.join(f.Path.activeImageDir, 'pig.png'), 'corrupt');
  f.calls.length = 0;
  assert.equal((await sync.syncBaseResource()).updated, true);
  assert.deepEqual(f.calls.map((call) => call.url), [BASE, new URL('images/pig.png', BASE).href]);

  const gif = f.meta('images/pig.gif', 'gif-test-data', 'pig.gif');
  f.routes.set(GIF, Response.json({ resource_version: 'gif-v1', images: [gif.entry] }));
  f.routes.set(new URL(gif.entry.path, GIF).href, new Response(gif.bytes));
  await sync.syncGifOverlay();
  assert.equal(sync.getSyncState().base, 'v1');
  assert.equal(sync.getSyncState().gif, 'gif-v1');
  f.write(f.Path.pigJson, [{ id: 'pig', name: 'builtin' }]);
  f.write(path.join(f.Path.image, 'pig.png'), 'builtin');
  const manager = (await f.load('lib/resource/resourceManager.js')).default;
  assert.equal(manager.resourceVersion, 'cloud');
  assert.equal(manager.findImageFile('pig'), path.join(f.Path.gifOverlayImageDir, 'pig.gif'));
  assert.ok(f.logs.some(([level]) => level === 'info'));
  assert.ok(!fs.readdirSync(f.Path.resourceCache).some((name) => name.startsWith('.staging_')));
});

resourceTest('reject unsafe asset names, URL paths, duplicate targets and invalid metadata before downloading', async (t) => {
  const f = await fixture(t);
  const sync = await f.load('lib/resource/resourceSync.js');
  const unsafeNames = ['../evil.png', '..\\evil.png', '/evil.png', 'C:evil.png', 'x.png:stream', 'NUL.png', 'CON.png', 'x.png.', '%2e%2e.png', 'x?.png', 'x\0.png', 'image.zip', 'script.js'];
  for (const filename of unsafeNames) {
    assert.throws(() => sync.validateAssetFilename(filename));
    const manifest = f.baseManifest();
    manifest.images[0].filename = filename;
    f.routes.set(BASE, Response.json(manifest));
    f.calls.length = 0;
    await assert.rejects(sync.syncBaseResource());
    assert.deepEqual(f.calls.map((call) => call.url), [BASE]);
  }
  for (const relative of ['../pig.json', '%2e%2e/pig.json', '//evil.test/pig.json', 'https://evil.test/pig.json', 'C:evil.json', 'pig.json?x=1', 'pig.json#x']) {
    const manifest = f.baseManifest();
    manifest.pig_json.path = relative;
    f.routes.set(BASE, Response.json(manifest));
    await assert.rejects(sync.syncBaseResource(), /路径非法/);
  }
  const duplicate = f.baseManifest();
  duplicate.images.push({ ...duplicate.images[0], filename: 'PIG.PNG' });
  f.routes.set(BASE, Response.json(duplicate));
  await assert.rejects(sync.syncBaseResource(), /重复/);
  for (const patch of [{ size: -1 }, { size: 'NaN' }, { sha256: 'bad' }]) {
    const manifest = f.baseManifest();
    Object.assign(manifest.pig_json, patch);
    f.routes.set(BASE, Response.json(manifest));
    await assert.rejects(sync.syncBaseResource());
  }
  f.routes.set(BASE, Response.json({ resource_version: 'v1', images: [] }));
  await assert.rejects(sync.syncBaseResource(), /缺少 pig_json/);
  assert.equal(fs.existsSync(f.Path.activeResourceDir), false);
});

resourceTest('resource lookups reject traversal IDs and EX filenames', async (t) => {
  const f = await fixture(t);
  f.write(f.Path.pigJson, [{ id: 'pig' }]);
  f.write(path.join(f.Path.image, 'pig.png'), 'valid');
  f.write(path.join(f.Path.image, '..', 'secret.png'), 'secret');
  const manager = (await f.load('lib/resource/resourceManager.js')).default;
  for (const id of ['../secret', '..\\secret', 'C:secret', 'NUL', '%2e%2e/secret']) {
    assert.equal(manager.findImageFile(id), null);
  }
  assert.equal(manager.findNamedImageFile('../secret.png'), null);
  assert.equal(manager.findNamedImageFile('pig.png'), path.join(f.Path.image, 'pig.png'));
  f.write(f.Path.exVariantsJson, { variants: [{ pig_id: 'pig', level: 1, filename: '../secret.png', description: 'valid text' }] });
  manager.reload();
  const resolved = manager.resolvePigAppearance({ id: 'pig' }, 1);
  assert.equal(resolved.image_path, path.join(f.Path.image, 'pig.png'));
  assert.equal(resolved.pig_data.description, 'valid text');
});

resourceTest('failed hash/size checks and unload never replace active resources or leave staging', async (t) => {
  const f = await fixture(t);
  f.baseManifest();
  const sync = await f.load('lib/resource/resourceSync.js');
  await sync.syncBaseResource();
  const previous = fs.readFileSync(f.Path.resourceStateFile, 'utf8');
  for (const content of ['wrong-size', 'bad-test-data']) {
    f.baseManifest('v2');
    f.routes.set(new URL('images/pig.png', BASE).href, new Response(content));
    fs.writeFileSync(path.join(f.Path.activeImageDir, 'pig.png'), 'png-test-data');
    // Changed digest forces a download rather than reuse.
    const manifest = f.baseManifest('v2');
    manifest.images[0].sha256 = '0'.repeat(64);
    f.routes.set(BASE, Response.json(manifest));
    f.routes.set(new URL('images/pig.png', BASE).href, new Response(content));
    await assert.rejects(sync.syncBaseResource(), /校验失败/);
    assert.equal(fs.readFileSync(f.Path.resourceStateFile, 'utf8'), previous);
    assert.equal(fs.readFileSync(path.join(f.Path.activeImageDir, 'pig.png'), 'utf8'), 'png-test-data');
    assert.ok(!fs.readdirSync(f.Path.resourceCache).some((name) => name.startsWith('.staging_')));
  }
  const manifest = f.baseManifest('v2');
  manifest.images[0].sha256 = '0'.repeat(64);
  f.routes.set(BASE, Response.json(manifest));
  f.routes.set(new URL('images/pig.png', BASE).href, () => new Response(new ReadableStream({
    pull(stream) {
      f.controller.abort();
      stream.enqueue(Buffer.from('png-test-data'));
      stream.close();
    },
  })));
  await assert.rejects(sync.syncBaseResource(), /abort/i);
  assert.equal(fs.readFileSync(f.Path.resourceStateFile, 'utf8'), previous);
  assert.ok(!fs.readdirSync(f.Path.resourceCache).some((name) => name.startsWith('.staging_')));
});

resourceTest('an already unloaded context cannot create resource directories or start requests', async (t) => {
  const f = await fixture(t);
  const sync = await f.load('lib/resource/resourceSync.js');
  f.controller.abort();
  await assert.rejects(sync.syncBaseResource(), /abort/i);
  await assert.rejects(sync.syncGifOverlay(), /abort/i);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.Path.resourceCache), false);
});

resourceTest('size limits stop streaming responses early', async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  f.routes.set(BASE, () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(Buffer.alloc(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  const sync = await f.load('lib/resource/resourceSync.js');
  await assert.rejects(sync.syncBaseResource(), /大小上限/);
  assert.equal(cancelled, true);
});

resourceTest('reuse failure downloads missing staging files instead of skipping them', async (t) => {
  const f = await fixture(t);
  f.baseManifest();
  const sync = await f.load('lib/resource/resourceSync.js');
  await sync.syncBaseResource();
  const link = fs.linkSync;
  const copy = fs.copyFileSync;
  try {
    fs.linkSync = () => { throw new Error('no links'); };
    fs.copyFileSync = () => { throw new Error('no copies'); };
    f.calls.length = 0;
    assert.equal((await sync.syncBaseResource({ force: true })).updated, true);
    assert.equal(f.calls.length, 3);
    assert.equal(fs.readFileSync(path.join(f.Path.activeImageDir, 'pig.png'), 'utf8'), 'png-test-data');
  } finally {
    fs.linkSync = link;
    fs.copyFileSync = copy;
  }
});

resourceTest('PigHub retains fallback APIs and cache but stops retries/writes on unload', async (t) => {
  const f = await fixture(t);
  const api = 'https://pighub.top/api/images?sort=2&limit=200';
  const fallback = 'https://pighub.top/api/images?sort=2';
  f.routes.set(api, new Response('', { status: 500 }));
  f.routes.set(fallback, Response.json({ images: [{ thumbnail: 'pig.png', title: '小猪' }] }));
  const hub = (await f.load('lib/flow/pighub.js')).default;
  assert.equal(await hub.ensureReady(), true);
  assert.equal(hub.images.length, 1);
  assert.equal(fs.existsSync(f.Path.pigHubCache), true);
  assert.equal(f.calls[0].headers['User-Agent'], 'RollPig-Yunzai/1.0');
  const saved = fs.readFileSync(f.Path.pigHubCache, 'utf8');
  f.calls.length = 0;
  f.routes.set(api, () => {
    f.controller.abort();
    return Response.json({ images: [{ thumbnail: 'new.png' }] });
  });
  assert.equal(await hub.refresh(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(f.Path.pigHubCache, 'utf8'), saved);
  assert.equal(hub.images[0].thumbnail, 'pig.png');
});

resourceTest('roast uses templates by default; mocked AI preserves POST payload and falls back on unload', async (t) => {
  const f = await fixture(t);
  const roast = (await f.load('lib/flow/roastManager.js')).default;
  const origin = { name: '原猪' };
  const food = { name: '熟猪' };
  assert.match(await roast.getRoastText(origin, food), /原猪.*熟猪/);
  assert.equal(f.calls.length, 0);
  const url = 'https://example.invalid/v1/chat/completions';
  f.setConfig({ ai_enabled: true, ai_api_key: 'TEST-NOT-A-CREDENTIAL', ai_base_url: 'https://example.invalid', ai_model: 'test-model' });
  f.routes.set(url, Response.json({ choices: [{ message: { content: 'mock\ntext' } }] }));
  assert.equal(await roast.getRoastText(origin, food), 'mock text');
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(JSON.parse(f.calls[0].body).model, 'test-model');
  assert.ok(f.calls[0].signal instanceof AbortSignal);
  f.routes.set(url, () => {
    f.controller.abort();
    return Response.json({ choices: [{ message: { content: 'must not use' } }] });
  });
  assert.match(await roast.getRoastText(origin, food), /原猪.*熟猪/);
});
