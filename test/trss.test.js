import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrssHost, trssSegment as seg, toSegments, legacyId } from '../host/trss.js';
import { normalizeTrssEvent } from '../host/trss-event.js';
import { makeTrssApps } from '../apps/trss.js';
import { bindContext, waitForOperations } from '../host/index.js';
import Path from '../constants/path.js';

const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
const owner = 'owner-openid';
const gid = 'opaque-group';

async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'rollpig-trss-test-'));
  const sent = [], jobs = [], calls = [];
  const members = new Map([owner, 'joiner-openid', 'target-openid', 'ordinary-openid'].map(uid => [uid, { user_id: uid, nickname: `昵称-${uid}`, role: 'member' }]));
  const group = {
    getInfo: async () => ({ group_id: gid, group_name: '测试群' }),
    getMemberMap: async () => members,
    async sendMsg(message) { sent.push({ message }); return { message_id: `reply-${sent.length}` }; },
    async sendForwardMsg(nodes) { sent.push({ nodes }); return { message_id: `forward-${sent.length}` }; },
  };
  const bot = {
    uin: 'pig-bot', adapter: { id: 'QQBot', name: 'QQBot' },
    pickGroup(id) { calls.push(['pickGroup', id]); return group; },
    pickFriend(id) { calls.push(['pickFriend', id]); return group; },
  };
  const configData = { roast_cooldown_hours: 8, roast_charge_max: 2, catalog_enabled: true,
    daily_summary_enabled: false, daily_report_groups: {}, yesterday_style: 'recap',
    pighub_enabled: false, render_scale: 2, qqbot_markdown_enabled: true, reply_quote: true, ai_enabled: false };
  const config = { get: () => configData, async patch(patch) { Object.assign(configData, patch); } };
  const schedule = { scheduleJob(settings, callback) { const job = { settings, callback, cancelled: false, cancel() { this.cancelled = true; } }; jobs.push(job); return job; } };
  const puppeteer = { screenshot: async () => ({ type: 'image', file: Buffer.from('fake-image') }) };
  const rootBot = { uin: ['pig-bot'], bots: { 'pig-bot': bot } };
  const host = await createTrssHost({ rootBot, dataDir, logger, config, masterIds: [owner], schedule, puppeteer, ...options });
  function event(text, uid = owner, extra = {}) {
    return { self_id: 'pig-bot', user_id: uid, group_id: gid, isGroup: true, message_type: 'group', msg: text,
      sender: { user_id: uid, nickname: `昵称-${uid}`, openid: uid, role: 'member' }, bot, group,
      message_id: `input-${sent.length + 1}`, message: [{ type: 'text', text }],
      async reply(message, quote, data) { sent.push({ message: [...message], quote, data }); return { message_id: `reply-${sent.length}` }; }, ...extra };
  }
  return { host, bot, rootBot, group, members, sent, calls, jobs, dataDir, configData, event,
    async close() { await host.dispose(); await waitForOperations(); await rm(dataDir, { recursive: true, force: true }); } };
}

class FakePlugin {
  constructor(options) { Object.assign(this, options); }
}

function textOf(message) { return message.message.filter(item => item.type === 'text').map(item => item.text).join(''); }

test('native-like segments flatten, retain media sources, and convert all output kinds', async () => {
  const f = await fixture({ segment: {
    image: file => ({ type: 'image', file }), at: qq => ({ type: 'at', qq }),
    markdown: data => ({ type: 'markdown', data }),
    // Lain may return an array: output must remain flat.
    button: (...data) => [{ type: 'button', data }],
  } });
  try {
    assert.deepEqual(toSegments(['a', [false, null, '', 0, 'b'], seg.at('abc')]), [{ type: 'text', text: 'a0b' }, { type: 'at', uid: 'abc' }]);
    assert.equal(toSegments([{ type: 'text', text: 'a' }, 'b'])[0].text, 'ab');
    const original = { type: 'text', text: 'a' };
    toSegments([original, 'b']); assert.equal(original.text, 'a');
    const content = [seg.image('D:/fake/image.png'), seg.image('https://example.invalid/pig.png'), seg.image(Buffer.from('bytes')),
      seg.at('opaque-user'), seg.markdown('**猪**'), seg.keyboard([[{ label: '开始', action: 'input', data: '今日小猪', enter: true, style: 1 },
        { label: '查找', action: 'input', data: '找猪 ', enter: false }, { label: '网站', action: 'link', data: 'https://example.invalid', visitedLabel: '已打开' }]]),
      seg.forward([seg.node('hello', { uid: 'opaque-bot', name: '测试' })])];
    const converted = f.host.toLegacy(content, f.bot);
    assert.equal(converted[0].file, 'D:/fake/image.png');
    assert.equal(converted[1].file, 'https://example.invalid/pig.png');
    assert(Buffer.isBuffer(converted[2].file));
    assert.equal(converted[3].qq, 'opaque-user');
    assert.deepEqual(converted[4].data, { content: '**猪**' });
    assert.deepEqual(converted[5].data[0][0], { text: '开始', style: 1, callback: '今日小猪', enter: true });
    assert.deepEqual(converted[5].data[0][1], { text: '查找', style: 0, input: '找猪 ', enter: false });
    assert.equal(converted[5].data[0][2].link, 'https://example.invalid');
    assert.equal(converted[6].data[0].user_id, 'opaque-bot');
    assert.deepEqual(converted[6].data[0].message, [{ type: 'text', text: 'hello' }]);
    assert.equal(legacyId('1234', { adapter: 'icqq' }), 1234);
    assert.equal(legacyId('1234', f.bot), '1234');
    assert.equal(legacyId('9007199254740993', { adapter: 'icqq' }), '9007199254740993');
    assert.equal(legacyId('00123', { adapter: 'icqq' }), '00123');
    assert.equal(legacyId('abc-123', { adapter: 'icqq' }), 'abc-123');
    assert(f.host.app.bots.online()[0].caps.has('markdown'));
    assert(!f.host.app.bots.online()[0].caps.has('forward'));
    f.bot.adapter = 'DingTalk'; assert(f.host.app.bots.online()[0].caps.has('keyboard'));
    f.bot.adapter = 'unknown'; assert.deepEqual([...f.host.app.bots.online()[0].caps], []);
  } finally { await f.close(); }
});

test('event normalization keeps legacy reply unchanged, IDs, roles, quote and official mention syntax', async () => {
  const f = await fixture();
  try {
    const event = f.event('加入', 'joiner-openid', {
      source: { message_id: 'notification-id', user_id: 'pig-bot' },
      sender: { user_id: 'joiner-openid', nickname: '加入者', card: '群名片', openid: 'user-openid', role: 'owner' },
      message: [{ type: 'text', text: '加入' }, { type: 'at', qq: 'pig-bot' }, { type: 'at', qq: 'target-openid' }],
    });
    const reply = event.reply;
    const e = normalizeTrssEvent(event, f.host);
    assert.equal(e.trssEvent, event); assert.equal(event.reply, reply);
    assert.deepEqual(e.sender, { uid: 'joiner-openid', card: '群名片', name: '加入者' });
    assert.equal(e.selfId, 'pig-bot'); assert.equal(e.group.gid, gid); assert.equal(e.target.scene, 'group');
    assert(e.isGroupAdmin && e.isGroupOwner && !e.isMaster);
    assert.deepEqual(e.atUsers, ['pig-bot', 'target-openid']); assert(e.atMe);
    assert.equal(e.quote.messageId, 'notification-id'); assert.equal(e.quote.sender.uid, 'pig-bot');
    const result = await e.reply([seg.text('回复'), seg.image(Buffer.from('image'))], { quote: true, at: true });
    assert.equal(result.messageId, 'reply-1'); assert(result.ok);
    assert.match(f.sent[0].message[0].text, /^<qqbot-at-user id="user-openid" \/>\r$/);
    assert.equal(f.sent[0].quote, true); assert.equal(f.sent[0].data.at, false); assert.equal(event.reply, reply);
    await e.reply([seg.at('target-openid'), 'existing at'], { at: false });
    assert.equal(f.sent[1].message[0].type, 'at');
    f.bot.adapter = 'DingTalk';
    await normalizeTrssEvent(event, f.host).reply('test', { at: true });
    assert.equal(f.sent[2].data.at, true);
    const privateEvent = normalizeTrssEvent(f.event('private', owner, { isGroup: false, group_id: undefined, group: undefined, message_type: 'private' }), f.host);
    assert.equal(privateEvent.target.scene, 'private'); assert.equal(privateEvent.group, undefined); assert(privateEvent.isMaster);
  } finally { await f.close(); }
});

test('event group APIs take precedence with bot fallbacks and normalized forward results', async () => {
  const f = await fixture();
  try {
    f.bot.adapter = { id: 'ICQQ', name: 'icqq' };
    const eventGroup = { getMemberMap: async () => new Map([[123, { user_id: 123, card: '事件名片' }]]) };
    const e = normalizeTrssEvent(f.event('command', owner, { group: eventGroup }), f.host);
    assert.equal((await e.bot.getGroupMemberList(gid))[0].uid, '123');
    assert.equal((await e.bot.getGroupMember(gid, '123')).card, '事件名片');
    assert.equal((await e.bot.getGroup(gid)).name, '测试群');
    assert.equal((await e.bot.sendMessage(e.target, 'fallback send')).messageId, 'reply-1');
    assert.equal((await e.bot.sendForward(e.target, [seg.node('内容', { uid: '123', name: '成员' })])).messageId, 'forward-2');
    assert.equal(f.sent[1].nodes[0].user_id, 123);
    f.group.makeForwardMsg = async nodes => ({ type: 'node', data: nodes });
    await e.bot.sendForward(e.target, [seg.node('合并内容', { uid: '123' })]);
    assert.equal(f.sent[2].message.type, 'node');
    assert.equal(f.sent[2].message.data[0].user_id, 123);
    const sourceOnly = normalizeTrssEvent(f.event('回复', owner, { source: { seq: 1 }, getReply: async () => ({ user_id: 'target-openid' }) }), f.host);
    assert.equal((await sourceOnly.bot.getMessage(sourceOnly.quote.messageId)).sender.uid, 'target-openid');
    assert.equal((await sourceOnly.bot.getMessage(sourceOnly.quote.messageId)).group.gid, gid);
    const quoted = normalizeTrssEvent(f.event('加入', owner, { group_id: 456,
      source: { user_id: 123, seq: 2, rand: 3, time: 4 } }), f.host);
    const buffer = Buffer.from(quoted.quote.messageId, 'base64');
    assert.equal(buffer.length, 21); assert.equal(buffer.readUInt32BE(0), 456); assert.equal(buffer.readUInt32BE(4), 123);
  } finally { await f.close(); }
});

test('routes use only injected data directory, persist atomically, and respect offline accounts', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readdir(f.dataDir), []);
    await Promise.all([f.host.kv.set(`group:${gid}`, { selfId: 'pig-bot', platform: 'qq' }), f.host.kv.set('group:second', { selfId: 'other' })]);
    assert.deepEqual(await readdir(f.dataDir), ['rollpig_routes.json']);
    const file = JSON.parse(await readFile(path.join(f.dataDir, 'rollpig_routes.json'), 'utf8'));
    assert.equal(file[`group:${gid}`].selfId, 'pig-bot'); assert.equal(file['group:second'].selfId, 'other');
    const second = await createTrssHost({ dataDir: f.dataDir, config: f.host.config, logger,
      masterIds: [], schedule: { scheduleJob() {} }, rootBot: f.rootBot, puppeteer: {} });
    try { assert.equal((await second.kv.get(`group:${gid}`)).selfId, 'pig-bot'); }
    finally { await second.dispose(); }
    assert.equal(f.host.app.bots.online().length, 1);
    f.rootBot.uin = []; assert.equal(f.host.app.bots.online().length, 0); assert.equal(f.host.app.bots.bySelfId('pig-bot').online, false);
    await f.host.dispose(); await assert.rejects(f.host.kv.set('forbidden', {}));
  } finally { await f.close(); }
});

test('cron honors timezone, overlap, cancellation and passes AbortSignal not legacy fireDate', async () => {
  const f = await fixture();
  try {
    let release, runningSignal, count = 0;
    const wait = new Promise(resolve => { release = resolve; });
    const cancel = f.host.cron('0 45 23 * * *', async signal => { count++; runningSignal = signal; await wait; }, { timezone: 'Asia/Shanghai', timeout: '10m', overlap: 'skip' });
    assert.deepEqual(f.jobs[0].settings, { rule: '0 45 23 * * *', tz: 'Asia/Shanghai' });
    const pending = f.jobs[0].callback(new Date());
    assert(runningSignal instanceof AbortSignal);
    await f.jobs[0].callback(new Date()); assert.equal(count, 1);
    cancel(); assert(f.jobs[0].cancelled); assert(runningSignal.aborted);
    release(); await pending; await f.jobs[0].callback(new Date()); assert.equal(count, 1);
  } finally { await f.close(); }
});

test('render converts legacy image and bytes; Puppeteer hooks apply selector, width, scale and type', async () => {
  const f = await fixture();
  try {
    const image = await f.host.render('D:/fake/card.html', {}, { type: 'png', viewport: { width: 900, scale: 3 } });
    assert.equal(image.file.kind, 'buffer');
    const calls = [];
    const puppeteer = { browserInit: async () => {}, dealTpl: (name, params) => { calls.push(['template', name, params]); return 'temp/card.html'; },
      browser: { newPage: async () => ({ setViewport: async options => calls.push(['viewport', options]),
        goto: async (...args) => calls.push(['goto', ...args]),
        $: async selector => { calls.push(['selector', selector]); return { screenshot: async options => { calls.push(['shot', options]); return Buffer.from('direct-bytes'); } }; },
        close: async () => calls.push(['close']),
      }) } };
    const direct = await createTrssHost({ root: f.dataDir, dataDir: f.dataDir, masterIds: [], config: f.host.config, logger,
      schedule: { scheduleJob() {} }, rootBot: f.rootBot, puppeteer });
    try {
      const image = await direct.render('D:/fake/card.html', { title: '测试' }, { selector: '.card', viewport: { width: 1200, scale: 3 }, type: 'png' });
      assert.equal(image.file.kind, 'buffer');
      assert.deepEqual(calls.find(item => item[0] === 'viewport')[1], { width: 1200, height: 1000, deviceScaleFactor: 3 });
      assert.equal(calls.find(item => item[0] === 'selector')[1], '.card');
      assert.deepEqual(calls.find(item => item[0] === 'shot')[1], { type: 'png' });
      assert.equal(calls.at(-1)[0], 'close');
    } finally { await direct.dispose(); }
  } finally { await f.close(); }
});

test('wrappers retain command metadata, filter helpers, use passed e or this.e, and serialize', async () => {
  const f = await fixture();
  bindContext(f.host);
  try {
    const received = [];
    class Domain {
      constructor() { Object.assign(this, { name: '命令组', dsc: '说明', event: 'message', priority: 321, rule: [{ reg: '^test$', fnc: 'handle', permission: 'admin' }] }); }
      async handle(e) { received.push(e.text); await e.reply('ok'); return e.sender.uid; }
    }
    function helper() { throw new Error('must not instantiate helpers'); }
    class NotCommand {}
    const apps = await makeTrssApps([{ Domain, helper, NotCommand }, { Duplicate: Domain }], { Plugin: FakePlugin, host: f.host });
    assert.deepEqual(Object.keys(apps), ['Domain']);
    const app = new apps.Domain();
    assert.equal(app.name, '命令组'); assert.equal(app.priority, 321); assert.equal(app.event, 'message'); assert.equal(app.rule[0].permission, 'admin');
    app.e = f.event('this.e', 'ordinary-openid');
    assert.equal(await app.handle(f.event('explicit', owner)), owner);
    assert.equal(await app.handle(), 'ordinary-openid');
    assert.deepEqual(received, ['explicit', 'this.e']);
    assert.equal((await f.host.kv.get(`group:${gid}`)).selfId, 'pig-bot');
  } finally { await f.close(); }
});

test('shared real TRSS commands repeat today pig, own pigsty, join reservation by legacy reply ID, and deny permissions', { timeout: 10000 }, async () => {
  const f = await fixture();
  const originalPaths = { ...Path };
  try {
    const resources = path.join(f.dataDir, 'fixture-resource');
    await mkdir(path.join(resources, 'image'), { recursive: true });
    await writeFile(path.join(resources, 'pig.json'), JSON.stringify([{ id: 'fixture-pig', name: '测试小猪', description: '测试描述', analysis: '测试分析' }]));
    await writeFile(path.join(resources, 'pig_rules.json'), '{}');
    await writeFile(path.join(resources, 'image/fixture-pig.png'), Buffer.from('fake-png'));
    Object.assign(Path, { resource: resources, image: path.join(resources, 'image'), pigJson: path.join(resources, 'pig.json'),
      rulesJson: path.join(resources, 'pig_rules.json'), exVariantsJson: path.join(resources, 'no-variants.json') });
    // Bind temp data before importing any business singleton. No real config/data is read or written.
    const { setupCommon } = await import('../lib/setup.js');
    const { modules, store } = await setupCommon(f.host);
    const classes = await makeTrssApps(modules, { Plugin: FakePlugin, host: f.host });
    assert.equal(Object.keys(classes).length, 7);
    const apps = Object.values(classes).map(App => new App());
    const dispatch = async (text, uid = owner, extra = {}) => {
      const raw = f.event(text, uid, extra);
      const app = apps.find(app => app.rule.some(rule => new RegExp(rule.reg).test(text)));
      assert(app, `No rule for ${text}`);
      const rule = app.rule.find(rule => new RegExp(rule.reg).test(text));
      app.e = raw;
      const previous = f.sent.length;
      await app[rule.fnc]();
      await waitForOperations();
      return f.sent.length > previous ? f.sent.at(-1) : undefined;
    };
    let result = await dispatch('今日小猪');
    assert(result.message.some(item => item.type === 'image'));
    assert(result.message.some(item => item.type === 'markdown'));
    assert(result.message.some(item => item.type === 'button'));
    const today = Object.keys(store.data.history)[0];
    const pig = store.data.history[today][owner];
    const copies = store.data.pig_progress[owner][pig].copies;
    await dispatch('/今日小猪');
    assert.equal(store.data.history[today][owner], pig);
    assert.equal(store.data.pig_progress[owner][pig].copies, copies);
    result = await dispatch('我的猪圈'); assert.match(textOf(result), /猪圈|收集/);
    result = await dispatch('日报状态 开启', 'ordinary-openid'); assert.match(textOf(result), /只有/);
    assert.equal(f.configData.daily_report_groups[gid], undefined);
    result = await dispatch('小猪排版 关闭', 'ordinary-openid'); assert.match(textOf(result), /只有主人/);
    assert.equal(f.configData.qqbot_markdown_enabled, true);
    result = await dispatch('强行点火', 'ordinary-openid'); assert.match(textOf(result), /仅主人/);
    result = await dispatch('烤群友', owner, { message: [{ type: 'text', text: '烤群友' }, { type: 'at', qq: 'target-openid' }] });
    const reservation = Object.values(store.data.roast_reservations).find(item => item.target_id === 'target-openid');
    assert(reservation, textOf(result));
    const notification = `reply-${f.sent.length}`;
    assert(reservation.messages.some(message => message.message_id === notification));
    await dispatch('今日小猪', 'joiner-openid');
    result = await dispatch('/加入', 'joiner-openid', { source: { message_id: notification, user_id: 'pig-bot' } });
    assert(reservation.participants.some(item => item.user_id === 'joiner-openid'), result && textOf(result));
    await dispatch('/加入', 'ordinary-openid', { source: { message_id: notification, user_id: 'forged-bot' } });
    assert(!reservation.participants.some(item => item.user_id === 'ordinary-openid'));
    assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0].settings.tz, 'Asia/Shanghai');
  } finally {
    await f.close();
    Object.assign(Path, originalPaths);
  }
});
