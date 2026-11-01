import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const framework = resolve(process.env.YZNG_FRAMEWORK || resolve(root, '../..'));
let createApp;
let createMockAdapter;
try {
  const require = createRequire(join(framework, 'package.json'));
  const packageFile = require.resolve('@yunzai-ng/core/package.json');
  const core = resolve(packageFile, '..');
  ({ createApp } = await import(pathToFileURL(join(core, 'dist/index.js')).href));
  ({ createMockAdapter } = await import(pathToFileURL(join(core, 'dist/testing/index.js')).href));
} catch (err) {
  if (process.env.YZNG_FRAMEWORK) throw err;
}
const owner = 'owner-openid';
const group = 'ABCDEF0123456789ABCDEF0123456789';

test('real NG gameplay, opaque IDs, permissions, persistence and reload', { timeout: 15000, skip: !createApp && '在 NG 环境运行，或设置 YZNG_FRAMEWORK 指向 NG 框架目录' }, async () => {
  const temp = join(framework, 'temp');
  await mkdir(temp, { recursive: true });
  const home = await mkdtemp(join(temp, 'rollpig-e2e-'));
  const slot = `__rollpigMock${Date.now()}`;
  const mock = createMockAdapter({ id: 'qqbot', caps: ['recall', 'forward', 'keyboard', 'markdown'] });
  globalThis[slot] = mock.provider;
  let app;
  try {
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config/yunzai.yaml'), 'store:\n  driver: memory\n  sqlite: false\nbot:\n  masterQQ: ["owner-openid"]\nserver:\n  enable: false\n');
    const plugin = join(home, 'plugins/rollpig-plugin');
    await mkdir(plugin, { recursive: true });
    for (const name of ['index.js', 'package.json', 'host', 'ng', 'constants', 'lib', 'apps', 'resource']) {
      await cp(join(root, name), join(plugin, name), { recursive: true });
    }
    await writeFile(join(home, 'plugins/mock.js'), `import { definePlugin } from '@yunzai-ng/core';\nexport default definePlugin({ name: 'rollpig-test-mock', setup(ctx) { ctx.registerAdapter(globalThis[${JSON.stringify(slot)}]); } });`);
    app = await createApp({ home, console: false, watchConfig: false, stopTimeout: 1000 });
    const report = await app.start();
    assert.deepEqual(report.failed, []);
    assert(report.loaded.includes('rollpig'));
    const state = app.services.get('rollpig').status();
    assert(state.pigs >= 100);
    assert(state.dataFile.startsWith(home));
    assert(!state.dataFile.includes('plugins/rollpig-plugin/data'));
    assert.equal(app.plugins.list().find(p => p.name === 'rollpig').tasks, 1);
    const cfg = app.configStore.get('rollpig');
    assert(cfg.schema.properties.ai_api_key.secret);
    await app.configStore.get('rollpig').patch({ qqbot_markdown_enabled: true, pighub_enabled: false });
    await app.runtime.accounts.create('qqbot', { selfId: 'pig-bot' });
    const send = async (content, uid = owner, extra = {}) => {
      const next = mock.sent.length + 1;
      mock.driver.receiveGroup(content, { uid, gid: group, name: `昵称-${uid}`, ...extra });
      await mock.waitForSend(next, 3000);
      return mock.last();
    };
    let message = await send('/今日小猪');
    assert(message.message.some(s => s.type === 'image'));
    assert(message.message.some(s => s.type === 'markdown' && s.content));
    const keyboard = message.message.find(s => s.type === 'keyboard');
    assert(keyboard?.rows.flat().some(b => b.data === '今日小猪' && b.action === 'input' && b.enter));
    const initial = JSON.parse(await readFile(state.dataFile, 'utf8'));
    const today = Object.keys(initial.history)[0];
    const pigId = initial.history[today][owner];
    assert(pigId);
    await send('#今日小猪');
    const repeated = JSON.parse(await readFile(state.dataFile, 'utf8'));
    assert.equal(repeated.history[today][owner], pigId);
    assert.equal(repeated.pig_progress[owner][pigId].copies, initial.pig_progress[owner][pigId].copies);
    message = await send('我的猪圈');
    assert.match(message.text, /猪圈|收集/);
    message = await send('随机小猪');
    assert.match(message.text, /关闭/);
    const { default: pighub } = await import(pathToFileURL(join(plugin, 'lib/flow/pighub.js')).href);
    pighub.images = [1, 2].map(id => ({ title: `假猪-${id}`, thumbnail: `https://example.invalid/${id}.png` }));
    pighub.lastLoaded = Date.now() / 1000;
    await app.configStore.get('rollpig').patch({ pighub_enabled: true });
    message = await send('随机小猪 2');
    await (await import(pathToFileURL(join(plugin, 'host/index.js')).href)).waitForOperations();
    const forwarded = mock.sent.find(msg => msg.nodes?.length === 2);
    assert(forwarded);
    assert(forwarded.nodes.every(node => node.uid === 'pig-bot' && node.name && node.message.some(s => s.type === 'image')));
    await app.configStore.get('rollpig').patch({ pighub_enabled: false });
    message = await send('日报状态 开启', 'ordinary-openid');
    assert.match(message.text, /只有/);
    assert.equal(cfg.get().daily_report_groups[group], undefined);
    message = await send('日报状态 开启');
    assert.match(message.text, /已开启/);
    assert.equal(cfg.get().daily_report_groups[group], true);
    message = await send('小猪排版 关闭', 'ordinary-openid');
    assert.match(message.text, /只有主人/);
    assert.equal(cfg.get().qqbot_markdown_enabled, true);
    message = await send([{ type: 'text', text: '强行点火' }, { type: 'at', uid: 'target-openid' }], 'ordinary-openid');
    assert.match(message.text, /仅主人/);
    message = await send([{ type: 'text', text: '烤群友' }, { type: 'at', uid: 'target-openid' }]);
    const nativeHost = await import(pathToFileURL(join(plugin, 'host/index.js')).href);
    const { default: store } = await import(pathToFileURL(join(plugin, 'lib/store/store.js')).href);
    const reservation = Object.values(store.data.roast_reservations).find(r => r.target_id === 'target-openid');
    assert(reservation, message.text);
    assert.equal(reservation.group_id, group);
    assert.equal(reservation.owner_id, owner);
    await nativeHost.waitForOperations();
    assert(reservation.messages.some(m => m.message_id === message.messageId));
    const notification = message.messageId;
    await send('今日小猪', 'joiner-openid');
    message = await send('/加入', 'joiner-openid', { quote: notification });
    assert(reservation.participants.some(p => p.user_id === 'joiner-openid'), message.text);

    // 两个无效引用先入队，用同一队列的帮助消息作完成屏障。
    mock.driver.receiveGroup('加入', { uid: 'outsider-openid', gid: 'other-group', quote: notification });
    mock.driver.receive({ kind: 'message', scene: 'group', messageId: 'forged-quote',
      message: [{ type: 'text', text: '加入' }], sender: { uid: 'outsider-openid', role: 'member' },
      group: { gid: group }, quote: { messageId: notification, sender: { uid: 'not-pig-bot' } } });
    await send('小猪帮助');
    await nativeHost.waitForOperations();
    assert.equal(reservation.participants.length, 2);
    const expectedSends = mock.sent.length + 2;
    await send('今日小猪', 'target-openid');
    await mock.waitForSend(expectedSends, 3000);
    await nativeHost.waitForOperations();
    assert.equal(reservation.status, 'completed');
    assert(store.getDailyEvents({ dateStr: today, groupId: group }).some(event => event.reservation_id === reservation.reservation_id));

    await send('今日小猪', 'remote-openid', { gid: 'remote-group' });
    message = await send('随机烤猪', owner, { gid: 'empty-group' });
    assert.match(message.text, /没有别人抽猪/);
    const { getGroupRollCandidates } = await import(pathToFileURL(join(plugin, 'lib/flow/helpers.js')).href);
    const allMembers = { getGroupMemberList: async () => [owner, 'remote-openid', 'joiner-openid'].map(uid => ({ uid })) };
    assert.deepEqual(await getGroupRollCandidates({ group: { gid: group }, bot: allMembers }, store, new Set([owner])), ['joiner-openid']);

    // 真正注册的 cron 回调：用假渲染服务，不访问浏览器/网络。
    let pauseRender;
    app.hooks.render.register({ id: 'rollpig-test-renderer', available: async () => true,
      render: async () => {
        if (pauseRender) await pauseRender();
        return { images: [Buffer.from('test-image')], cost: 0, renderer: 'rollpig-test-renderer' };
      } }, 'rollpig-test');
    const registrations = [];
    const registerTask = app.hooks.tasks.register;
    app.hooks.tasks.register = function (reg) { registrations.push(reg); return registerTask.call(this, reg); };
    await app.plugins.reload('rollpig');
    app.hooks.tasks.register = registerTask;
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].schedule, '0 45 23 * * *');
    assert.equal(registrations[0].options.timezone, 'Asia/Shanghai');
    for (let i = 0; i < 2; i++) store.appendRoastEvent({ event_type: 'success', attacker_id: owner,
      target_id: 'protected-victim', group_id: group, created_at: `${today}T08:00:00Z` });
    const reportIndex = mock.sent.length;
    await registrations[0].fn(new AbortController().signal);
    const pushed = mock.sent.slice(reportIndex);
    assert(pushed.some(msg => msg.target.gid === group && msg.selfId === 'pig-bot' && msg.message.some(s => s.type === 'image')));
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const protectDate = tomorrow.toISOString().slice(0, 10);
    assert.deepEqual(store.data.protected[protectDate][group], ['protected-victim']);
    await app.runtime.accounts.create('qqbot', { selfId: 'offline-bot' });
    await nativeHost.getContext().kv.set(`group:${group}`, { selfId: 'offline-bot', platform: 'qqbot' });
    mock.drivers[1].goOffline();
    store.replaceGroupProtections(group, [], protectDate);
    const beforeOffline = mock.sent.length;
    await registrations[0].fn(new AbortController().signal);
    assert.deepEqual(store.data.protected[protectDate][group], ['protected-victim']);
    assert.equal(mock.sent.length, beforeOffline);
    await send('小猪帮助');
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(registrations[0].fn(cancelled.signal));
    message = await send('小猪更新');
    assert.match(message.text, /双宿主移植版/);
    await app.plugins.unload('rollpig');
    assert.equal(app.services.get('rollpig'), undefined);
    assert.equal(await app.plugins.reload('rollpig'), true);
    assert.equal(app.plugins.list().find(p => p.name === 'rollpig').tasks, 1);
    await app.configStore.get('rollpig').patch({ qqbot_markdown_enabled: true, pighub_enabled: false });
    await send('今日小猪');
    const reloaded = JSON.parse(await readFile(state.dataFile, 'utf8'));
    assert.equal(reloaded.history[today][owner], pigId);

    // 渲染进行中卸载 + 立即重载：旧卡片不发出，旧队列不触碰新实例。
    await app.configStore.get('rollpig').patch({ qqbot_markdown_enabled: false });
    let startedRender;
    let releaseRender;
    const started = new Promise(done => { startedRender = done; });
    const release = new Promise(done => { releaseRender = done; });
    pauseRender = async () => { startedRender(); await release; };
    mock.driver.receiveGroup('今日小猪', { uid: owner, gid: group });
    await started;
    mock.driver.receiveGroup('今日小猪', { uid: 'queued-unloaded-user', gid: group });
    await app.plugins.unload('rollpig');
    const sendsBeforeRelease = mock.sent.length;
    const reload = app.plugins.reload('rollpig');
    releaseRender();
    assert.equal(await reload, true);
    pauseRender = undefined;
    await nativeHost.waitForOperations();
    assert.equal(mock.sent.length, sendsBeforeRelease);
    const afterRace = JSON.parse(await readFile(state.dataFile, 'utf8'));
    assert.equal(afterRace.history[today]['queued-unloaded-user'], undefined);
    assert.equal(app.plugins.list().find(p => p.name === 'rollpig').tasks, 1);

    // 损坏的数据只令加载失败，不能自动清空后覆盖玩家记录。
    await app.plugins.unload('rollpig');
    await writeFile(state.dataFile, '{broken-json');
    assert.equal(await app.plugins.reload('rollpig'), false);
    assert.equal(await readFile(state.dataFile, 'utf8'), '{broken-json');
  } finally {
    await app?.stop();
    delete globalThis[slot];
    await rm(home, { recursive: true, force: true });
  }
});
