import store from '../store/store.js';
import resourceManager, { getPigById } from '../resource/resourceManager.js';
import * as T from '../model/texts.js';
import {
  buildSuccessRoastOutcome,
  buildBackfireRoastOutcome,
  isHumanPig,
  isFoodPig,
  isEatenPig,
  isSoldPig,
} from './roastFlow.js';
import { renderPigCard } from '../render/render.js';

/**
 * 预约投递（Yunzai 单进程简化版）。
 *
 * 原版 reservation_delivery / reservation_flow 依赖多 Bot 领取租约、幂等重试
 * 与后台轮询；Yunzai 版在“目标抽猪”这条命令内同步结算并投递当场可见的预约，
 * 保证核心玩法（预约 → 目标抽猪 → 自动开炉）完整可用。
 */

function participantsLabel(reservation) {
  const names = reservation.participants.map((p) => p.display_name || p.user_id);
  if (!names.length) return '大家';
  if (names.length === 1) return `【${names[0]}】`;
  if (names.length <= 3) return names.map((n) => `【${n}】`).join('、');
  return `【${names[0]}】等 ${names.length} 人`;
}

function operatorLabel(reservation) {
  return reservation.owner_name || reservation.owner_id;
}

function specialTargetOutcome(reservation, targetPig) {
  const values = {
    participants: participantsLabel(reservation),
    target: reservation.target_name || reservation.target_id,
    pig: targetPig.name || '未知小猪',
  };
  let pool = null;
  let specialReason = '';
  if (isHumanPig(targetPig)) {
    pool = T.RESERVED_TARGET_HUMAN_TEXTS;
    specialReason = 'human';
  } else if (isFoodPig(targetPig)) {
    pool = T.RESERVED_TARGET_FOOD_TEXTS;
    specialReason = 'food';
  } else if (isEatenPig(targetPig)) {
    pool = T.RESERVED_TARGET_EATEN_TEXTS;
    specialReason = 'eaten';
  } else if (isSoldPig(targetPig)) {
    pool = T.RESERVED_TARGET_SOLD_TEXTS;
    specialReason = 'sold';
  } else {
    return null;
  }
  return {
    event_type: 'reserved_special',
    render_data: null,
    plain_text: T.formatText(T.pick(pool), values),
    extra_text: '',
    food_name: '',
    backfire_victim_id: '',
    backfire_victim_name: '',
    special_reason: specialReason,
  };
}

/**
 * 计算一场预约的结算结果。
 */
async function buildReservationOutcome(reservation) {
  const targetPig = getPigById(reservation.target_pig_id);
  if (!targetPig) return null;

  const special = specialTargetOutcome(reservation, targetPig);
  if (special) return special;

  const values = {
    participants: participantsLabel(reservation),
    target: reservation.target_name || reservation.target_id,
    pig: targetPig.name || '未知小猪',
  };

  const roll = reservation.force_mode ? 1 : Math.floor(Math.random() * 100) + 1;
  if (roll <= 60) {
    const prefix = T.formatText(T.pick(T.ROAST_RESERVATION_SUCCESS_TEXTS), values) + '\n\n';
    return await buildSuccessRoastOutcome(targetPig, {
      attackerName: operatorLabel(reservation),
      targetName: reservation.target_name || reservation.target_id,
      extraText: prefix,
    });
  }
  if (roll <= 90) {
    return {
      event_type: 'escape',
      render_data: null,
      plain_text: T.formatText(T.pick(T.ROAST_RESERVATION_ESCAPE_TEXTS), values),
      extra_text: '',
      food_name: '',
      backfire_victim_id: '',
      backfire_victim_name: '',
      special_reason: '',
    };
  }

  // 反噬：随机挑一名参与者
  const victim = reservation.participants[Math.floor(Math.random() * reservation.participants.length)];
  const victimPig = getPigById(victim.pig_id);
  if (!victimPig) return null;
  const prefix =
    T.formatText(T.pick(T.ROAST_RESERVATION_BACKFIRE_TEXTS), {
      ...values,
      victim: victim.display_name || victim.user_id,
    }) + '\n\n';
  const outcome = await buildBackfireRoastOutcome(victimPig, {
    attackerName: victim.display_name || victim.user_id,
    targetName: reservation.target_name || reservation.target_id,
    extraText: prefix,
  });
  outcome.backfire_victim_id = victim.user_id;
  outcome.backfire_victim_name = victim.display_name || victim.user_id;
  return outcome;
}

/**
 * 目标抽猪后，投递所有已就绪（ready）的预约。
 * @param {object} e Yunzai 消息事件（用于回群发送）
 * @param {string} botId 当前 Bot 自身 QQ
 */
export async function deliverReadyReservations(e, botId) {
  return deliverNewlyReadyReservations(e, botId ?? (e && e.self_id));
}

export async function deliverNewlyReadyReservations(e, botId) {
  let reservations;
  try {
    reservations = store.claimReadyReservations(String(botId));
  } catch (err) {
    logger?.warn?.(`[今日小猪] 预约领取失败: ${err}`);
    return;
  }
  for (const reservation of reservations) {
    try {
      await deliverOne(e, reservation);
    } catch (err) {
      logger?.error?.(`[今日小猪] 预约投递失败: ${reservation.reservation_id} ${err}`);
    }
  }
}

async function deliverOne(e, reservation) {
  const outcome = await buildReservationOutcome(reservation);
  if (!outcome) return;

  // 结算加餐（普通预约成功时）
  let feedText = '';
  if (outcome.event_type === 'success' && !reservation.force_mode) {
    const feeds = store.settleReservationFeeds(reservation);
    const fedNames = [];
    for (const feed of feeds) {
      if (feed && feed.status === 'fed' && feed.new_level > feed.previous_level) {
        const pig = resourceManager.getPigById(feed.pig_id);
        fedNames.push(pig ? pig.name || feed.pig_id : feed.pig_id);
      }
    }
    if (fedNames.length) {
      feedText =
        '\n' +
        T.formatText(T.pick(T.DAILY_FEED_RESERVATION_TEXTS), {
          participants: fedNames.map((n) => `【${n}】`).join('、'),
        });
    }
  }

  // 记录事件
  store.appendRoastEvent({
    event_type: outcome.event_type,
    attacker_id: reservation.owner_id,
    target_id: reservation.target_id,
    attacker_name: reservation.owner_name,
    target_name: reservation.target_name,
    food: outcome.food_name,
    group_id: reservation.group_id,
    reservation_id: reservation.reservation_id,
    participant_ids: reservation.participants.map((p) => p.user_id),
    backfire_victim_id: outcome.backfire_victim_id,
    special_reason: outcome.special_reason,
  });

  // 发送
  await sendOutcome(e, reservation, outcome, feedText);
}

async function sendOutcome(e, reservation, outcome, feedText) {
  const groupId = Number(reservation.group_id) || reservation.group_id;
  const send = async (msg) => {
    try {
      if (e?.group_id && String(e.group_id) === String(reservation.group_id)) {
        await e.reply(msg);
      } else if (global.Bot?.pickGroup) {
        await global.Bot.pickGroup(groupId).sendMsg(msg);
      }
    } catch (err) {
      logger?.warn?.(`[今日小猪] 预约结果发送失败: ${err}`);
    }
  };

  if (outcome.render_data) {
    try {
      const appearance = resourceManager.resolvePigAppearance(outcome.render_data, 0);
      const img = await renderPigCard(outcome.render_data, appearance.image_path, 0);
      const parts = [];
      if (outcome.extra_text) parts.push(outcome.extra_text.replace(/[\r\n]+$/, ''));
      parts.push(img);
      if (feedText) parts.push(feedText.replace(/^[\r\n]+/, ''));
      await send(parts);
      return;
    } catch (err) {
      logger?.warn?.(`[今日小猪] 预约卡片渲染失败，改发文本: ${err}`);
    }
  }
  let text = outcome.extra_text + (outcome.plain_text || '');
  if (feedText) text += '\n' + feedText;
  await send(text);
}
