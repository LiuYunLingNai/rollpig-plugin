import configControl from '../model/config.js';

/**
 * 读取「引用消息回复」配置，返回传给 e.reply 的 quote 参数。
 * reply_quote 默认 true（引用触发消息）；设为 false 时全插件回复都不引用。
 */
export function quoteFlag() {
  return configControl.get().reply_quote !== false;
}
