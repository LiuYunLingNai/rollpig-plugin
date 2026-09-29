import resourceManager from '../resource/resourceManager.js';
import { getRoastText } from './roastManager.js';
import * as T from '../model/texts.js';
import { isSuperUser } from './helpers.js';

// ================================ 烤猪形态规则 ================================ //
// “哪些猪能被烤/不能被烤”的基础判定，合并内置常量与 pig_rules.json。

export function getFoodPigIds() {
  return [...new Set([...T.FOOD_PIG_IDS, ...resourceManager.foodPigIds])];
}
export function getHumanPigIds() {
  return [...new Set([T.HUMAN_PIG_ID, ...resourceManager.humanPigIds])];
}
export function getEatenPigIds() {
  return [...new Set([T.EATEN_PIG_ID, ...resourceManager.eatenPigIds])];
}
export function getSoldPigIds() {
  return [...new Set([T.SOLD_PIG_ID, ...resourceManager.soldPigIds])];
}

export function isFoodPig(pig) {
  return !!(pig && getFoodPigIds().includes(pig.id));
}
export function isHumanPig(pig) {
  return !!(pig && getHumanPigIds().includes(pig.id));
}
export function isEatenPig(pig) {
  return !!(pig && getEatenPigIds().includes(pig.id));
}
export function isSoldPig(pig) {
  return !!(pig && getSoldPigIds().includes(pig.id));
}

export function canBackfireRoast(attackerPig) {
  return !!(
    attackerPig &&
    !isFoodPig(attackerPig) &&
    !isHumanPig(attackerPig) &&
    !isEatenPig(attackerPig) &&
    !isSoldPig(attackerPig)
  );
}

export class RoastFoodMissingError extends Error {}

export function pickFoodPig() {
  const foodIds = getFoodPigIds();
  if (!foodIds.length) throw new RoastFoodMissingError('熟食规则为空，请检查 pig_rules.json。');
  const foodId = foodIds[Math.floor(Math.random() * foodIds.length)];
  const foodPig = resourceManager.getPigById(foodId);
  if (!foodPig) throw new RoastFoodMissingError('食材配置缺失，请检查 pig.json。');
  return foodPig;
}

// ================================ 后门口令 ================================ //

export function detectForceRoastMode(rawText, userId) {
  const normalized = String(rawText || '')
    .replace(/\//g, '')
    .replace(/ /g, '')
    .replace(/\u3000/g, '');
  const hasSuper = normalized.includes(T.SUPER_FORCE_ROAST_KEYWORD);
  const hasForce = T.FORCE_ROAST_KEYWORDS.some((k) => normalized.includes(k));
  if (hasSuper) return isSuperUser(userId) ? 'super' : 'super_denied';
  if (hasForce) return 'normal';
  return null;
}

// ================================ 文案拼接 ================================ //

function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickBackfireText(attackerName, targetName, attackerPig) {
  let pool;
  let shape;
  if (!attackerPig) {
    pool = T.BACKFIRE_NO_PIG_TEXTS;
    shape = '未抽形态';
  } else if (isHumanPig(attackerPig)) {
    pool = T.BACKFIRE_HUMAN_TEXTS;
    shape = '人类';
  } else if (isEatenPig(attackerPig)) {
    pool = T.BACKFIRE_EATEN_TEXTS;
    shape = '吃掉了';
  } else if (isSoldPig(attackerPig)) {
    pool = T.BACKFIRE_SOLD_TEXTS;
    shape = '卖掉了';
  } else if (isFoodPig(attackerPig)) {
    pool = T.BACKFIRE_FOOD_TEXTS;
    shape = attackerPig.name || '熟食';
  } else {
    pool = T.BACKFIRE_GENERIC_TEXTS;
    shape = attackerPig.name || '未知形态';
  }
  return T.formatText(pick(pool), { attacker: attackerName, target: targetName, shape });
}

export function clarifyBackfireRoastText(roastText, attackerName) {
  const text = (roastText || '').trim();
  if (!text) return text;
  if (attackerName && text.includes(attackerName)) return text;
  const label = `【${attackerName || '对方'}】`;
  const replacements = [
    ['曾经你', `曾经${label}`],
    ['如今你', `如今${label}`],
    ['生前你', `生前${label}`],
    ['原本你', `原本${label}`],
    ['原来你', `原来${label}`],
    ['你本是一只', `${label}本是一只`],
    ['你本是', `${label}本是`],
    ['你曾经是', `${label}曾经是`],
    ['你曾是', `${label}曾是`],
    ['你虽然', `${label}虽然`],
    ['你从', `${label}从`],
    ['看看你', `看看${label}`],
    ['可怜的你', `可怜的${label}`],
    ['没想到你', `没想到${label}`],
  ];
  for (const [oldText, newText] of replacements) {
    if (text.includes(oldText)) return text.replace(oldText, newText);
  }
  if (text.includes('你')) return text.replace('你', label);
  return `${label}原本想把别人送上烤架，结果最后被端上桌的却是自己。${text}`;
}

export function pickEscapeText(attackerName, targetName, targetPig) {
  const shape = targetPig ? targetPig.name || '未知形态' : '未知形态';
  return T.formatText(pick(T.ESCAPE_TEXTS), { attacker: attackerName, target: targetName, shape });
}

export function pickForcePrefixText(targetName, isSuperMode) {
  const pool = isSuperMode ? T.SUPER_FORCE_ROAST_PREFIX_TEXTS : T.FORCE_ROAST_PREFIX_TEXTS;
  return T.formatText(pick(pool), { target: targetName });
}

export function pickForceLimitText(operatorName, targetName) {
  return T.formatText(pick(T.FORCE_ROAST_LIMIT_TEXTS), { operator: operatorName, target: targetName });
}

export function formatCooldownMessage(remainingSeconds) {
  const remaining = Math.max(0, Math.trunc(remainingSeconds));
  let minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  const timeStr = hours > 0 ? `${hours}小时${minutes}分` : `${minutes}分${seconds}秒`;
  return `烧烤充能恢复中！还需要 ${timeStr} 恢复 1 次。\n等不及了？发送「烤箱续火」，喊群友一起添把火。`;
}

// ================================ 拦截文案 ================================ //

export function pickSelfRoastBlockText(pig) {
  if (isHumanPig(pig)) return pick(T.TODAY_ROAST_HUMAN_BLOCK_TEXTS);
  if (isEatenPig(pig)) return pick(T.TODAY_ROAST_EATEN_BLOCK_TEXTS);
  if (isSoldPig(pig)) return pick(T.TODAY_ROAST_SOLD_BLOCK_TEXTS);
  if (isFoodPig(pig)) {
    const shape = pig ? pig.name || '熟食' : '熟食';
    return T.formatText(pick(T.TODAY_ROAST_FOOD_BLOCK_TEXTS), { shape });
  }
  return null;
}

export function pickMemberTargetBlockText(targetName, targetPig) {
  if (isHumanPig(targetPig)) return T.formatText(pick(T.TARGET_HUMAN_BLOCK_TEXTS), { target: targetName });
  if (isEatenPig(targetPig)) return T.formatText(pick(T.TARGET_EATEN_BLOCK_TEXTS), { target: targetName });
  if (isSoldPig(targetPig)) return T.formatText(pick(T.TARGET_SOLD_BLOCK_TEXTS), { target: targetName });
  if (isFoodPig(targetPig)) {
    const shape = targetPig ? targetPig.name || '熟食' : '熟食';
    return T.formatText(pick(T.TARGET_FOOD_BLOCK_TEXTS), { target: targetName, shape });
  }
  return null;
}

export function pickRandomTargetBlockText(targetName, targetPig) {
  if (isHumanPig(targetPig))
    return `系统随机选中了【${targetName}】，但对方是人类形态，烤架拒绝处理。换一次试试？`;
  if (isEatenPig(targetPig)) return T.formatText(pick(T.TARGET_EATEN_BLOCK_TEXTS), { target: targetName });
  if (isSoldPig(targetPig)) return T.formatText(pick(T.TARGET_SOLD_BLOCK_TEXTS), { target: targetName });
  if (isFoodPig(targetPig)) {
    const shape = targetPig ? targetPig.name || '熟食' : '熟食';
    return `系统随机选中了【${targetName}】，但对方已经是【${shape}】了，别鞭尸了。`;
  }
  return null;
}

// ================================ 结果构造 ================================ //

export async function buildSelfRoastData(originalPig) {
  const foodPig = pickFoodPig();
  const roastText = await getRoastText(originalPig, foodPig);
  const roastedData = { ...foodPig, analysis: roastText };
  return { roastedData, foodName: foodPig.name };
}

export async function buildSuccessRoastOutcome(targetPig, { attackerName, targetName, extraText = '' }) {
  const foodPig = pickFoodPig();
  const text = await getRoastText(targetPig, foodPig, { operatorName: attackerName, targetName });
  const roastedData = { ...foodPig, analysis: text };
  return {
    event_type: 'success',
    render_data: roastedData,
    extra_text: extraText,
    food_name: foodPig.name,
    plain_text: '',
  };
}

export async function buildBackfireRoastOutcome(attackerPig, { attackerName, targetName, extraText = '' }) {
  const failIntro = pickBackfireText(attackerName, targetName, attackerPig);
  if (!canBackfireRoast(attackerPig)) {
    return { event_type: 'backfire', render_data: null, plain_text: extraText + failIntro, food_name: '' };
  }
  const foodPig = pickFoodPig();
  let text = await getRoastText(attackerPig, foodPig);
  text = clarifyBackfireRoastText(text, attackerName);
  const roastedData = { ...foodPig, analysis: failIntro + '\n\n' + text };
  return {
    event_type: 'backfire',
    render_data: roastedData,
    extra_text: extraText,
    food_name: foodPig.name,
    plain_text: '',
  };
}

/**
 * 执行烤群友核心判定：成功 60% / 逃脱 30% / 反噬 10%。
 */
export async function buildMemberRoastOutcome({
  attackerPig,
  targetPig,
  attackerName,
  targetName,
  forceMode = null,
  introText = '',
}) {
  if (forceMode === 'normal' || forceMode === 'super') {
    const prefixText = pickForcePrefixText(targetName, forceMode === 'super');
    return buildSuccessRoastOutcome(targetPig, { attackerName, targetName, extraText: prefixText });
  }
  const roll = Math.floor(Math.random() * 100) + 1;
  if (roll <= 60) {
    return buildSuccessRoastOutcome(targetPig, { attackerName, targetName, extraText: introText });
  }
  if (roll <= 90) {
    return {
      event_type: 'escape',
      render_data: null,
      plain_text: introText + pickEscapeText(attackerName, targetName, targetPig),
      food_name: '',
    };
  }
  return buildBackfireRoastOutcome(attackerPig, { attackerName, targetName, extraText: introText });
}

export function pickReservationPrepareText(result, { attackerName, targetName }) {
  const reservation = result.reservation;
  const count = reservation ? reservation.participant_count : 0;
  switch (result.status) {
    case 'reservation_closed':
      return '这场预约已经结束或过期，不能再加入了。';
    case 'attacker_unrolled':
      return '先发送「今日小猪」领一只猪，再来加入预约。';
    case 'self_target':
      return '这场预约烤的就是你，别往自己的烤架里添柴了。';
    case 'reservation_created':
      return T.formatText(pick(T.ROAST_RESERVATION_CREATED_TEXTS), { owner: attackerName, target: targetName });
    case 'reservation_joined':
      return T.formatText(pick(T.ROAST_RESERVATION_JOINED_TEXTS), {
        participant: attackerName,
        target: targetName,
        count,
      });
    case 'already_joined':
      return T.formatText(pick(T.ROAST_RESERVATION_DUPLICATE_TEXTS), { target: targetName, count });
    case 'reservation_full':
      return T.formatText(pick(T.ROAST_RESERVATION_FULL_TEXTS), { target: targetName, count });
    default:
      return '预约烤猪暂时没有响应，请稍后再试。';
  }
}
