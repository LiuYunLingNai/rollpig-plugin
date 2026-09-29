// 业务领域常量与纯函数，对应原 store/models.py 的核心部分。

export const MAX_EXPERT_LEVEL = 5;

// 烤箱续火（补货）门槛：第四次起固定 55%，每档设有票数上限。
export const ROAST_REFILL_THRESHOLD_STEPS = [
  [25, 8],
  [35, 12],
  [45, 16],
  [55, 20],
];
export const ROAST_REFILL_MIN_DISTINCT_VOTERS = 2;

/**
 * 根据真实抽取次数与加餐成长计算 EX Lv.，统一钳制到 0~5。
 */
export function expertLevelFromCopies(copies, growthBonus = 0) {
  const value = Math.trunc(Number(copies) || 0) - 1 + Math.trunc(Number(growthBonus) || 0);
  return Math.min(Math.max(value, 0), MAX_EXPERT_LEVEL);
}

/**
 * 返回本轮比例与所需票数。
 */
export function roastRefillThreshold(activeCount, successCount) {
  const normalizedActive = Math.max(0, Math.trunc(Number(activeCount) || 0));
  const normalizedSuccess = Math.max(0, Math.trunc(Number(successCount) || 0));
  const idx = Math.min(normalizedSuccess, ROAST_REFILL_THRESHOLD_STEPS.length - 1);
  const [ratio, voteCap] = ROAST_REFILL_THRESHOLD_STEPS[idx];
  const proportionalVotes = Math.floor((normalizedActive * ratio + 99) / 100);
  const requiredVotes = Math.max(2, Math.min(proportionalVotes, voteCap));
  return { ratio, requiredVotes };
}

export function safeInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clampInt(value, def, min, max) {
  const n = safeInt(value, def);
  return Math.max(min, Math.min(max, n));
}
