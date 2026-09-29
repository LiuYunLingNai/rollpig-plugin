import configControl from '../model/config.js';
import resourceManager from '../resource/resourceManager.js';
import * as T from '../model/texts.js';

// ================================ 事件身份工具 ================================ //

/**
 * 是否为主人（超级用户）。Yunzai 使用 e.isMaster 判定。
 */
export function isSuperUser(userId) {
  // Yunzai 全局 cfg.masterQQ
  try {
    const masterList = Array.isArray(cfg?.masterQQ) ? cfg.masterQQ.map(String) : [];
    return masterList.includes(String(userId));
  } catch {
    return false;
  }
}

export function isEventMaster(e) {
  if (e?.isMaster) return true;
  return isSuperUser(e?.user_id);
}

export function getEventGroupId(e) {
  return e?.group_id ? String(e.group_id) : '';
}

export function getEventUserName(e) {
  const sender = e?.sender || {};
  return sender.card || sender.nickname || String(e?.user_id || '');
}

/**
 * 是否为群管理员/群主/主人。
 */
export function isGroupManager(e) {
  if (isEventMaster(e)) return true;
  if (!e?.group_id) return false;
  const role = e?.sender?.role || '';
  return role === 'owner' || role === 'admin';
}

/**
 * 解析烤群友目标：优先回复，其次 @，再其次 @Bot（to_me）。
 * 返回 { targetId, targetName, isGroupMember }。
 */
export async function resolveRoastTarget(e) {
  let targetId = null;
  let targetName = '群友';
  let isGroupMember = false;

  // 回复消息
  const sourceReply = e.source || e.reply_id;
  if (sourceReply) {
    try {
      let replyUserId = null;
      if (e.getReply) {
        const replyMsg = await e.getReply();
        replyUserId = replyMsg?.user_id || replyMsg?.sender?.user_id;
      }
      if (!replyUserId && e.source?.user_id) replyUserId = e.source.user_id;
      if (replyUserId) {
        targetId = String(replyUserId);
        targetName = '对方';
      }
    } catch {
      /* ignore */
    }
  }

  // @ 目标
  if (!targetId && Array.isArray(e.message)) {
    for (const seg of e.message) {
      if (seg.type === 'at' && seg.qq && String(seg.qq) !== String(e.self_id)) {
        targetId = String(seg.qq);
        targetName = '对方';
        break;
      }
    }
  }

  // @Bot
  if (!targetId && Array.isArray(e.message)) {
    for (const seg of e.message) {
      if (seg.type === 'at' && String(seg.qq) === String(e.self_id)) {
        targetId = String(e.self_id);
        break;
      }
    }
  }

  if (targetId && targetId !== String(e.self_id) && e.group) {
    try {
      const member = e.group.pickMember(Number(targetId));
      const info = member?.info || (member?.getInfo ? await member.getInfo() : null);
      if (info) {
        targetName = info.card || info.nickname || targetName;
        isGroupMember = true;
      }
    } catch {
      /* ignore */
    }
  }

  return { targetId, targetName, isGroupMember };
}

export async function getGroupMemberDisplayName(e, userId, def = '群友') {
  try {
    const member = e.group?.pickMember(Number(userId));
    const info = member?.info || (member?.getInfo ? await member.getInfo() : null);
    return info?.card || info?.nickname || def;
  } catch {
    return def;
  }
}

/**
 * 取当前群内今日已抽猪、且仍是群成员、排除指定 id 的候选。
 */
export async function getGroupRollCandidates(e, store, excludeIds) {
  const today = store.getDailyRolls();
  const todayIds = Object.keys(today);
  let memberIds = null;
  try {
    const map = await e.group.getMemberMap();
    if (map && map.size) memberIds = new Set([...map.keys()].map(String));
  } catch {
    memberIds = null;
  }
  return todayIds.filter((uid) => {
    if (excludeIds.has(uid)) return false;
    if (memberIds && !memberIds.has(String(uid))) return false;
    return true;
  });
}

/**
 * 仅为真实成长追加一行加餐结果文案。
 */
export function buildDailyFeedRoastText(feed) {
  if (!feed || feed.status !== 'fed' || feed.new_level <= feed.previous_level) return '';
  const pig = resourceManager.getPigById(feed.pig_id);
  const pigName = pig ? pig.name || feed.pig_id : feed.pig_id;
  return T.pickFormat(T.DAILY_FEED_ROAST_TEXTS, {
    pig: pigName || '未知小猪',
    old_level: feed.previous_level,
    new_level: feed.new_level,
  });
}

export function getConfig() {
  return configControl.get();
}
