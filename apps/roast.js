import plugin from '../../../lib/plugins/plugin.js';
import { segment } from 'oicq';
import store from '../lib/store/store.js';
import resourceManager, { getPigById } from '../lib/resource/resourceManager.js';
import { renderPigCard } from '../lib/render/render.js';
import { resolveDailyPig, RECORDED_PIG_RESOURCE_MISSING_TEXT } from '../lib/flow/rollFlow.js';
import { deliverReadyReservations } from '../lib/flow/reservationFlow.js';
import {
  RoastFoodMissingError,
  buildSelfRoastData,
  buildMemberRoastOutcome,
  detectForceRoastMode,
  formatCooldownMessage,
  pickForceLimitText,
  pickFoodPig,
  pickSelfRoastBlockText,
  pickMemberTargetBlockText,
  pickRandomTargetBlockText,
  pickReservationPrepareText,
} from '../lib/flow/roastFlow.js';
import {
  getEventGroupId,
  getEventUserName,
  getGroupMemberDisplayName,
  getGroupRollCandidates,
  resolveRoastTarget,
  buildDailyFeedRoastText,
} from '../lib/flow/helpers.js';
import { resolveRoastCooldownSeconds, resolveRoastChargeMax } from '../lib/model/runtime.js';
import * as T from '../lib/model/texts.js';
import { withButtons, buildPigDetailMarkdown, isQQBot, ROAST_BUTTONS, ROAST_REFILL_GUIDE_BUTTONS } from '../lib/flow/qqbot.js';
import configControl from '../lib/model/config.js';
import { quoteFlag } from '../lib/flow/reply.js';
import crypto from 'crypto';

/**
 * 渲染并发送小猪卡片（烤猪成品）。
 * - 非 QQBot 端 / 未开 Markdown：puppeteer 渲染整卡（图文合一）。
 * - QQBot 端且开启 Markdown：图片段 + 引用块文字 + 按钮，交给适配器合并成一条。
 */
async function sendRoastCard(e, pigData, { extraText = '', trailingText = '', buttons = ROAST_BUTTONS } = {}) {
  const appearance = resourceManager.resolvePigAppearance(pigData, 0);

  if (isQQBot(e) && configControl.get().qqbot_markdown_enabled) {
    const msg = [];
    if (appearance.image_path) msg.push(segment.image(appearance.image_path));
    let text = buildPigDetailMarkdown(appearance.pig_data, { heading: extraText });
    if (trailingText) text += '\r' + String(trailingText).replace(/^[\r\n]+/, '');
    if (text) msg.push(text);
    await e.reply(withButtons(e, msg, buttons), quoteFlag());
    return true;
  }

  let img;
  try {
    img = await renderPigCard(appearance.pig_data, appearance.image_path, 0);
  } catch (err) {
    logger?.error?.(`[今日小猪] 烤猪卡片渲染失败: ${err}`);
    await e.reply('图片生成失败。', quoteFlag());
    return false;
  }
  const msg = [];
  if (extraText) msg.push(extraText.replace(/[\r\n]+$/, ''));
  msg.push(img);
  if (trailingText) msg.push(trailingText.replace(/^[\r\n]+/, ''));
  await e.reply(withButtons(e, msg, buttons), quoteFlag());
  return true;
}

/**
 * 落库并发送烤群友结果。
 */
async function finishRoastOutcome(e, outcome, {
  attackerId, attackerName, targetId, targetName, groupId, dailyFeedEligible = false,
}) {
  const feed = store.appendRoastEvent(
    {
      event_type: outcome.event_type,
      attacker_id: attackerId,
      target_id: targetId,
      attacker_name: attackerName,
      target_name: targetName,
      food: outcome.food_name,
      group_id: groupId,
      event_id: crypto.randomBytes(8).toString('hex'),
    },
    { settleDailyFeed: dailyFeedEligible && outcome.event_type === 'success' }
  );
  const feedText = buildDailyFeedRoastText(feed);
  if (outcome.render_data) {
    await sendRoastCard(e, outcome.render_data, {
      extraText: outcome.extra_text,
      trailingText: feedText,
    });
    return;
  }
  let text = outcome.plain_text;
  if (feedText) text += '\n' + feedText;
  await e.reply(withButtons(e, text, ROAST_BUTTONS), quoteFlag());
}

export class RollPigRoast extends plugin {
  constructor() {
    super({
      name: '烤猪',
      dsc: '今日烤猪、烤群友、随机烤猪、加急生火、烤箱续火',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#?今日烤猪$', fnc: 'selfRoast' },
        { reg: '^#?(烤群友|加急生火|强行点火|打点后厨|偷换烤架|贿赂主厨).*', fnc: 'roastMember' },
        { reg: '^#?(随机烤群友|随机烤猪|抽个群友烤了)$', fnc: 'randomRoast' },
        { reg: '^#?(烤箱续火|烤箱补货)$', fnc: 'refill' },
      ],
    });
  }

  // ================= 今日烤猪 =================
  async selfRoast(e) {
    const userId = String(e.user_id);
    const groupId = getEventGroupId(e);
    const attackerName = getEventUserName(e);
    const resolution = resolveDailyPig(userId, groupId);
    const originalPig = resolution.pig;
    if (resolution.recorded_pig_missing) {
      await e.reply(RECORDED_PIG_RESOURCE_MISSING_TEXT, quoteFlag());
      return true;
    }
    if (resolution.missing_resources || !originalPig) {
      await e.reply('猪圈塌房了（数据缺失）', quoteFlag());
      return true;
    }
    let autoRollHint = '';
    if (resolution.was_auto_created) {
      autoRollHint = T.pickFormat(T.AUTO_ROLL_ROAST_TEXTS, { name: originalPig.name }) + '\n';
    }
    const blockText = pickSelfRoastBlockText(originalPig);
    if (blockText) {
      await e.reply(blockText, quoteFlag());
      if (resolution.was_auto_created) await deliverReadyReservations(e).catch(() => {});
      return true;
    }
    let roastedData, foodName;
    try {
      ({ roastedData, foodName } = await buildSelfRoastData(originalPig));
    } catch (err) {
      await e.reply(String(err.message || err), quoteFlag());
      return true;
    }
    if (groupId) {
      store.appendRoastEvent({
        event_type: 'self_roast',
        attacker_id: userId,
        target_id: userId,
        attacker_name: attackerName,
        target_name: attackerName,
        food: foodName,
        group_id: groupId,
      });
    }
    await sendRoastCard(e, roastedData, { extraText: autoRollHint });
    if (resolution.was_auto_created) await deliverReadyReservations(e).catch(() => {});
    return true;
  }

  // ================= 烤群友 / 加急生火 =================
  async roastMember(e) {
    if (!e.group_id) {
      await e.reply('烤群友只能在群里玩哦。', quoteFlag());
      return true;
    }
    const attackerId = String(e.user_id);
    const attackerName = getEventUserName(e);
    const groupId = String(e.group_id);
    const forceMode = detectForceRoastMode(e.msg || '', attackerId);
    if (forceMode === 'super_denied') {
      await e.reply('口令【强行点火】仅主人可用。', quoteFlag());
      return true;
    }

    store.recordUserName(attackerId, attackerName);
    const target = await resolveRoastTarget(e);
    const targetId = target.targetId;
    const targetName = target.targetName;
    if (target.isGroupMember && targetId) store.recordUserName(targetId, targetName);
    const kind = !targetId
      ? 'missing'
      : targetId === attackerId
        ? 'self'
        : targetId === String(e.self_id)
          ? 'bot'
          : 'member';

    if (kind === 'missing') {
      await e.reply('请 At 或回复你要烤的群友！', quoteFlag());
      return true;
    }
    if (kind === 'self') {
      await e.reply('对自己好一点，别自焚。请发送「今日烤猪」。', quoteFlag());
      return true;
    }
    if (kind === 'bot') {
      let foodName = '美食';
      try {
        foodName = pickFoodPig().name;
      } catch { /* ignore */ }
      const botText = T.pickFormat(T.ROAST_BOT_TEXTS, { attacker: attackerName, food: foodName });
      store.appendRoastEvent({
        event_type: 'bot_backfire',
        attacker_id: attackerId,
        target_id: targetId,
        attacker_name: attackerName,
        target_name: targetName,
        food: foodName,
        group_id: groupId,
      });
      await e.reply(botText, quoteFlag());
      return true;
    }
    if (!target.isGroupMember) {
      await e.reply('暂时无法确认对方仍在本群，请核对成员后再试。', quoteFlag());
      return true;
    }

    // 攻击者今日小猪
    const attackerPigId = store.getDailyRoll(attackerId);
    if (!attackerPigId) {
      await this._finishUnrolledAttempt(e, attackerName, forceMode);
      return true;
    }
    const attackerPig = getPigById(attackerPigId);
    if (!attackerPig) {
      await e.reply(RECORDED_PIG_RESOURCE_MISSING_TEXT, quoteFlag());
      return true;
    }
    store.markGroupRollSeen(attackerId, attackerPig.id, groupId);

    // 目标状态与预约准备
    const preparation = store.prepareRoastReservation({
      attackerId,
      attackerName,
      attackerPigId: attackerPig.id,
      targetId,
      targetName,
      groupId,
      deliveryBotId: String(e.self_id),
      forceMode,
      cooldownSeconds: resolveRoastCooldownSeconds(),
      maxCharges: resolveRoastChargeMax(),
    });

    let targetPig = null;
    if (preparation.status !== 'target_ready') {
      if (preparation.status === 'protected') {
        await e.reply(
          withButtons(e, T.pickFormat(T.PROTECTION_BLOCK_TEXTS, { target: targetName }), ROAST_BUTTONS),
          quoteFlag()
        );
        return true;
      }
      if (preparation.status === 'cooldown_denied' && preparation.cooldown) {
        await e.reply(
          withButtons(e, formatCooldownMessage(preparation.cooldown.remaining_seconds), ROAST_BUTTONS),
          quoteFlag()
        );
        return true;
      }
      if (preparation.status === 'force_denied') {
        await e.reply(pickForceLimitText(attackerName, targetName), quoteFlag());
        return true;
      }
      // 预约创建/加入
      let prefix = '';
      if (preparation.protection_broken) {
        prefix = T.pickFormat(T.PROTECTION_BREAK_TEXTS, { target: targetName }) + '\n';
      }
      const noticeText = prefix + pickReservationPrepareText(preparation, { attackerName, targetName });
      const sendRet = await e.reply(noticeText, quoteFlag());
      // 绑定通知消息 ID，支持回复加入
      if (preparation.reservation && ['reservation_created', 'reservation_joined', 'already_joined'].includes(preparation.status)) {
        const messageId = sendRet?.message_id || sendRet?.data?.message_id;
        if (messageId) {
          store.bindRoastReservationMessage({
            reservationId: preparation.reservation.reservation_id,
            botId: String(e.self_id),
            groupId,
            messageId: String(messageId),
            dateStr: preparation.reservation.date_str,
          });
        }
      }
      return true;
    }
    targetPig = getPigById(preparation.target_pig_id);

    if (preparation.protection_broken) {
      await e.reply(T.pickFormat(T.PROTECTION_BREAK_TEXTS, { target: targetName }), quoteFlag());
    }
    if (!targetPig) {
      await e.reply('目标的小猪资源缺失，暂时无法开火。', quoteFlag());
      return true;
    }
    store.markGroupRollSeen(targetId, targetPig.id, groupId);

    const blockText = pickMemberTargetBlockText(targetName, targetPig);
    if (blockText) {
      await e.reply(blockText, quoteFlag());
      return true;
    }

    // target_ready 时预约层未扣资源，这里补扣
    if (forceMode === 'normal') {
      if (!store.consumeForceUsage(attackerId)) {
        await e.reply(pickForceLimitText(attackerName, targetName), quoteFlag());
        return true;
      }
    } else if (!forceMode) {
      const cd = store.consumeRoastCooldown(attackerId, {
        cooldownSeconds: resolveRoastCooldownSeconds(),
        maxCharges: resolveRoastChargeMax(),
      });
      if (!cd.allowed) {
        await e.reply(withButtons(e, formatCooldownMessage(cd.remaining_seconds), ROAST_BUTTONS), quoteFlag());
        return true;
      }
    }

    let outcome;
    try {
      outcome = await buildMemberRoastOutcome({
        attackerPig,
        targetPig,
        attackerName,
        targetName,
        forceMode,
      });
    } catch (err) {
      await e.reply(String(err.message || err), quoteFlag());
      return true;
    }
    await finishRoastOutcome(e, outcome, {
      attackerId,
      attackerName,
      targetId,
      targetName,
      groupId,
      dailyFeedEligible: forceMode == null,
    });
    return true;
  }

  async _finishUnrolledAttempt(e, attackerName, forceMode) {
    const attempt = store.recordUnrolledRoastAttempt(String(e.user_id));
    if (attempt.count <= 1) {
      await e.reply(withButtons(e, T.pick(T.UNROLLED_ROAST_WARNING_TEXTS), ROAST_BUTTONS), quoteFlag());
      return;
    }
    let foodPig;
    try {
      foodPig = { ...pickFoodPig() };
    } catch (err) {
      await e.reply(String(err.message || err), quoteFlag());
      return;
    }
    const pool = forceMode ? T.UNROLLED_FORCE_ROAST_BACKFIRE_TEXTS : T.UNROLLED_ROAST_BACKFIRE_TEXTS;
    foodPig.analysis = T.formatText(T.pick(pool), { attacker: attackerName, food: foodPig.name || '熟食' });
    await sendRoastCard(e, foodPig, {});
  }

  // ================= 随机烤群友 =================
  async randomRoast(e) {
    if (!e.group_id) {
      await e.reply('随机烤猪只能在群里玩哦。', quoteFlag());
      return true;
    }
    const attackerId = String(e.user_id);
    const attackerName = getEventUserName(e);
    const groupId = String(e.group_id);

    const candidates = await getGroupRollCandidates(e, store, new Set([attackerId, String(e.self_id)]));
    if (candidates === null) {
      await e.reply(withButtons(e, '暂时无法读取当前群成员，随机烤猪没有执行。', ROAST_BUTTONS), quoteFlag());
      return true;
    }
    if (!candidates.length) {
      await e.reply(withButtons(e, '今天还没有别人抽猪，没有可以烤的目标！', ROAST_BUTTONS), quoteFlag());
      return true;
    }
    const attackerPigId = store.getDailyRoll(attackerId);
    if (!attackerPigId) {
      await this._finishUnrolledAttempt(e, attackerName, null);
      return true;
    }
    const attackerPig = getPigById(attackerPigId);
    if (!attackerPig) {
      await e.reply(withButtons(e, RECORDED_PIG_RESOURCE_MISSING_TEXT, ROAST_BUTTONS), quoteFlag());
      return true;
    }
    store.markGroupRollSeen(attackerId, attackerPig.id, groupId);

    const targetId = candidates[Math.floor(Math.random() * candidates.length)];
    const targetName = await getGroupMemberDisplayName(e, targetId);
    const targetPig = getPigById(store.getDailyRoll(targetId));
    if (!targetPig) {
      await e.reply(withButtons(e, `系统随机选中了【${targetName}】，但对方的猪数据异常。`, ROAST_BUTTONS), quoteFlag());
      return true;
    }
    store.markGroupRollSeen(targetId, targetPig.id, groupId);

    if (store.isProtected(groupId, targetId)) {
      const protText = T.pickFormat(T.PROTECTION_BLOCK_TEXTS, { target: targetName });
      await e.reply(withButtons(e, `系统随机选中了【${targetName}】——\n${protText}`, ROAST_BUTTONS), quoteFlag());
      return true;
    }
    const blockText = pickRandomTargetBlockText(targetName, targetPig);
    if (blockText) {
      await e.reply(withButtons(e, blockText, ROAST_BUTTONS), quoteFlag());
      return true;
    }
    const cd = store.consumeRoastCooldown(attackerId, {
      cooldownSeconds: resolveRoastCooldownSeconds(),
      maxCharges: resolveRoastChargeMax(),
    });
    if (!cd.allowed) {
      await e.reply(withButtons(e, formatCooldownMessage(cd.remaining_seconds), ROAST_BUTTONS), quoteFlag());
      return true;
    }
    const intro = T.pickFormat(T.RANDOM_ROAST_INTRO_TEXTS, { target: targetName }) + '\n';
    let outcome;
    try {
      outcome = await buildMemberRoastOutcome({
        attackerPig,
        targetPig,
        attackerName,
        targetName,
        introText: intro,
      });
    } catch (err) {
      await e.reply(String(err.message || err), quoteFlag());
      return true;
    }
    await finishRoastOutcome(e, outcome, {
      attackerId,
      attackerName,
      targetId,
      targetName,
      groupId,
      dailyFeedEligible: true,
    });
    return true;
  }

  // ================= 烤箱续火（简化版：管理员/主人直接补货） =================
  async refill(e) {
    if (!e.group_id) {
      await e.reply('烤箱续火只能在群里发起。', quoteFlag());
      return true;
    }
    const groupId = String(e.group_id);
    const initiatorId = String(e.user_id);
    const activeUsers = store.getGroupActiveUserIds(groupId);
    if (!activeUsers.has(initiatorId)) {
      await e.reply(T.pick(T.ROAST_REFILL_INACTIVE_INITIATOR_TEXTS), quoteFlag());
      return true;
    }
    const prep = store.prepareGroupRoastRefill({
      groupId,
      initiatorId,
      initiatorName: getEventUserName(e),
      deliveryBotId: String(e.self_id),
    });
    if (prep.status === 'insufficient_active') {
      await e.reply(
        withButtons(e, T.pick(T.ROAST_REFILL_INSUFFICIENT_ACTIVE_TEXTS), ROAST_REFILL_GUIDE_BUTTONS),
        quoteFlag()
      );
      return true;
    }
    if (prep.status === 'existing') {
      await e.reply('本群已有一场补货投票在进行中，请稍后。', quoteFlag());
      return true;
    }
    // 简化：由群管理员/主人一键确认补货（不做表情回应投票）
    const isManager = e.isMaster || ['owner', 'admin'].includes(e.sender?.role || '');
    if (!isManager) {
      await e.reply(
        `🔥【烤箱续火申请】已登记。\n当前实现为简化版：需要群主/管理员/主人发送「烤箱续火」确认放行。\n` +
          `今日活跃小猪 ${prep.active_user_ids?.length || 0} 头。`,
        quoteFlag()
      );
      return true;
    }
    const result = store.completeGroupRoastRefill({
      requestId: prep.request.request_id,
      voterIds: [initiatorId],
      maxCharges: resolveRoastChargeMax(),
    });
    if (result.completed) {
      await e.reply(
        withButtons(
          e,
          T.pickFormat(T.ROAST_REFILL_SUCCESS_TEXTS, {
            votes: 1,
            benefited: result.benefited_user_ids.length,
            max_charges: resolveRoastChargeMax(),
            success_count: 1,
          }),
          ROAST_BUTTONS
        ),
        quoteFlag()
      );
    } else {
      await e.reply(withButtons(e, '补货未能完成，请稍后再试。', ROAST_BUTTONS), quoteFlag());
    }
    return true;
  }
}
