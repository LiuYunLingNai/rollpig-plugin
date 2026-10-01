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

/** 是否 QQBot 官方端（兼容 TRSS 对象式 adapter 与 Lain 字符串式 e.adapter） */
function isQQBotEnd(e) {
  const adapter = e?.bot?.adapter;
  const name = String(
    e?.adapter || adapter?.name || adapter?.id || (typeof adapter === 'string' ? adapter : '') || ''
  ).toLowerCase();
  return name.includes('qqbot');
}

/** 取触发者 openid（QQBot 官方端 <qqbot-at-user id="openid"> 需要） */
function openidOf(e) {
  return e?.sender?.openid || e?.raw?.sender?.openid || e?.user_openid || '';
}

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
          const hasAt = arr.some(
            (m) => m?.type === 'at' || (typeof m === 'string' && m.includes('<qqbot-at-user'))
          );
          if (e.isGroup && e.user_id && !hasAt) {
            if (isQQBotEnd(e)) {
              // QQBot 官方端：用官方 @ 语法（写在 markdown 正文里，适配器原样透传）
              const oid = openidOf(e);
              if (oid) arr.unshift({ type: 'text', text: `<qqbot-at-user id="${oid}" />\r` });
              else arr.unshift(segment.at(e.user_id));
            } else {
              arr.unshift(segment.at(e.user_id));
            }
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
