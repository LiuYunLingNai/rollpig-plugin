import configControl from './config.js';

// 业务时区统一使用 Asia/Shanghai，避免服务器部署在 UTC 时跨日漂移。
// 通过手动 +8 偏移计算业务日期，不依赖系统时区。
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 返回业务时区（UTC+8）下的“当前时间”对应的 Date（其 UTC 字段即为本地字段）。
 */
export function rollpigNow() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS);
}

/**
 * 返回业务日期字符串 YYYY-MM-DD；offsetDays 用于昨日/明日等相对日期。
 */
export function rollpigDateStr(offsetDays = 0) {
  const now = rollpigNow();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 返回业务日期对象（仅含 YYYY/MM/DD 语义的 Date，UTC 字段即业务字段）。
 */
export function rollpigToday() {
  const now = rollpigNow();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * 解析普通烤群友 CD（秒），支持通过配置覆盖；非法值回退 8 小时。
 */
export function resolveRoastCooldownSeconds() {
  let hours = Number(configControl.get().roast_cooldown_hours);
  if (!Number.isFinite(hours) || hours <= 0) hours = 8;
  return Math.max(60, Math.floor(hours * 3600));
}

/**
 * 解析普通烤群友充能上限；限制在 1~6。
 */
export function resolveRoastChargeMax() {
  let max = parseInt(configControl.get().roast_charge_max, 10);
  if (!Number.isFinite(max) || max <= 0) max = 2;
  return Math.max(1, Math.min(6, max));
}

/**
 * 当前 UTC ISO 时间戳，用于记录事件时间。
 */
export function nowIso() {
  return new Date().toISOString();
}
