import { CommandGroup } from '../lib/flow/base.js';
import store from '../lib/store/store.js';
import { getEventUserName } from '../lib/flow/helpers.js';
import { pickReservationPrepareText } from '../lib/flow/roastFlow.js';
import { quoteFlag, reply } from '../lib/flow/reply.js';

/**
 * 回复预约通知加入。用户回复 Bot 发出的预约通知，发送「加入/加入预约/加入烤猪」。
 */
export class RollPigReservationJoin extends CommandGroup {
  constructor() {
    super({
      name: '预约烤猪加入',
      dsc: '回复预约通知加入烤猪',
      event: 'message',
      priority: 490,
      rule: [{ reg: '^[#/]?(加入|加入预约|加入烤猪)$', fnc: 'joinReservation' }],
    });
  }

  async joinReservation(e) {
    if (!e.group?.gid) return false;
    const replyMessageId = e.quote?.messageId;
    if (!replyMessageId) return false;
    if (e.quote.sender && String(e.quote.sender.uid) !== String(e.selfId)) return false;

    const name = getEventUserName(e);
    store.recordUserName(String(e.sender.uid), name);
    const preparation = store.joinRoastReservationByMessage({
      botId: String(e.selfId),
      groupId: String(e.group?.gid),
      messageId: String(replyMessageId),
      attackerId: String(e.sender.uid),
      attackerName: name,
    });
    if (preparation.status === 'message_not_found') return false;

    const targetName = preparation.reservation ? preparation.reservation.target_name : '';
    await reply(e, pickReservationPrepareText(preparation, { attackerName: name, targetName }), quoteFlag());
    return true;
  }
}
