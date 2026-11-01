import { getContext } from './index.js';
import { normalizeSendResult, toSegments } from './trss.js';

function quotedMessageId(event, source, selfId, isGroup, groupId) {
  const explicit = source?.messageId ?? source?.message_id ?? source?.id ?? event.reply_id
    ?? event.message?.find(item => item.type === 'reply')?.id;
  if (explicit != null) return String(explicit);
  const adapter = event.bot?.adapter;
  const key = `${typeof adapter === 'string' ? adapter : adapter?.id ?? ''} ${adapter?.name ?? ''}`;
  if (!/icqq|oicq/i.test(key) || !source) return undefined;
  // icqq source has seq/rand/time/user_id but no message_id. Match its canonical ID encoding.
  const uid = Number(isGroup ? source.user_id : source.user_id ?? selfId);
  if ([source.seq, source.rand, source.time].some(value => value == null)) return undefined;
  const seq = Number(source.seq), rand = Number(source.rand), time = Number(source.time);
  if (![uid, seq, rand, time].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) return undefined;
  if (isGroup) {
    const gid = Number(groupId);
    if (!Number.isInteger(gid) || gid < 0 || gid > 0xffffffff) return undefined;
    const buffer = Buffer.alloc(21);
    buffer.writeUInt32BE(gid, 0); buffer.writeUInt32BE(uid, 4);
    buffer.writeUInt32BE(seq, 8); buffer.writeUInt32BE(rand, 12); buffer.writeUInt32BE(time, 16);
    buffer.writeUInt8(Number(source.pktnum) > 1 ? Math.min(255, Number(source.pktnum)) : 1, 20);
    return buffer.toString('base64');
  }
  const buffer = Buffer.alloc(17);
  buffer.writeUInt32BE(uid, 0); buffer.writeUInt32BE(seq, 4); buffer.writeUInt32BE(rand, 8); buffer.writeUInt32BE(time, 12);
  buffer.writeUInt8(String(source.user_id) === selfId ? 1 : 0, 16);
  return buffer.toString('base64');
}

/** Make a new event; in particular never replace or mutate the legacy event.reply. */
export function normalizeTrssEvent(event, host = getContext()) {
  if (!event || typeof event !== 'object') throw new TypeError('缺少 TRSS 消息事件');
  const sender = event.sender ?? {};
  const uid = String(sender.uid ?? sender.user_id ?? event.user_id ?? '');
  const selfId = String(event.selfId ?? event.self_id ?? event.bot?.uin ?? '');
  const groupId = event.group?.gid ?? event.group_id ?? event.group?.group_id;
  const isGroup = Boolean(event.isGroup ?? (event.message_type === 'group' || groupId != null));
  const bot = host.botForEvent(event);
  if (!bot) throw new Error(`无法取得 TRSS Bot ${selfId}`);
  const message = toSegments(event.message ?? []);
  const atUsers = [...new Set([
    ...message.filter(item => item.type === 'at').map(item => String(item.uid)),
    ...(Array.isArray(event.atUsers) ? event.atUsers.map(String) : []),
    ...(event.at != null && event.at !== 'all' ? (Array.isArray(event.at) ? event.at.map(String) : [String(event.at)]) : []),
  ])];
  const source = event.quote ?? event.source;
  const messageId = quotedMessageId(event, source, selfId, isGroup, groupId)
    ?? (source && event.getReply ? '__trss_source_quote__' : undefined);
  const quoteUid = source?.sender?.uid ?? source?.sender?.user_id ?? source?.user_id ?? source?.qq;
  const role = sender.role ?? event.member?.role ?? event.member?.info?.role;
  const target = isGroup ? { scene: 'group', gid: String(groupId ?? '') } : { scene: 'private', uid };
  const normalized = {
    trssEvent: event, bot, selfId, target,
    messageId: String(event.messageId ?? event.message_id ?? ''),
    sender: { uid, card: sender.card ?? event.member?.card ?? '', name: sender.name ?? sender.nickname ?? event.nickname ?? '' },
    ...(isGroup ? { group: { gid: target.gid, name: event.group_name ?? event.group?.name ?? event.group?.group_name ?? '' } } : {}),
    isGroup, isPrivate: !isGroup,
    isMaster: Boolean(event.isMaster || host.app.policy.isMaster(uid)),
    isGroupAdmin: Boolean(event.isGroupAdmin || event.is_admin || role === 'admin' || role === 'owner'),
    isGroupOwner: Boolean(event.isGroupOwner || event.is_owner || role === 'owner'),
    text: String(event.text ?? event.msg ?? message.filter(item => item.type === 'text').map(item => item.text).join('')),
    message, atUsers, atMe: Boolean(event.atMe || event.atBot || event.atme || atUsers.includes(selfId)),
    ...(messageId == null ? {} : { quote: { messageId,
      ...(quoteUid == null ? {} : { sender: { uid: String(quoteUid), name: source?.sender?.name ?? source?.sender?.nickname ?? '' } }) } }),
    async reply(content, options = {}) {
      host.signal.throwIfAborted();
      const replyOptions = typeof options === 'boolean' ? { quote: options } : options;
      if (typeof event.reply === 'function') {
        const items = host.toLegacyEvent(content, event);
        let at = replyOptions.at ?? false;
        const openid = event.sender?.openid ?? event.raw?.sender?.openid ?? event.user_openid;
        if (at && isGroup && openid && host.isQqBotEvent(event)
          && !items.some(item => item.type === 'at' || item.type === 'text' && item.text.includes('<qqbot-at-user'))) {
          const escaped = String(openid).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
          items.unshift({ type: 'text', text: `<qqbot-at-user id="${escaped}" />\r` });
          at = false;
        }
        const result = await event.reply(items, Boolean(replyOptions.quote), {
          at,
          ...(replyOptions.recallAfter == null ? {} : { recallMsg: replyOptions.recallAfter / 1000 }),
        });
        return normalizeSendResult(result);
      }
      const items = replyOptions.at && isGroup ? [host.segment.at(uid), content] : content;
      return bot.sendMessage(target, items, { quote: replyOptions.quote ? normalized.messageId : undefined });
    },
  };
  return normalized;
}
