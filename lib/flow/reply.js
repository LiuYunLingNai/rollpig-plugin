import { getContext, toSegments } from '../../host/index.js';
import configControl from '../model/config.js';

export function quoteFlag() {
  return configControl.get().reply_quote !== false;
}

// 所有输出保持 NG 原生消息段；引用和 @ 交给内核，不手拼 QQBot 私有标签。
export async function reply(e, content, quote = false) {
  getContext().signal.throwIfAborted();
  const items = toSegments(content);
  const forward = items.find(item => item?.type === 'forward' && item.nodes);
  if (forward && e.bot.caps.has('forward') && e.bot.sendForward) {
    const result = await e.bot.sendForward(e.target, forward.nodes);
    const rest = items.filter(item => item !== forward);
    if (rest.length) await e.reply(rest, { quote, at: e.isGroup });
    return result;
  }
  return e.reply(items, { quote, at: e.isGroup && !items.some(item => item?.type === 'at') });
}
