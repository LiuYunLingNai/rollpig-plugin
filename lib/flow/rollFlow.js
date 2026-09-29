import store from '../store/store.js';
import resourceManager from '../resource/resourceManager.js';
import * as T from '../model/texts.js';
import { MAX_EXPERT_LEVEL, expertLevelFromCopies } from '../model/models.js';

const DUPLICATE_PITY_WEIGHT_STEP = 0.5;
const DUPLICATE_PITY_WEIGHT_CAP = 4.0;

export const RECORDED_PIG_RESOURCE_MISSING_TEXT =
  '你的今日小猪已经抽出来了，但当前 Bot 的小猪资源暂时缺失，请稍后再试。';

/**
 * 按用户当前图鉴状态选择今日候选猪；连续重复越多，新猪权重越高。
 */
function pickDailyRollCandidate(userId) {
  const pigList = resourceManager.pigList;
  const drawState = store.getDrawState(userId);
  const ownedPigIds = new Set(drawState.pig_ids);
  const duplicateStreak = Math.max(0, Math.trunc(drawState.duplicate_streak || 0));
  const newPigBonus = Math.min(duplicateStreak * DUPLICATE_PITY_WEIGHT_STEP, DUPLICATE_PITY_WEIGHT_CAP);

  const weights = [];
  let totalWeight = 0;
  for (const pig of pigList) {
    const pigId = String(pig.id || '');
    const isUnowned = pigId && !ownedPigIds.has(pigId);
    const w = isUnowned ? 1.0 + newPigBonus : 1.0;
    weights.push(w);
    totalWeight += w;
  }
  let r = Math.random() * totalWeight;
  for (let i = 0; i < pigList.length; i++) {
    r -= weights[i];
    if (r <= 0) return pigList[i];
  }
  return pigList[pigList.length - 1];
}

/**
 * 补抽缺失的昨日记录。返回是否新建。
 */
export function ensureYesterdayPig(userId, dateStr) {
  if (store.getDailyRoll(userId, dateStr)) return false;
  if (!resourceManager.pigList.length) throw new Error('小猪资源暂时不可用，无法补签');
  const candidate = pickDailyRollCandidate(userId);
  const result = store.getOrCreateDailyRoll(userId, candidate.id, { dateStr, makeup: true });
  return result.created;
}

/**
 * 生成今日首次抽猪后的成长提示。
 */
export function buildRollGrowthText(result, pigData) {
  if (!result.created) return '';
  const pigName = pigData.name || '未知小猪';
  const currentLevel =
    result.expert_level != null ? result.expert_level : expertLevelFromCopies(result.copies);

  if (result.is_new_pig) {
    return T.pickFormat(T.DAILY_ROLL_NEW_PIG_TEXTS, { pig: pigName, level: currentLevel });
  }

  const previousLevel =
    result.previous_expert_level != null
      ? result.previous_expert_level
      : expertLevelFromCopies(result.previous_copies);

  if (previousLevel === currentLevel) {
    return T.pickFormat(T.DAILY_ROLL_DUPLICATE_SAME_LEVEL_TEXTS, { pig: pigName, level: currentLevel });
  }

  // 差分解锁提示
  const unlockedLevels = resourceManager.newlyUnlockedVariantLevels(
    String(pigData.id || ''),
    previousLevel,
    currentLevel
  );
  const preciseFields = new Set();
  for (const level of unlockedLevels) {
    for (const f of resourceManager.variantSnapshotFields(String(pigData.id || ''), level)) {
      preciseFields.add(f);
    }
  }
  if (unlockedLevels.length) {
    const changed = new Set();
    if (preciseFields.has('image')) changed.add('image');
    if (preciseFields.has('description') || preciseFields.has('analysis')) changed.add('text');
    let poolKey = null;
    if (changed.has('image') && changed.has('text')) poolKey = 'image_text';
    else if (changed.has('image')) poolKey = 'image';
    else if (changed.has('text')) poolKey = 'text';
    if (poolKey && T.DAILY_ROLL_VARIANT_LEVEL_UP_TEXTS[poolKey]) {
      return T.pickFormat(T.DAILY_ROLL_VARIANT_LEVEL_UP_TEXTS[poolKey], {
        pig: pigName,
        old_level: previousLevel,
        new_level: currentLevel,
      });
    }
  }

  return T.pickFormat(T.DAILY_ROLL_DUPLICATE_LEVEL_UP_TEXTS, {
    pig: pigName,
    old_level: previousLevel,
    new_level: currentLevel,
  });
}

function currentDailyCardExpertLevel(result) {
  let level = result.expert_level != null ? result.expert_level : expertLevelFromCopies(result.copies);
  const feed = result.snapshot?.daily_feed_result;
  if (feed && feed.status === 'fed' && feed.pig_id === result.pig_id) {
    level = Math.max(level, Math.trunc(feed.new_level));
  }
  return Math.min(Math.max(level, 0), MAX_EXPERT_LEVEL);
}

/**
 * 取得用户今日形态；没有记录时自动抽取并更新图鉴进度。
 * 返回 { pig, roll_result, growth_text, missing_resources, recorded_pig_missing, ex_level, was_auto_created }
 */
export function resolveDailyPig(userId, groupId = '', { includeProgress = false } = {}) {
  const pigId = store.getDailyRoll(userId);
  const currentPig = pigId ? resourceManager.getPigById(pigId) : null;

  if (currentPig) {
    if (groupId) store.markGroupRollSeen(userId, currentPig.id, groupId);
    let exLevel = null;
    if (includeProgress) {
      const drawState = store.getDrawState(userId);
      exLevel = drawState.expertLevelOf(currentPig.id);
    }
    return {
      pig: currentPig,
      roll_result: null,
      growth_text: '',
      missing_resources: false,
      recorded_pig_missing: false,
      ex_level: exLevel,
      was_auto_created: false,
    };
  }

  if (pigId) {
    // 已保存 ID 但资源缺失
    logger?.warn?.(`[今日小猪] 今日形态资源缺失: user=${userId} pig_id=${pigId}`);
    return {
      pig: null,
      missing_resources: true,
      recorded_pig_missing: true,
      was_auto_created: false,
    };
  }

  if (!resourceManager.pigList.length) {
    return { pig: null, missing_resources: true, recorded_pig_missing: false, was_auto_created: false };
  }

  const proposed = pickDailyRollCandidate(userId);
  const rollResult = store.getOrCreateDailyRoll(userId, proposed.id, { groupId });
  const pig = resourceManager.getPigById(rollResult.pig_id);
  if (!pig) {
    return { pig: null, missing_resources: true, recorded_pig_missing: true, was_auto_created: false };
  }
  return {
    pig,
    roll_result: rollResult,
    growth_text: includeProgress ? buildRollGrowthText(rollResult, pig) : '',
    missing_resources: false,
    recorded_pig_missing: false,
    ex_level: includeProgress ? currentDailyCardExpertLevel(rollResult) : null,
    was_auto_created: !!rollResult.created,
  };
}

/**
 * 生成文本版猪圈摘要。
 */
export function buildPigstyGrowthSummary(userName, drawState, totalPigs) {
  const userCount = drawState.pig_ids.length;
  const percent = totalPigs > 0 ? Math.trunc((userCount / totalPigs) * 100) : 0;

  const rankedProgress = Object.entries(drawState.progress).sort((a, b) => {
    if (b[1].copies !== a[1].copies) return b[1].copies - a[1].copies;
    const fa = a[1].first_obtained_at || '';
    const fb = b[1].first_obtained_at || '';
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a[0] < b[0] ? -1 : 1;
  });

  let favoriteLine = '🐷 本命猪：暂无';
  let topRepeatLine = '⭐ 高等级小猪：暂无重复猪，猪圈还很清新';
  let maxLevel = 0;
  let maxedCount = 0;

  if (rankedProgress.length) {
    const levels = rankedProgress.map(([, p]) => p.expert_level);
    maxLevel = Math.max(...levels);
    maxedCount = levels.filter((l) => l >= MAX_EXPERT_LEVEL).length;

    const [favoriteId, favoriteProgress] = rankedProgress[0];
    const favorite = resourceManager.getPigById(favoriteId);
    const favoriteName = favorite ? favorite.name || favoriteId : favoriteId;
    favoriteLine = `🐷 本命猪：【${favoriteName}】EX Lv.${favoriteProgress.expert_level}（累计 ${favoriteProgress.copies} 次）`;

    const repeatItems = rankedProgress
      .filter(([, p]) => p.expert_level >= 1)
      .sort((a, b) => {
        if (b[1].expert_level !== a[1].expert_level) return b[1].expert_level - a[1].expert_level;
        if (b[1].copies !== a[1].copies) return b[1].copies - a[1].copies;
        return 0;
      })
      .slice(0, 5);
    if (repeatItems.length) {
      const parts = repeatItems.map(([pigId, p]) => {
        const pig = resourceManager.getPigById(pigId);
        const name = pig ? pig.name || pigId : pigId;
        return `【${name}】EX Lv.${p.expert_level}`;
      });
      topRepeatLine = '⭐ 高等级小猪：' + parts.join('、');
    }
  }

  const streakLine =
    drawState.duplicate_streak > 0
      ? `🔥 连续重复：${drawState.duplicate_streak} 次（新猪气息正在靠近）`
      : '🔥 连续重复：0 次（下一只从平常心开始）';

  const footerLine =
    userCount <= 0 ? '发送「今日小猪」开始收集。' : '发送「小猪图鉴」查看图片版完整图鉴。';

  return (
    `【我的猪圈统计】\n` +
    `👑 猪圈主人：${userName}\n` +
    `📦 已收集：${userCount} / ${totalPigs} 只\n` +
    `📈 收藏率：${percent}%\n` +
    `🏅 最高等级：EX Lv. ${maxLevel}｜满级 ${maxedCount} 只\n` +
    `${favoriteLine}\n` +
    `${topRepeatLine}\n` +
    `${streakLine}\n` +
    `━━━━━━━━━━━━━━\n` +
    `${footerLine}\n` +
    '💡 有新的小猪创意？发送「小猪投稿」把它送进猪圈。'
  );
}
