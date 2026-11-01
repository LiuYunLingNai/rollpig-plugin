import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Path from '../constants/path.js';

const RICH_ADAPTERS = /qqbot|dingtalk|dingding/i;
const FORWARD_ADAPTERS = /icqq|oicq|onebot|milky|lagrange/i;

function adapterKey(bot, event = {}) {
  const adapter = bot?.adapter;
  return [typeof adapter === 'string' ? adapter : adapter?.id,
    typeof adapter === 'object' ? adapter?.name : '', bot?.version?.id, bot?.version?.name,
    typeof event.adapter === 'string' ? event.adapter : event.adapter?.id,
    event.adapter?.name, event.adapter_id, event.adapter_name].filter(Boolean).join(' ');
}

// Only icqq calls require numeric QQ IDs. Preserve opaque IDs, leading zeroes and large IDs.
export function legacyId(value, bot) {
  const id = String(value ?? '');
  if (!/icqq|oicq/i.test(adapterKey(bot)) || !/^[1-9]\d*$/.test(id)) return id;
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : id;
}

export function toMediaRef(value) {
  if (value && typeof value === 'object' && ['path', 'url', 'buffer', 'base64', 'id'].includes(value.kind)) return value;
  if (value instanceof Uint8Array) return { kind: 'buffer', data: value };
  if (value instanceof ArrayBuffer) return { kind: 'buffer', data: new Uint8Array(value) };
  if (value instanceof URL) value = value.href;
  if (typeof value !== 'string' || !value) throw new TypeError('图片来源不能为空');
  if (value.startsWith('file://')) return { kind: 'path', path: fileURLToPath(value) };
  if (/^https?:\/\//i.test(value)) return { kind: 'url', url: value };
  if (value.startsWith('base64://')) return { kind: 'base64', base64: value.slice(9) };
  const data = /^data:([^;,]*)(?:;charset=[^;,]*)?;base64,(.*)$/s.exec(value);
  if (data) return { kind: 'base64', base64: data[2], ...(data[1] ? { mime: data[1] } : {}) };
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return { kind: 'path', path: value };
  // Legacy renderers can return an uploaded image token rather than a file path.
  return { kind: 'id', id: value };
}

export const trssSegment = {
  text: text => ({ type: 'text', text: String(text) }),
  image: (file, options = {}) => ({ type: 'image', file: toMediaRef(file), ...options }),
  at: (uid, name) => ({ type: 'at', uid: String(uid), ...(name == null ? {} : { name }) }),
  atAll: () => ({ type: 'atAll' }),
  reply: messageId => ({ type: 'reply', messageId: String(messageId) }),
  markdown: content => ({ type: 'markdown', content: typeof content === 'string' ? content : content?.content ?? '' }),
  keyboard: rows => ({ type: 'keyboard', rows }),
  node: (message, options = {}) => ({ message: toSegments(message), ...options }),
  forward: (nodes, options = {}) => ({ type: 'forward', nodes, ...options }),
};

export function toSegments(content) {
  const result = [];
  function collect(item) {
    if (item == null || item === false) return;
    if (Array.isArray(item)) { for (const child of item) collect(child); return; }
    if (typeof item === 'string' || typeof item === 'number') item = trssSegment.text(item);
    if (typeof item !== 'object' || typeof item.type !== 'string') return;
    if (item.type === 'text') {
      const text = String(item.text ?? item.data?.text ?? '');
      if (!text) return;
      if (result.at(-1)?.type === 'text') result[result.length - 1] = trssSegment.text(result.at(-1).text + text);
      else result.push(trssSegment.text(text));
    } else if (item.type === 'image') {
      result.push({ ...item, file: toMediaRef(item.file ?? item.data?.file ?? item.url ?? item.data?.url) });
    } else if (item.type === 'at') {
      const uid = item.uid ?? item.qq ?? item.data?.qq;
      result.push(uid === 'all' ? trssSegment.atAll() : trssSegment.at(uid, item.name));
    } else if (item.type === 'reply') {
      result.push(trssSegment.reply(item.messageId ?? item.id ?? item.data?.id));
    } else if (item.type === 'markdown') {
      result.push(item.content != null ? item : trssSegment.markdown(item.data));
    } else result.push(item);
  }
  collect(content);
  return result;
}

function mediaValue(file) {
  switch (file.kind) {
    case 'path': return file.path;
    case 'url': return file.url;
    case 'buffer': return Buffer.from(file.data);
    case 'base64': return `base64://${file.base64}`;
    case 'id': return file.id;
    default: throw new TypeError('不支持的图片来源');
  }
}

export function normalizeSendResult(raw) {
  if (Array.isArray(raw)) {
    const results = raw.map(normalizeSendResult);
    const first = results.find(result => result.messageId) ?? results[0];
    return { ok: results.length > 0 && results.every(result => result.ok), messageId: first?.messageId ?? '', time: Date.now(), raw };
  }
  return {
    ok: raw !== false && raw != null && !raw.error && raw.ok !== false && raw.status !== 'failed',
    messageId: String(raw?.messageId ?? raw?.message_id ?? raw?.data?.message_id ?? ''),
    time: Date.now(), raw,
  };
}

function mapGet(map, key, bot) {
  return map instanceof Map ? map.get(String(key)) ?? map.get(legacyId(key, bot)) : map?.[String(key)];
}

function entries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.map(item => [item?.uid ?? item?.user_id ?? item?.uin, item]);
  return Object.entries(value ?? {});
}

function memberInfo(info, uid) {
  if (!info) return undefined;
  const role = info.role ?? (info.is_owner ? 'owner' : info.is_admin ? 'admin' : 'member');
  return { uid: String(info.uid ?? info.user_id ?? info.uin ?? uid), card: info.card ?? '',
    name: info.name ?? info.nickname ?? '', role };
}

function createRouteKv(dataDir, signal) {
  const filename = path.join(dataDir, 'rollpig_routes.json');
  let loaded;
  let queue = Promise.resolve();
  const load = () => loaded ??= fs.readFile(filename, 'utf8').then(text => {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rollpig 路由文件格式错误');
    return Object.assign(Object.create(null), value);
  }).catch(error => { if (error.code === 'ENOENT') return Object.create(null); throw error; });
  async function write(fn) {
    const work = queue.then(async () => {
      signal.throwIfAborted();
      const data = await load();
      const next = Object.assign(Object.create(null), data);
      fn(next);
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
        signal.throwIfAborted();
        await fs.rename(temporary, filename);
        loaded = Promise.resolve(next);
      } finally { await fs.rm(temporary, { force: true }); }
    });
    queue = work.catch(() => {});
    return work;
  }
  return {
    async get(key) { await queue; signal.throwIfAborted(); const data = await load(); return data[key] == null ? undefined : structuredClone(data[key]); },
    set: (key, value) => write(data => { data[key] = structuredClone(value); }),
    delete: key => write(data => { delete data[key]; }),
  };
}

function timeoutMs(value) {
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]) : 0;
}

/** All legacy globals and host-only imports are confined to this boundary. */
export async function createTrssHost(options = {}) {
  const root = options.root ?? Path.root;
  const oldModule = relative => pathToFileURL(path.resolve(root, '../..', relative)).href;
  const config = options.config ?? (await import('./trss-config.js')).createTrssConfig();
  const cfg = options.masterIds == null ? (await import(oldModule('lib/config/config.js'))).default : null;
  const schedule = options.schedule ?? (await import('node-schedule')).default;
  const controller = new AbortController();
  const disposers = [];
  let rendererPromise;
  let renderSequence = 0;
  let disposed;
  const rootBot = () => options.rootBot ?? globalThis.Bot;
  const logger = options.logger ?? globalThis.logger ?? console;
  let fallbackSegment;
  if (!options.segment && !globalThis.segment && !options.rootBot) {
    try { fallbackSegment = (await import(oldModule('lib/modules/oicq/index.js'))).segment; }
    catch {
      for (const dependency of ['oicq', 'icqq']) {
        try { fallbackSegment = (await import(dependency)).segment; break; } catch {}
      }
      if (!fallbackSegment) logger.warn?.('[今日小猪] 没有旧消息段构造器，使用 TRSS 通用段格式');
    }
  }
  const oldSegment = () => options.segment ?? globalThis.segment ?? fallbackSegment;
  const host = {
    kind: 'trss', root, dataDir: options.dataDir ?? path.join(root, 'data'), config,
    logger, signal: controller.signal, segment: trssSegment, toSegments,
    onDispose(fn) { disposers.push(fn); },
    dispose() {
      return disposed ??= (async () => {
        controller.abort(new Error('rollpig TRSS host disposed'));
        for (const fn of disposers.splice(0).reverse()) {
          try { await fn(); } catch (error) { logger.error?.(error); }
        }
      })();
    },
    cron(expression, callback, settings = {}) {
      let cancelled = false;
      let busy = false;
      const executions = new Set();
      const job = schedule.scheduleJob({ rule: expression, tz: settings.timezone ?? 'Asia/Shanghai' }, async () => {
        if (cancelled || host.signal.aborted || busy) return;
        busy = true;
        const execution = new AbortController();
        executions.add(execution);
        const ms = timeoutMs(settings.timeout);
        const timer = ms > 0 ? setTimeout(() => execution.abort(new Error('rollpig cron timeout')), ms) : null;
        timer?.unref?.();
        try { await callback(AbortSignal.any([host.signal, execution.signal])); }
        catch (error) { if (!host.signal.aborted) logger.error?.(`[今日小猪] ${settings.name ?? '定时任务'}失败`, error); }
        finally { clearTimeout(timer); executions.delete(execution); busy = false; }
      });
      if (!job) throw new Error(`无法注册定时任务 ${expression}`);
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        job.cancel();
        for (const execution of executions) execution.abort(new Error('rollpig cron cancelled'));
      };
      host.onDispose(cancel);
      return cancel;
    },
    async render(template, data, settings = {}) {
      host.signal.throwIfAborted();
      rendererPromise ??= options.puppeteer ? Promise.resolve(options.puppeteer) : import(oldModule('lib/puppeteer/puppeteer.js')).then(module => module.default);
      const renderer = await rendererPromise;
      const name = `rollpig-plugin/${path.basename(template, path.extname(template))}`;
      const scale = Math.min(4, Math.max(1, Number(settings.viewport?.scale) || 2));
      const width = Math.min(10000, Math.max(1, Math.round(Number(settings.viewport?.width) || 800)));
      const type = ['png', 'jpeg', 'webp'].includes(settings.type) ? settings.type : 'jpeg';
      const params = { ...data, tplFile: template, saveId: `card_${renderSequence = (renderSequence + 1) % 20}`,
        imgType: type, scale, selector: settings.selector, viewport: { width, height: 1000, deviceScaleFactor: scale },
        multiPage: false, pageGotoParams: { waitUntil: 'networkidle0' } };
      let image;
      // The old Puppeteer screenshot hardcodes #container/body and ignores scale/viewport.
      // Its public browser + dealTpl hooks allow accurate per-render options, without mutating the singleton.
      if (renderer.browserInit && renderer.dealTpl && !settings.multiPage) {
        await renderer.browserInit();
        if (!renderer.browser) throw new Error('Yunzai Puppeteer 浏览器不可用');
        const saved = renderer.dealTpl(name, params);
        if (!saved) throw new Error('Yunzai 模板编译失败');
        const page = await renderer.browser.newPage();
        try {
          await page.setViewport(params.viewport);
          await page.goto(pathToFileURL(path.resolve(root, '../..', saved)).href, params.pageGotoParams);
          host.signal.throwIfAborted();
          const element = settings.selector ? await page.$(settings.selector) : await page.$('#container') ?? await page.$('body');
          if (!element) throw new Error(`找不到截图区域 ${settings.selector ?? 'body'}`);
          image = await element.screenshot({ type, ...(type === 'png' ? {} : { quality: settings.quality ?? 90 }) });
        } finally { await page.close(); }
      } else {
        if (!renderer.screenshot) throw new Error('Yunzai 渲染器不可用');
        // Third-party renderer facades may consume these fields; backend support is not assumed.
        logger.debug?.('[今日小猪] 使用旧渲染器 screenshot；缩放/选择器支持由后端决定');
        image = await renderer.screenshot(name, params);
      }
      host.signal.throwIfAborted();
      if (!image) throw new Error('Yunzai 渲染器返回空结果');
      const normalized = image instanceof Uint8Array || typeof image === 'string' ? [trssSegment.image(image)] : toSegments(image);
      const result = normalized.find(item => item.type === 'image');
      if (!result) throw new Error('Yunzai 渲染器未返回图片');
      return result;
    },
    toLegacy(content, bot) {
      const constructors = oldSegment();
      return toSegments(content).flatMap(item => {
        switch (item.type) {
          case 'text': return [{ type: 'text', text: item.text }];
          case 'image': {
            const file = mediaValue(item.file);
            return [constructors?.image ? constructors.image(file) : { type: 'image', file }];
          }
          case 'at': {
            const qq = legacyId(item.uid, bot);
            return [constructors?.at ? constructors.at(qq, item.name) : { type: 'at', qq, name: item.name }];
          }
          case 'atAll': return [constructors?.at ? constructors.at('all') : { type: 'at', qq: 'all' }];
          case 'reply': return [constructors?.reply ? constructors.reply(item.messageId) : { type: 'reply', id: item.messageId }];
          case 'markdown': return [constructors?.markdown ? constructors.markdown({ content: item.content }) : { type: 'markdown', data: { content: item.content } }];
          case 'keyboard': {
            const rows = item.rows.slice(0, 5).map(row => row.slice(0, 5).map(button => {
              const result = { text: button.label, style: button.style ?? 0 };
              if (button.visitedLabel) result.clicked_text = button.visitedLabel;
              if (button.action === 'link') result.link = button.data;
              else if (button.enter) { result.callback = button.data; result.enter = true; }
              else { result.input = button.data; result.enter = false; }
              return result;
            })).filter(row => row.length);
            const value = constructors?.button ? constructors.button(...rows) : { type: 'button', data: rows };
            return Array.isArray(value) ? value.flat(Infinity) : value ? [value] : [];
          }
          case 'forward': return [{ type: 'node', data: host.forwardNodes(item.nodes ?? [], bot) }];
          default: return [item];
        }
      });
    },
    forwardNodes(nodes, bot) {
      return nodes.map(node => ({ user_id: legacyId(node.uid ?? bot?.uin ?? '', bot), nickname: node.name ?? '小猪',
        ...(node.time == null ? {} : { time: node.time }),
        ...(node.messageId == null ? { message: host.toLegacy(node.message ?? [], bot) } : { message_id: node.messageId }) }));
    },
    isQqBotEvent(event) { return /qqbot/i.test(adapterKey(event.bot ?? lookupBot(String(event.selfId ?? event.self_id ?? '')), event)); },
    toLegacyEvent(content, event) { return host.toLegacy(content, event.bot ?? lookupBot(String(event.selfId ?? event.self_id ?? '')) ?? rootBot()); },
    botForEvent(event) {
      const id = String(event.selfId ?? event.self_id ?? event.bot?.uin ?? '');
      return makeBot(event.bot ?? lookupBot(id) ?? rootBot(), id, event);
    },
  };
  host.kv = options.kv ?? createRouteKv(host.dataDir, host.signal);

  function botIds() {
    const root = rootBot();
    if (!root) return [];
    if (Array.isArray(root.uin)) return [...root.uin].map(String);
    if (root.uin != null) return [String(root.uin)];
    return Object.keys(root.bots ?? {});
  }
  function lookupBot(id) {
    const root = rootBot();
    if (!root) return undefined;
    return root.bots?.[id] ?? root[id] ?? (!Array.isArray(root.uin) && String(root.uin) === id ? root : undefined);
  }
  function makeBot(bot, selfId, event) {
    if (!bot) return undefined;
    const key = adapterKey(bot, event);
    const caps = new Set();
    if (RICH_ADAPTERS.test(key)) { caps.add('markdown'); caps.add('keyboard'); }
    if (FORWARD_ADAPTERS.test(key) && (bot.pickGroup || bot.sendGroupForwardMsg || event?.group?.sendForwardMsg)) caps.add('forward');
    const gid = String(event?.group_id ?? event?.group?.gid ?? event?.group?.group_id ?? '');
    function groupFor(id) {
      if (!event?.group || String(id) !== gid) return bot.pickGroup?.(legacyId(id, bot));
      let fallback;
      return new Proxy(event.group, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (value != null) return typeof value === 'function' ? value.bind(target) : value;
          fallback ??= bot.pickGroup?.(legacyId(id, bot));
          const alternate = fallback?.[key];
          return typeof alternate === 'function' ? alternate.bind(fallback) : alternate;
        },
      });
    }
    function contactFor(target) {
      return target.scene === 'group' ? groupFor(target.gid) : event?.friend && String(target.uid) === String(event.user_id) ? event.friend : bot.pickFriend?.(legacyId(target.uid, bot));
    }
    const facade = {
      selfId: String(selfId), platform: /dingtalk|dingding/i.test(key) ? 'dingtalk' : /qqbot|icqq|oicq|onebot|milky|lagrange/i.test(key) ? 'qq' : String(bot.platform || key.trim() || 'trss'),
      get online() { return bot.online !== false && (typeof bot.isOnline !== 'function' || bot.isOnline()) && (event != null || botIds().includes(String(selfId))); },
      caps,
      async getGroup(id) {
        const group = groupFor(id);
        const cached = mapGet(bot.gl, id, bot);
        const info = cached ?? (group?.getInfo ? await group.getInfo() : group?.info);
        if (!info) return undefined;
        return { gid: String(info.gid ?? info.group_id ?? id), name: info.name ?? info.group_name ?? '' };
      },
      async getGroupMember(id, uid) {
        const group = groupFor(id);
        const cached = mapGet(mapGet(bot.gml, id, bot), uid, bot);
        if (cached) return memberInfo(cached, uid);
        const member = event?.member && String(uid) === String(event.user_id ?? event.sender?.user_id) && String(id) === gid ? event.member : group?.pickMember?.(legacyId(uid, bot));
        if (member?.info) return memberInfo(member.info, uid);
        if (member?.getInfo) return memberInfo(await member.getInfo(), uid);
        if (group?.getMemberMap) return memberInfo(mapGet(await group.getMemberMap(), uid, bot), uid);
        if (bot.getGroupMemberInfo) return memberInfo(await bot.getGroupMemberInfo(legacyId(id, bot), legacyId(uid, bot)), uid);
        return undefined;
      },
      async getGroupMemberList(id) {
        const group = groupFor(id);
        let members;
        if (group?.getMemberMap) members = await group.getMemberMap();
        else if (group?.getMemberList) members = await group.getMemberList();
        else if (bot.getGroupMemberList) members = await bot.getGroupMemberList(legacyId(id, bot));
        else members = mapGet(bot.gml, id, bot);
        return entries(members).map(([uid, info]) => memberInfo(info, uid)).filter(Boolean);
      },
      async sendMessage(target, content, settings = {}) {
        host.signal.throwIfAborted();
        const contact = contactFor(target);
        const message = host.toLegacy(settings.quote ? [trssSegment.reply(settings.quote), content] : content, bot);
        let result;
        if (contact?.sendMsg) result = await contact.sendMsg(message);
        else if (target.scene === 'group' && bot.sendGroupMsg) result = await bot.sendGroupMsg(legacyId(target.gid, bot), message);
        else if (target.scene !== 'group' && bot.sendPrivateMsg) result = await bot.sendPrivateMsg(legacyId(target.uid, bot), message);
        else throw new Error('该旧适配器没有可用的消息发送接口');
        return normalizeSendResult(result);
      },
      async sendForward(target, nodes) {
        host.signal.throwIfAborted();
        if (!caps.has('forward')) throw new Error('该旧适配器不支持合并转发');
        const contact = contactFor(target);
        const converted = host.forwardNodes(nodes, bot);
        // TRSS injects a generic sendForwardMsg that sends nodes separately. icqq's native
        // makeForwardMsg is the real merged-forward interface and must take precedence.
        if (/icqq|oicq/i.test(key) && contact?.makeForwardMsg && contact?.sendMsg) {
          return normalizeSendResult(await contact.sendMsg(await contact.makeForwardMsg(converted)));
        }
        if (contact?.sendForwardMsg) return normalizeSendResult(await contact.sendForwardMsg(converted));
        if (target.scene === 'group' && bot.sendGroupForwardMsg) return normalizeSendResult(await bot.sendGroupForwardMsg(legacyId(target.gid, bot), converted));
        const make = contact?.makeForwardMsg?.bind(contact) ?? bot.makeForwardMsg?.bind(bot) ?? rootBot()?.makeForwardMsg?.bind(rootBot());
        if (!make || !contact?.sendMsg) throw new Error('该旧适配器没有可用的转发接口');
        return normalizeSendResult(await contact.sendMsg(await make(converted)));
      },
    };
    if (bot.getMsg || event?.group?.getMsg || event?.friend?.getMsg || event?.getReply) facade.getMessage = async messageId => {
      const raw = event?.getReply && (event.reply_id == null || String(messageId) === String(event.reply_id)) ? await event.getReply()
        : event?.group?.getMsg ? await event.group.getMsg(messageId)
          : event?.friend?.getMsg ? await event.friend.getMsg(messageId) : await bot.getMsg(messageId);
      if (!raw) return undefined;
      return { messageId: String(raw.message_id ?? messageId), sender: memberInfo(raw.sender ?? { user_id: raw.user_id }, raw.user_id),
        message: toSegments(raw.message ?? []), ...((raw.group_id ?? (event?.isGroup || event?.group_id != null ? gid : undefined)) == null ? {} : { group: { gid: String(raw.group_id ?? gid) } }) };
    };
    return facade;
  }
  host.app = {
    policy: { isMaster(uid) {
      const ids = typeof options.masterIds === 'function' ? options.masterIds() : options.masterIds ?? cfg.masterQQ;
      return (Array.isArray(ids) ? ids : [ids]).some(id => String(id) === String(uid));
    } },
    bots: {
      bySelfId(selfId) { const bot = lookupBot(String(selfId)); return makeBot(bot, String(selfId)); },
      online() { return botIds().map(id => makeBot(lookupBot(id), id)).filter(bot => bot?.online); },
    },
  };
  return host;
}
