import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import vm from 'node:vm';
import Path from '../constants/path.js';

// Run with: node --test test/render.test.js
// Node 20 supports VM modules behind a flag; enable it only in this suite's child process.
const renderTest = typeof vm.SourceTextModule === 'function' ? test : () => {};
if (typeof vm.SourceTextModule !== 'function') {
  test('render suite', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--experimental-vm-modules', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

// Stub only injected host/domain dependencies; exercise the actual render module.
// No globals, browser, config writes, or resource-manager initialization are needed.
let context;
const setContext = (value) => { context = value; };
const config = { render_scale: 2 };
const pigs = [
  { id: '1', name: '基础猪' },
  { id: '2', name: '满级猪' },
  ...Array.from({ length: 38 }, (_, i) => ({ id: String(i + 3), name: '猪' + (i + 3) })),
];
const replacements = new Map([
  ['path', { default: path }],
  ['url', { pathToFileURL }],
  [path.join(Path.root, 'constants', 'path.js'), { default: Path }],
  [path.join(Path.root, 'host', 'index.js'), {
    getContext: () => context,
    segment: { image(data) { return { type: 'image', file: { kind: 'buffer', data } }; } },
  }],
  [path.join(Path.root, 'lib', 'model', 'config.js'), { default: { get: () => config } }],
  [path.join(Path.root, 'lib', 'resource', 'resourceManager.js'), { default: {
    pigList: pigs,
    getPigById(id) { return pigs.find(pig => pig.id === String(id)); },
    resolvePigAppearance(pig, level) {
      return { image_path: level ? 'D:/rollpig-resources/ex-' + pig.id + '.png' : '',
        base_image_path: 'D:/rollpig-resources/base-' + pig.id + '.png' };
    },
  } }],
  [path.join(Path.root, 'lib', 'model', 'runtime.js'), {
    rollpigDateStr(offset = 0) {
      const date = new Date('2026-11-01T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    },
  }],
]);
let rendering;
if (typeof vm.SourceTextModule === 'function') {
  const cache = new Map();
  function resolve(specifier, parent) {
    const key = replacements.has(specifier) ? specifier : path.resolve(path.dirname(parent.identifier), specifier);
    if (!cache.has(key)) {
      const values = replacements.get(key);
      // Use the current realm so native Uint8Array checks and strict object assertions remain meaningful.
      cache.set(key, values
        ? new vm.SyntheticModule(Object.keys(values), function () {
          for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        }, { identifier: key })
        : new vm.SourceTextModule(fs.readFileSync(key, 'utf8'), { identifier: key }));
    }
    return cache.get(key);
  }
  const module = resolve('./lib/render/render.js', { identifier: path.join(Path.root, 'entry.js') });
  await module.link(resolve);
  await module.evaluate();
  rendering = module.namespace;
}

afterEach(() => {
  setContext(undefined);
  config.render_scale = 2;
});

function capture(result = { type: 'image', file: { kind: 'buffer', data: new Uint8Array([1]) } }) {
  const calls = [];
  setContext({ async render(...args) { calls.push(args); return result; } });
  return { calls, result };
}

function assertRequest(call, templateName, selector, width) {
  const [template, data, options] = call;
  assert.equal(template, path.join(Path.resource, 'html', templateName));
  assert.ok(path.isAbsolute(template));
  assert.equal('tplFile' in data, false);
  assert.deepEqual(options, {
    selector,
    viewport: { width, scale: 2 },
    type: 'jpeg',
    tailwind: false,
    multiPage: false,
  });
  return data;
}

renderTest('pig card renders the unchanged template and returns the native segment', async () => {
  const { calls, result } = capture();
  const imagePath = path.join(Path.image, '小猪 #1.png');
  assert.equal(await rendering.renderPigCard({ name: '<小猪>', description: '介绍', analysis: '分析' }, imagePath, '3'), result);
  const data = assertRequest(calls[0], 'pig_card.html', '.card', 800);
  assert.equal(data.avatar, pathToFileURL(imagePath).href);
  assert.equal(fileURLToPath(data.avatar), imagePath);
  assert.equal(data.name, '<小猪>');
  assert.equal(data.exLevel, 3);
});

renderTest('catalog preserves EX sorting, pagination, favorites and local font/background URLs', async () => {
  const { calls } = capture();
  await rendering.renderCatalogImage({
    userName: '测试用户',
    snapshot: {
      draw_state: {
        pig_ids: ['1', '2'],
        progress: {
          '1': { expert_level: 0, copies: 7, first_obtained_at: '2026-10-31T00:00:00Z' },
          '2': { expert_level: 5, copies: 2, first_obtained_at: '2026-10-01T00:00:00Z' },
        },
      },
      recent_rolls: { '2026-11-01': {}, '2026-10-31': {} },
      roasted_7d: 3,
    },
    page: 99,
  });
  const data = assertRequest(calls[0], 'catalog.html', '.canvas', 1536);
  assert.equal(rendering.CATALOG_PAGE_SIZE, 38);
  assert.equal(data.cards[0].name, '满级猪');
  assert.equal(data.cards[0].badge, 'MAX');
  assert.equal(data.cards[1].badge, 'NEW');
  assert.equal(data.favorite.name, '基础猪');
  assert.equal(data.percent, '5.0');
  assert.equal(data.checkinStreak, 2);
  assert.equal(data.page, 1);
  assert.equal(data.totalPages, 1);
  assert.equal(data.bg, pathToFileURL(path.join(Path.resource, 'catalog_base.jpg')).href);
  assert.equal(data.fontSans, pathToFileURL(path.join(Path.fonts, 'SourceHanSansSC-Medium.otf')).href);
});

renderTest('daily report converts ranking avatars without mutating the input', async () => {
  const { calls } = capture();
  const avatar = path.join(Path.image, 'avatar.png');
  const report = { volume: '第一期', rankings: [{ title: '排行', entries: [{ avatar, name: '用户' }] }] };
  await rendering.renderDailyReportImage(report);
  const data = assertRequest(calls[0], 'daily_report.html', '.paper', 1024);
  assert.equal(data.volume, report.volume);
  assert.equal(data.rankings[0].entries[0].avatar, pathToFileURL(avatar).href);
  assert.equal(report.rankings[0].entries[0].avatar, avatar);
});

renderTest('yesterday recap keeps fallback avatars, experiences and static assets', async () => {
  const { calls } = capture();
  const avatar = path.join(Path.image, 'fallback.gif');
  await rendering.renderYesterdayRecapImage({
    fallback_image_path: avatar,
    pig_name: '昨日猪',
    scope: 'group',
    footprints: [{ kind: 'success_count', label: '烤猪', count: 2 }],
    experiences: [{ text: '经历' }],
    summary: { text: '小结' },
  });
  const data = assertRequest(calls[0], 'yesterday.html', '.card', 720);
  assert.equal(data.avatar, pathToFileURL(avatar).href);
  assert.equal(data.scopeText, '本群');
  assert.deepEqual(data.experiences, ['经历']);
  assert.equal(data.summaryText, '小结');
  assert.equal(data.footprints[0].count, 2);
  assert.equal(fileURLToPath(data.iconBook), path.join(Path.resource, 'yesterday_card', 'header_book@4x.png'));
});

renderTest('weekly render captures the full flex row, not a narrow body viewport', async () => {
  const { calls } = capture();
  const entries = Array.from({ length: 7 }, (_, i) => ({ day: `第${i + 1}天`, imagePath: path.join(Path.image, `${i}.png`) }));
  await rendering.renderWeeklyImage(entries);
  const data = assertRequest(calls[0], 'weekly.html', '.wrap', 1258);
  assert.equal(data.items.length, 7);
  assert.equal(data.items[0].avatar, pathToFileURL(entries[0].imagePath).href);
  assert.equal(data.subtitle, '你这周变了 7 次猪！');
});

renderTest('configured scale is clamped to 1–4, with invalid values falling back to 2', async () => {
  for (const [scale, expected] of [[0.5, 1], [9, 4], [3, 3], [0, 2], [-1, 2], [NaN, 2], [Infinity, 2]]) {
    const { calls } = capture();
    config.render_scale = scale;
    await rendering.renderPigCard({}, null);
    assert.equal(calls[0][2].viewport.scale, expected);
  }
});

renderTest('renderer absence, rejection and empty results throw for existing text fallbacks', async () => {
  setContext(undefined);
  await assert.rejects(rendering.renderPigCard({}, null), /NG 渲染器不可用/);
  const error = new Error('没有安装任何渲染器插件');
  setContext({ async render() { throw error; } });
  await assert.rejects(rendering.renderPigCard({}, null), (actual) => actual === error);
  for (const empty of [null, false, []]) {
    capture(empty);
    await assert.rejects(rendering.renderPigCard({}, null), /渲染器返回空结果/);
  }
});

renderTest('raw renderer bytes are wrapped as a native image segment', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  capture(bytes);
  const result = await rendering.renderPigCard({}, null);
  assert.equal(result.type, 'image');
  assert.equal(result.file.kind, 'buffer');
  assert.equal(result.file.data, bytes);
});

renderTest('native arrays are not rewrapped or converted to legacy segments', async () => {
  const result = [{ type: 'image', file: { kind: 'buffer', data: new Uint8Array([1]) } }];
  capture(result);
  assert.equal(await rendering.renderPigCard({}, null), result);
});
