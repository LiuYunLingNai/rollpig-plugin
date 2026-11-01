import { getContext } from '../../host/index.js';
import configControl from '../model/config.js';
import resourceManager from '../resource/resourceManager.js';
import * as T from '../model/texts.js';

export function isSuperUser(userId) {
  return getContext().app.policy.isMaster(String(userId));
}

export function isEventMaster(e) {
  return Boolean(e.isMaster);
}

export function getEventGroupId(e) {
  return e.group?.gid != null ? String(e.group.gid) : '';
}

export function getEventUserName(e) {
  return e.sender.card || e.sender.name || String(e.sender.uid);
}

export function isGroupManager(e) {
  return e.isMaster || e.isGroupAdmin || e.isGroupOwner;
}

/** 回复优先，其次 @；只有确认群成员身份后才允许烤群友。 */
export async function resolveRoastTarget(e) {
  let targetId = e.quote?.sender?.uid;
  if (!targetId && e.quote && e.bot.getMessage) {
    const message = await e.bot.getMessage(e.quote.messageId).catch(() => undefined);
    if (message?.group?.gid === e.group?.gid) targetId = message.sender.uid;
  }
  targetId ??= e.atUsers.find(uid => uid !== e.selfId) ?? (e.atMe ? e.selfId : undefined);
  let targetName = '对方';
  let isGroupMember = false;
  if (targetId && targetId !== e.selfId && e.group) {
    const member = await e.bot.getGroupMember(String(e.group.gid), String(targetId)).catch(() => undefined);
    if (member) {
      targetName = member.card || member.name || String(targetId);
      isGroupMember = true;
    }
  }
  return { targetId: targetId ? String(targetId) : null, targetName, isGroupMember };
}

export async function getGroupMemberDisplayName(e, userId, fallback = '群友') {
  const info = e.group && await e.bot.getGroupMember(String(e.group.gid), String(userId)).catch(() => undefined);
  return info?.card || info?.name || fallback;
}

/** 平台无法列出群成员时，只检查本群今日显形过的用户，不使用跨群全局抽猪列表。 */
export async function getGroupRollCandidates(e, store, excludeIds) {
  const ids = Object.keys(store.getGroupRolls(String(e.group.gid))).filter(uid => !excludeIds.has(uid));
  const members = await e.bot.getGroupMemberList(String(e.group.gid)).catch(() => []);
  if (members.length) {
    const memberIds = new Set(members.map(member => String(member.uid)));
    return ids.filter(uid => memberIds.has(uid));
  }
  const confirmed = await Promise.all(ids.map(async uid =>
    await e.bot.getGroupMember(String(e.group.gid), uid).catch(() => undefined) ? uid : null));
  return confirmed.filter(Boolean);
}

export function buildDailyFeedRoastText(feed) {
  if (!feed || feed.status !== 'fed' || feed.new_level <= feed.previous_level) return '';
  const pig = resourceManager.getPigById(feed.pig_id);
  return T.pickFormat(T.DAILY_FEED_ROAST_TEXTS, {
    pig: pig ? pig.name || feed.pig_id : feed.pig_id,
    old_level: feed.previous_level,
    new_level: feed.new_level,
  });
}

export function getConfig() {
  return configControl.get();
}
