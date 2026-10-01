/**
 * 小猪插件 apps 的公共基类。
 *
 * 作用：当消息命中「小猪插件」的任一命令时，为该事件的 e.reply 加一层包装，
 * 统一在回复「最上方」@ 触发者（仅群聊）。其它插件的回复不受影响。
 *
 * 实现要点：
 * - accept 阶段判断 e.msg 是否命中本插件的任一 rule；命中才包装，避免影响普通消息。
 * - 用 e.__rollpigAtWrapped 保证同一事件只包装一次。
 */
import plugin from '../../../../lib/plugins/plugin.js';

export class RollPigApp extends plugin {
  async accept(e) {
    try {
      if (e && !e.__rollpigAtWrapped && typeof e.reply === 'function' && this._matchRollPig(e)) {
        e.__rollpigAtWrapped = true;
        const _reply = e.reply;
        e.reply = (msg, ...args) => {
          if (!msg) return _reply(msg, ...args);
          const arr = Array.isArray(msg) ? [...msg] : [msg];
          // 群聊且首段不是 at 时，在顶部 @ 触发者
          if (e.isGroup && e.user_id && !arr.some((m) => m?.type === 'at')) {
            arr.unshift(segment.at(e.user_id));
          }
          return _reply(arr, ...args);
        };
      }
    } catch (err) {
      // 包装失败不影响正常流程
    }
    return false;
  }

  /** 当前消息是否命中本插件的任一命令规则 */
  _matchRollPig(e) {
    const msg = typeof e?.msg === 'string' ? e.msg : '';
    if (!msg) return false;
    const rules = Array.isArray(this.rule) ? this.rule : [];
    for (const r of rules) {
      if (!r || r.reg === undefined || r.reg === null) continue;
      try {
        const reg = r.reg instanceof RegExp ? r.reg : new RegExp(r.reg);
        if (reg.test(msg)) return true;
      } catch {
        // 忽略非法正则
      }
    }
    return false;
  }
}
