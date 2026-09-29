import schedule from 'node-schedule';
import store from '../store/store.js';
import { rollpigDateStr } from '../model/runtime.js';
import {
  buildDailyReport,
  buildDailyReportCardData,
  buildDailyUserProfiles,
  selectDailyProtectedUserIds,
  isGroupReportEnabled,
} from './dailyReport.js';
import { renderDailyReportImage } from '../render/render.js';
import { buildButtons, isQQBotBot, DAILY_REPORT_BUTTONS } from './qqbot.js';

const CUTOFF_TIME = '23:45';
const PROTECTION_SCOPE = '本群免烤一天';

let scheduledJob = null;

/** 计算业务日 23:45 对应的真实 UTC ISO 截止点。 */
function cutoffIso(dateStr) {
  const iso = new Date(`${dateStr}T23:45:00+08:00`);
  return Number.isNaN(iso.getTime()) ? '' : iso.toISOString();
}

/** 保护券有效期：次日 23:59（业务时区）。 */
function protectionExpiresAt(protectDate) {
  const d = new Date(`${protectDate}T23:59:00+08:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 找一个在目标群里的 Bot。 */
function resolveGroupBot(groupId) {
  const gid = String(groupId);
  try {
    const bots = global.Bot?.bots || {};
    for (const uin of Object.keys(bots)) {
      const bot = bots[uin];
      if (bot?.gl?.has?.(Number(gid)) || bot?.gl?.has?.(gid)) return bot;
    }
  } catch {
    /* ignore */
  }
  // 兜底：默认 Bot
  try {
    if (global.Bot?.pickGroup) return global.Bot;
  } catch {
    /* ignore */
  }
  return null;
}

/** 尽力读取群成员昵称，用于排行/头条显示名。失败时返回空。 */
async function loadGroupMemberNames(bot, groupId) {
  const names = {};
  try {
    const group = bot.pickGroup(Number(groupId));
    const memberMap = await group.getMemberMap?.();
    if (memberMap) {
      for (const [uid, info] of memberMap) {
        const name = String(info?.card || info?.nickname || '').trim();
        if (name) names[String(uid)] = name;
      }
    }
  } catch (err) {
    logger?.debug?.(`[今日小猪] 群成员昵称读取失败 group=${groupId}: ${err}`);
  }
  return names;
}

/**
 * 为单个群构建日报卡片图片消息段。
 * @param {string} groupId
 * @param {object} opts { dateStr, bot, writeProtection }
 *   - writeProtection=true 时写入次日保护名单并在卡片上承诺（定时任务用）。
 *   - writeProtection=false 时仅生成卡片，不产生任何副作用（手动预览用）。
 * @returns {Promise<{status:'ok'|'empty', seg?:object}>}
 */
export async function buildGroupReportSegment(
  groupId,
  { dateStr = null, bot = null, writeProtection = false } = {}
) {
  const reportDate = dateStr || rollpigDateStr();
  const protectDate = rollpigDateStr(1);
  const cutoffAt = cutoffIso(reportDate);
  const targetBot = bot || resolveGroupBot(groupId);

  const groupRolls = store.getGroupRolls(groupId, reportDate);
  const rawEvents = store.getDailyEvents({ dateStr: reportDate, groupId });
  const activeUserIds = [...store.getGroupActiveUserIds(groupId, reportDate)];
  const botUserIds = Object.keys(global.Bot?.bots || {});

  const memberNames = targetBot ? await loadGroupMemberNames(targetBot, groupId) : {};

  // 初步日报用于确定参与者，再补齐资料后二次构建
  const preliminary = buildDailyReport({
    dateStr: reportDate,
    groupId,
    groupRolls,
    rawEvents,
    activeUserIds,
    botUserIds,
    cutoffAt,
  });
  if (!preliminary.has_activity) return { status: 'empty' };

  const profiles = buildDailyUserProfiles(preliminary.participant_ids, groupRolls, memberNames);

  const protectedIds = selectDailyProtectedUserIds(preliminary.events);
  if (writeProtection) {
    // 次日保护结算（写入存储，随后在卡片上承诺）
    store.replaceGroupProtections(groupId, protectedIds, protectDate);
  }
  const expiresAt = protectionExpiresAt(protectDate);
  const protections = protectedIds.map((userId) => ({
    user_id: userId,
    display_name: profiles[userId]?.display_name || memberNames[userId] || '',
    scope: PROTECTION_SCOPE,
    expires_at: expiresAt,
  }));

  const report = buildDailyReport({
    dateStr: reportDate,
    groupId,
    groupRolls,
    rawEvents,
    activeUserIds,
    botUserIds,
    userProfiles: profiles,
    protections,
    cutoffAt,
  });
  const cardData = buildDailyReportCardData(report, { cutoffTime: CUTOFF_TIME });
  const seg = await renderDailyReportImage(cardData);
  if (!seg) throw new Error('日报渲染返回空');
  return { status: 'ok', seg };
}

/**
 * 为单个群构建并推送日报，同时写入次日保护。
 * @returns {Promise<'sent'|'empty'|'skip'|'error'>}
 */
async function deliverGroupReport(groupId, { dateStr, cutoffAt }) {
  const bot = resolveGroupBot(groupId);
  if (!bot) {
    logger?.warn?.(`[今日小猪] 没有可用 Bot 推送日报 group=${groupId}`);
    return 'skip';
  }
  try {
    const { status, seg } = await buildGroupReportSegment(groupId, {
      dateStr,
      bot,
      writeProtection: true,
    });
    if (status === 'empty') return 'empty';
    // QQBot 官方端追加按钮，其它端保持纯图片
    let msg = seg;
    if (isQQBotBot(bot)) {
      const btnSeg = buildButtons(DAILY_REPORT_BUTTONS);
      if (btnSeg) msg = [seg, btnSeg];
    }
    await bot.pickGroup(Number(groupId)).sendMsg(msg);
    return 'sent';
  } catch (err) {
    logger?.error?.(`[今日小猪] 日报推送失败 group=${groupId}: ${err}`);
    return 'error';
  }
}

/**
 * 执行日报任务：遍历今日活跃群，结算次日保护并向开启日报的群推送。
 * @param {object} opts { dateStr }
 */
export async function runDailyReportJob({ dateStr = null } = {}) {
  const reportDate = dateStr || rollpigDateStr();
  const protectDate = rollpigDateStr(1);
  const cutoffAt = cutoffIso(reportDate);

  const activeGroups = [...store.getActiveGroupIds(reportDate)].sort();
  if (!activeGroups.length) {
    logger?.info?.('[今日小猪] 今日无活跃群，跳过日报');
    return;
  }

  let sent = 0;
  let settled = 0;
  for (const groupId of activeGroups) {
    try {
      if (isGroupReportEnabled(groupId)) {
        const result = await deliverGroupReport(groupId, { dateStr: reportDate, cutoffAt });
        if (result === 'sent') sent += 1;
        // deliverGroupReport 内部已写入保护
        if (result !== 'skip') settled += 1;
      } else {
        // 未开启日报的群仍需结算次日保护
        const rawEvents = store.getDailyEvents({ dateStr: reportDate, groupId });
        const report = buildDailyReport({
          dateStr: reportDate,
          groupId,
          groupRolls: store.getGroupRolls(groupId, reportDate),
          rawEvents,
          botUserIds: Object.keys(global.Bot?.bots || {}),
          cutoffAt,
        });
        const protectedIds = selectDailyProtectedUserIds(report.events);
        store.replaceGroupProtections(groupId, protectedIds, protectDate);
        settled += 1;
      }
    } catch (err) {
      logger?.error?.(`[今日小猪] 处理群日报异常 group=${groupId}: ${err}`);
    }
  }
  logger?.info?.(
    `[今日小猪] 日报完成：推送 ${sent} 群，保护结算 ${settled}/${activeGroups.length} 群`
  );
}

/** 注册每晚 23:45（Asia/Shanghai）的日报定时任务。 */
export function registerDailyReportSchedule() {
  if (scheduledJob) return scheduledJob;
  const rule = new schedule.RecurrenceRule();
  rule.tz = 'Asia/Shanghai';
  rule.hour = 23;
  rule.minute = 45;
  rule.second = 0;
  scheduledJob = schedule.scheduleJob(rule, () => {
    runDailyReportJob().catch((err) => logger?.error?.(`[今日小猪] 日报任务异常: ${err}`));
  });
  logger?.info?.('[今日小猪] 猪圈日报定时任务已注册（每晚 23:45）');
  return scheduledJob;
}
