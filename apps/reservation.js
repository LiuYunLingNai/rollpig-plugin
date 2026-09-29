import plugin from '../../../lib/plugins/plugin.js';
import store from '../lib/store/store.js';
import { getEventUserName } from '../lib/flow/helpers.js';
import { pickReservationPrepareText } from '../lib/flow/roastFlow.js';
import { quoteFlag } from '../lib/flow/reply.js';

/**
 * 回复预约通知加入。用户回复 Bot 发出的预约通知，发送「加入/加入预约/加入烤猪」。
 */
export class RollPigReservationJoin extends plugin {
  constructor() {
    super({
      name: '预约烤猪加入',
      dsc: '回复预约通知加入烤猪',
      event: 'message',
      priority: 490,
      rule: [{ reg: '^(加入|加入预约|加入烤猪)$', fnc: 'joinReservation' }],
    });
  }

  async joinReservation(e) {
    if (!e.group_id) return false;
    // 必须是回复 Bot 自身的消息
    const source = e.source || e.reply_id;
    if (!source) return false;
    let replyMessageId = null;
    if (e.source?.message_id) replyMessageId = e.source.message_id;
    else if (e.reply_id) replyMessageId = e.reply_id;
    else if (e.source?.seq) replyMessageId = e.source.seq;
    if (!replyMessageId) return false;

    const name = getEventUserName(e);
    store.recordUserName(String(e.user_id), name);
    const preparation = store.joinRoastReservationByMessage({
      botId: String(e.self_id),
      groupId: String(e.group_id),
      messageId: String(replyMessageId),
      attackerId: String(e.user_id),
      attackerName: name,
    });
    if (preparation.status === 'message_not_found') return false;

    const targetName = preparation.reservation ? preparation.reservation.target_name : '';
    await e.reply(pickReservationPrepareText(preparation, { attackerName: name, targetName }), quoteFlag());
    return true;
  }
}
