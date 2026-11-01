import { AsyncLocalStorage } from 'node:async_hooks';

let context;
let queue = Promise.resolve();
let pending = 0;
const operations = new AsyncLocalStorage();

export async function waitForOperations() {
  await queue;
}

// 两个宿主共享串行队列；异步续执行保留原实例的卸载信号。
export function runSerialized(fn, signal) {
  const ctx = getContext();
  const operationSignal = signal ? AbortSignal.any([ctx.signal, signal]) : ctx.signal;
  if (pending >= 32) return Promise.reject(new Error('今日小猪操作排队已满，请稍后再试。'));
  pending += 1;
  const scoped = new Proxy(ctx, {
    get(target, key) {
      if (key === 'signal') return operationSignal;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const operation = queue.then(() => operations.run(scoped, async () => {
    operationSignal.throwIfAborted();
    return fn();
  }));
  queue = operation.catch(() => {}).finally(() => { pending -= 1; });
  return operation;
}

export function bindContext(ctx) {
  if (context && !context.signal.aborted && context !== ctx) {
    throw new Error('rollpig 已在另一实例运行，请为每个主目录安装独立插件副本。');
  }
  context = ctx;
}

export function getContext() {
  const ctx = operations.getStore() ?? context;
  if (!ctx) throw new Error('rollpig 宿主适配层未初始化');
  return ctx;
}

export function hostKind() {
  return getContext().kind;
}

export const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
  level, (...args) => (operations.getStore() ?? context)?.logger[level](...args),
]));

// 不在公共模块 import NG：TRSS 无需安装 @yunzai-ng/core。
export const segment = new Proxy({}, {
  get(_target, key) { return (...args) => getContext().segment[key](...args); },
});
export function toSegments(content) {
  return getContext().toSegments(content);
}

export function hostFetch(input, options = {}) {
  const ctx = getContext();
  const signals = [ctx.signal, options.signal].filter(Boolean);
  return fetch(input, { ...options, signal: AbortSignal.any(signals) });
}

export function onlineBotIds() {
  return getContext().app.bots.online().map(bot => String(bot.selfId));
}

export async function rememberGroup(e) {
  if (!e.isGroup || !e.group) return;
  await getContext().kv.set(`group:${e.group.gid}`, { selfId: e.selfId, platform: e.bot.platform });
}

export async function resolveGroupBot(groupId) {
  const ctx = getContext();
  ctx.signal.throwIfAborted();
  const route = await ctx.kv.get(`group:${groupId}`);
  ctx.signal.throwIfAborted();
  if (route) {
    const bot = ctx.app.bots.bySelfId(route.selfId);
    if (bot?.online && bot.platform === route.platform) return bot;
    return null;
  }
  for (const bot of ctx.app.bots.online()) {
    if (await bot.getGroup(String(groupId)).catch(() => undefined)) return bot;
  }
  return null;
}
