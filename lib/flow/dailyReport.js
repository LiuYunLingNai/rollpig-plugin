import crypto from 'crypto';
import configControl from '../model/config.js';
import store from '../store/store.js';
import resourceManager, { getPigById } from '../resource/resourceManager.js';
import {
  DAILY_REPORT_OBSERVATION_TEXTS,
  DAILY_REPORT_HEADLINE_TEXTS,
  DAILY_REPORT_TIMELINE_INTRO_TEXTS,
  DAILY_REPORT_TIMELINE_DETAIL_TEXTS,
} from '../model/texts.js';

/**
 * 猪圈日报业务层，移植自原 daily_report.py + daily_report_card_renderer.py 的
 * 数据装配部分。只产出纯数据/文案，不做任何图片绘制（交给 render.js）。
 */

// ================================ 常量 ================================ //

const KNOWN_EVENT_TYPES = new Set([
  'success',
  'escape',
  'backfire',
  'bot_backfire',
  'self_roast',
  'reserved_special',
]);

const OBSERVATION_PRIORITY = [
  'reservation',
  'backfire',
  'escape',
  'success',
  'human',
  'collision',
  'variety',
];

const TIMELINE_PRIORITY = ['mutual', 'personal_turn', 'reservation_followup', 'repeat_target'];

const HEADLINE_BASE_SCORE = {
  normal_success: 20,
  normal_escape: 25,
  normal_backfire: 30,
  self_roast: 30,
  bot_backfire: 50,
  reservation_success: 50,
  reservation_escape: 55,
  reservation_backfire: 65,
  reservation_human: 60,
  reservation_food: 60,
  reservation_eaten: 60,
  reservation_sold: 60,
};

const RANKING_TITLES = {
  expert_level: '严选好猪',
  roast_success: '烧烤狂人',
  catalog: '养猪大户',
};

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 颜色（对应原版 INK / RED）
const INK = '#12100d';
const RED = '#8c1f13';

// ================================ 归一化工具 ================================ //

function text(value) {
  return String(value ?? '').trim();
}

function parseTimestamp(value) {
  const normalized = text(value);
  if (!normalized) return null;
  const ms = Date.parse(normalized.replace('Z', '+00:00'));
  return Number.isNaN(ms) ? null : ms;
}

/** ISO 时间排序键：有效时间在前，非法旧值排到最后。 */
function timestampKey(value) {
  const parsed = parseTimestamp(value);
  if (parsed === null) return [1, text(value)];
  return [0, parsed];
}

function compareKeyPair(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

function eventSortCompare(a, b) {
  const byTime = compareKeyPair(timestampKey(a.created_at), timestampKey(b.created_at));
  if (byTime !== 0) return byTime;
  return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
}

function isReservation(event) {
  return !!event.reservation_id;
}

function resultKind(event) {
  if (event.event_type === 'backfire' || event.event_type === 'bot_backfire') return 'backfire';
  if (event.event_type === 'reserved_special') return 'special';
  return event.event_type;
}

function normalizeGroupRolls(groupRolls) {
  const normalized = {};
  for (const [rawUserId, rawPigId] of Object.entries(groupRolls || {})) {
    const userId = text(rawUserId);
    const pigId = text(rawPigId);
    if (userId && pigId) normalized[userId] = pigId;
  }
  return normalized;
}

/** 清洗日报事件并隔离未知类型。 */
export function normalizeDailyEvents(rawEvents, { groupId = '', cutoffAt = '' } = {}) {
  const normalized = [];
  const expectedGroupId = text(groupId);
  const parsedCutoff = parseTimestamp(cutoffAt);
  const list = Array.isArray(rawEvents) ? rawEvents : [];
  list.forEach((raw, index) => {
    const eventType = text(raw.type);
    if (!KNOWN_EVENT_TYPES.has(eventType)) return;
    const eventGroupId = text(raw.group_id);
    if (expectedGroupId && eventGroupId && eventGroupId !== expectedGroupId) return;
    const participantIds = [];
    const rawIds = Array.isArray(raw.participant_ids) ? raw.participant_ids : [];
    const rawNames = Array.isArray(raw.participant_names) ? raw.participant_names : [];
    const participantNames = [];
    rawIds.forEach((rawUserId, i) => {
      const userId = text(rawUserId);
      if (!userId) return;
      participantIds.push(userId);
      participantNames.push(i < rawNames.length ? text(rawNames[i]) : '');
    });
    let rawParticipantCount = parseInt(raw.participant_count, 10);
    if (!Number.isFinite(rawParticipantCount) || rawParticipantCount < 0) rawParticipantCount = 0;
    const event = {
      event_id: text(raw.event_id) || `legacy:${String(index).padStart(6, '0')}`,
      event_type: eventType,
      attacker_id: text(raw.attacker),
      target_id: text(raw.target),
      attacker_name: text(raw.attacker_name),
      target_name: text(raw.target_name),
      food: text(raw.food),
      group_id: eventGroupId || expectedGroupId,
      reservation_id: text(raw.reservation_id),
      participant_ids: participantIds,
      participant_names: participantNames,
      participant_count: Math.max(rawParticipantCount, participantIds.length),
      backfire_victim_id: text(raw.backfire_victim_id),
      backfire_victim_name: text(raw.backfire_victim_name),
      special_reason: text(raw.special_reason),
      created_at: text(raw.created_at),
    };
    const eventTime = parseTimestamp(event.created_at);
    if (parsedCutoff !== null && eventTime !== null && eventTime > parsedCutoff) return;
    normalized.push(event);
  });
  normalized.sort(eventSortCompare);
  return normalized;
}

function collectDisplayNames(events, profiles) {
  const names = {};
  for (const [userId, profile] of Object.entries(profiles || {})) {
    if (userId && profile.display_name) names[userId] = profile.display_name;
  }
  const liveNameUserIds = new Set(Object.keys(names));
  for (const event of events) {
    const pairs = [
      [event.attacker_id, event.attacker_name],
      [event.target_id, event.target_name],
      [event.backfire_victim_id, event.backfire_victim_name],
    ];
    for (const [userId, displayName] of pairs) {
      if (userId && displayName && !liveNameUserIds.has(userId)) names[userId] = displayName;
    }
    event.participant_ids.forEach((userId, i) => {
      const displayName = event.participant_names[i];
      if (userId && displayName && !liveNameUserIds.has(userId)) names[userId] = displayName;
    });
  }
  return names;
}

function collectParticipants(groupRolls, events, activeUserIds, botUserIds) {
  const users = new Set();
  for (const userId of activeUserIds || []) users.add(text(userId));
  for (const userId of Object.keys(groupRolls)) users.add(text(userId));
  for (const event of events) {
    users.add(event.attacker_id);
    if (event.event_type !== 'bot_backfire') users.add(event.target_id);
    for (const id of event.participant_ids) users.add(id);
    users.add(event.backfire_victim_id);
  }
  users.delete('');
  for (const botId of botUserIds) users.delete(text(botId));
  return [...users].sort();
}

// ================================ 今日猪圈速览 ================================ //

function counter(items) {
  const map = new Map();
  for (const item of items) map.set(item, (map.get(item) || 0) + 1);
  return map;
}

function buildDailyOverview(groupRolls, events, { humanPigIds }) {
  const normalizedGroupRolls = normalizeGroupRolls(groupRolls);
  const ordinaryEvents = events.filter(
    (e) => !isReservation(e) && e.event_type !== 'self_roast'
  );
  const reservationEvents = events.filter((e) => isReservation(e));
  const normalizedRolls = Object.values(normalizedGroupRolls);
  const pigCounts = counter(normalizedRolls);
  let topPigId = '';
  let topPigCount = 0;
  for (const [pigId, count] of pigCounts) {
    if (count > topPigCount) {
      topPigId = pigId;
      topPigCount = count;
    }
  }
  const reservationIds = new Set(reservationEvents.map((e) => e.reservation_id || e.event_id));
  return {
    roll_count: Object.keys(normalizedGroupRolls).length,
    ordinary_roast_count: ordinaryEvents.length,
    reservation_count: reservationIds.size,
    escape_count: events.filter((e) => e.event_type === 'escape').length,
    backfire_count: events.filter(
      (e) => e.event_type === 'backfire' || e.event_type === 'bot_backfire'
    ).length,
    pig_variety_count: new Set(normalizedRolls).size,
    human_count: normalizedRolls.filter((pigId) => humanPigIds.has(pigId)).length,
    ordinary_success_count: events.filter(
      (e) => e.event_type === 'success' && !isReservation(e)
    ).length,
    top_pig_id: topPigId,
    top_pig_count: topPigCount,
  };
}

function selectOverviewMetrics(overview) {
  const metrics = [
    { kind: 'roll_count', label: '小猪数量', value: overview.roll_count, unit: '头' },
    { kind: 'ordinary_roast', label: '普通烤猪', value: overview.ordinary_roast_count, unit: '次' },
  ];
  if (overview.reservation_count > 0) {
    metrics.push({ kind: 'reservation', label: '预约烤猪', value: overview.reservation_count, unit: '场' });
  } else if (overview.escape_count > 0) {
    metrics.push({ kind: 'escape', label: '成功逃脱', value: overview.escape_count, unit: '次' });
  } else if (overview.backfire_count > 0) {
    metrics.push({ kind: 'backfire', label: '意外翻车', value: overview.backfire_count, unit: '次' });
  } else if (overview.pig_variety_count > 0) {
    metrics.push({ kind: 'pig_variety', label: '小猪种类', value: overview.pig_variety_count, unit: '种' });
  }
  return metrics;
}

function selectObservation(overview, groupRolls, events) {
  const normalizedGroupRolls = normalizeGroupRolls(groupRolls);
  const totalRoasts = overview.ordinary_roast_count + overview.reservation_count;
  const countKinds = (predicate) => {
    const c = { success: 0, escape: 0, backfire: 0 };
    for (const e of events) {
      if (!predicate(e)) continue;
      const kind = resultKind(e);
      if (kind in c) c[kind] += 1;
    }
    return c;
  };
  const reservationResults = countKinds(
    (e) => isReservation(e) && ['success', 'escape', 'backfire'].includes(resultKind(e))
  );
  const allResults = countKinds((e) => ['success', 'escape', 'backfire'].includes(resultKind(e)));
  const ordinaryResults = countKinds(
    (e) =>
      !isReservation(e) &&
      e.event_type !== 'self_roast' &&
      ['success', 'escape', 'backfire'].includes(resultKind(e))
  );

  let dominantResult = '';
  const reservationTotal =
    reservationResults.success + reservationResults.escape + reservationResults.backfire;
  if (reservationTotal > 0) {
    // 同数时保持“成功→逃脱→反噬”优先级
    const order = ['success', 'escape', 'backfire'];
    dominantResult = order.reduce((best, kind) => {
      if (reservationResults[kind] > reservationResults[best]) return kind;
      return best;
    }, 'success');
  }

  const candidates = {};
  if (
    overview.reservation_count >= 3 ||
    (overview.reservation_count >= 2 &&
      totalRoasts > 0 &&
      overview.reservation_count / totalRoasts >= 0.3)
  ) {
    candidates.reservation = {
      kind: 'reservation',
      total: totalRoasts,
      matched: overview.reservation_count,
      dominant_result: dominantResult,
      success_count: reservationResults.success,
      escape_count: reservationResults.escape,
      backfire_count: reservationResults.backfire,
    };
  }
  if (totalRoasts >= 4 && overview.backfire_count / totalRoasts >= 0.3) {
    candidates.backfire = {
      kind: 'backfire',
      total: totalRoasts,
      matched: overview.backfire_count,
      success_count: allResults.success,
      escape_count: allResults.escape,
      backfire_count: allResults.backfire,
    };
  }
  if (totalRoasts >= 5 && overview.escape_count / totalRoasts >= 0.4) {
    candidates.escape = {
      kind: 'escape',
      total: totalRoasts,
      matched: overview.escape_count,
      success_count: allResults.success,
      escape_count: allResults.escape,
      backfire_count: allResults.backfire,
    };
  }
  if (
    overview.ordinary_roast_count >= 5 &&
    overview.ordinary_success_count / overview.ordinary_roast_count >= 0.6
  ) {
    candidates.success = {
      kind: 'success',
      total: overview.ordinary_roast_count,
      matched: overview.ordinary_success_count,
      success_count: ordinaryResults.success,
      escape_count: ordinaryResults.escape,
      backfire_count: ordinaryResults.backfire,
    };
  }
  if (
    overview.human_count >= 2 ||
    (overview.roll_count >= 8 && overview.human_count / overview.roll_count >= 0.15)
  ) {
    candidates.human = {
      kind: 'human',
      total: overview.roll_count,
      matched: overview.human_count,
    };
  }

  const pigCounts = counter(Object.values(normalizedGroupRolls));
  const maxPigCount = Math.max(0, ...pigCounts.values());
  const duplicateCount = Math.max(0, overview.roll_count - overview.pig_variety_count);
  if (
    overview.roll_count > 0 &&
    (maxPigCount >= 3 || duplicateCount / overview.roll_count >= 0.25)
  ) {
    candidates.collision = {
      kind: 'collision',
      total: overview.roll_count,
      matched: duplicateCount,
    };
  }
  if (
    overview.roll_count >= 8 &&
    overview.pig_variety_count / overview.roll_count >= 0.9 &&
    maxPigCount <= 2
  ) {
    candidates.variety = {
      kind: 'variety',
      total: overview.roll_count,
      matched: overview.pig_variety_count,
    };
  }
  for (const kind of OBSERVATION_PRIORITY) {
    if (candidates[kind]) return candidates[kind];
  }
  return null;
}

// ================================ 今日头条评分 ================================ //

function headlineKind(event) {
  if (isReservation(event)) {
    if (event.event_type === 'success') return 'reservation_success';
    if (event.event_type === 'escape') return 'reservation_escape';
    if (event.event_type === 'backfire') return 'reservation_backfire';
    if (
      event.event_type === 'reserved_special' &&
      ['human', 'food', 'eaten', 'sold'].includes(event.special_reason)
    ) {
      return `reservation_${event.special_reason}`;
    }
    return null;
  }
  return (
    {
      success: 'normal_success',
      escape: 'normal_escape',
      backfire: 'normal_backfire',
      self_roast: 'self_roast',
      bot_backfire: 'bot_backfire',
    }[event.event_type] || null
  );
}

function pairKey(event) {
  if (!event.attacker_id || !event.target_id) return null;
  return [event.attacker_id, event.target_id].sort().join('\x1f');
}

function selectHeadline(events) {
  const pairCounts = new Map();
  for (const event of events) {
    const key = pairKey(event);
    if (key) pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }
  const candidates = [];
  for (const event of events) {
    const kind = headlineKind(event);
    if (!kind) continue;
    const key = pairKey(event);
    const repeatedPairEvents = Math.max(0, (key ? pairCounts.get(key) || 0 : 0) - 1);
    const participantCount = isReservation(event) ? event.participant_count : 0;
    const sizeBonus = participantCount >= 10 ? 20 : participantCount >= 6 ? 10 : 0;
    const score =
      HEADLINE_BASE_SCORE[kind] + participantCount * 5 + sizeBonus + repeatedPairEvents * 5;
    if (score >= 50) {
      candidates.push({ kind, score, repeated_pair_events: repeatedPairEvents, event });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.event.participant_count !== b.event.participant_count)
      return b.event.participant_count - a.event.participant_count;
    if (HEADLINE_BASE_SCORE[a.kind] !== HEADLINE_BASE_SCORE[b.kind])
      return HEADLINE_BASE_SCORE[b.kind] - HEADLINE_BASE_SCORE[a.kind];
    const byTime = compareKeyPair(timestampKey(a.event.created_at), timestampKey(b.event.created_at));
    if (byTime !== 0) return byTime;
    return a.event.event_id < b.event.event_id ? -1 : 1;
  });
  return candidates[0];
}

// ================================ 事件追踪 ================================ //

function uniqueEvents(events) {
  const map = new Map();
  for (const event of events) map.set(event.event_id, event);
  return [...map.values()].sort(eventSortCompare);
}

function buildTimelineCandidates(events) {
  const candidates = [];
  const directedPairs = new Map(); // "a\x1fb" -> events
  const initiatedByUser = new Map();
  const pairId = (a, b) => `${a}\x1f${b}`;
  for (const event of events) {
    if (event.attacker_id) {
      if (!initiatedByUser.has(event.attacker_id)) initiatedByUser.set(event.attacker_id, []);
      initiatedByUser.get(event.attacker_id).push(event);
    }
    if (event.attacker_id && event.target_id && event.attacker_id !== event.target_id) {
      const key = pairId(event.attacker_id, event.target_id);
      if (!directedPairs.has(key)) directedPairs.set(key, []);
      directedPairs.get(key).push(event);
    }
  }

  const seenMutual = new Set();
  for (const key of directedPairs.keys()) {
    const [attackerId, targetId] = key.split('\x1f');
    const pair = [attackerId, targetId].sort().join('\x1f');
    const reverseKey = pairId(targetId, attackerId);
    if (seenMutual.has(pair) || !directedPairs.has(reverseKey)) continue;
    seenMutual.add(pair);
    candidates.push({
      kind: 'mutual',
      identity: pair,
      events: uniqueEvents([...directedPairs.get(key), ...directedPairs.get(reverseKey)]),
      anchor_event: null,
    });
  }

  for (const [userId, userEvents] of initiatedByUser) {
    const ordered = uniqueEvents(userEvents);
    if (ordered.length < 3) continue;
    const results = new Set(ordered.map((e) => resultKind(e)));
    const mixesReservation =
      ordered.some((e) => isReservation(e)) && ordered.some((e) => !isReservation(e));
    if (results.size > 1 || mixesReservation) {
      candidates.push({ kind: 'personal_turn', identity: userId, events: ordered, anchor_event: null });
    }
  }

  for (const reservationEvent of events.filter((e) => isReservation(e))) {
    const ownerId = reservationEvent.attacker_id;
    const targetId = reservationEvent.target_id;
    if (!ownerId || !targetId || ownerId === targetId) continue;
    const reservationPair = new Set([ownerId, targetId]);
    const related = [reservationEvent];
    for (const event of events) {
      if (isReservation(event)) continue;
      const eventPair = new Set([event.attacker_id, event.target_id]);
      if (
        eventPair.size === reservationPair.size &&
        [...eventPair].every((x) => reservationPair.has(x)) &&
        eventSortCompare(event, reservationEvent) > 0
      ) {
        related.push(event);
      }
    }
    const ordered = uniqueEvents(related);
    if (ordered.length >= 2) {
      candidates.push({
        kind: 'reservation_followup',
        identity: reservationEvent.reservation_id,
        events: ordered,
        anchor_event: reservationEvent,
      });
    }
  }

  for (const [key, pairEvents] of directedPairs) {
    const ordered = uniqueEvents(pairEvents);
    if (ordered.length >= 2) {
      const [attackerId, targetId] = key.split('\x1f');
      candidates.push({
        kind: 'repeat_target',
        identity: `${attackerId}:${targetId}`,
        events: ordered,
        anchor_event: null,
      });
    }
  }
  return candidates;
}

function selectTimeline(events, headline) {
  const headlineEventId = headline ? headline.event.event_id : '';
  const candidates = [];
  for (const candidate of buildTimelineCandidates(events)) {
    const remaining = candidate.events.filter((e) => e.event_id !== headlineEventId);
    if (remaining.length >= 2) {
      candidates.push({ ...candidate, events: remaining });
    }
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const ai = TIMELINE_PRIORITY.indexOf(a.kind);
    const bi = TIMELINE_PRIORITY.indexOf(b.kind);
    if (ai !== bi) return ai - bi;
    if (a.events.length !== b.events.length) return b.events.length - a.events.length;
    const ar = new Set(a.events.map((e) => resultKind(e))).size;
    const br = new Set(b.events.map((e) => resultKind(e))).size;
    if (ar !== br) return br - ar;
    const aSpecial = a.events.some((e) => isReservation(e) || resultKind(e) === 'backfire') ? 1 : 0;
    const bSpecial = b.events.some((e) => isReservation(e) || resultKind(e) === 'backfire') ? 1 : 0;
    if (aSpecial !== bSpecial) return bSpecial - aSpecial;
    const byTime = compareKeyPair(
      timestampKey(a.events[0].created_at),
      timestampKey(b.events[0].created_at)
    );
    if (byTime !== 0) return byTime;
    return a.identity < b.identity ? -1 : 1;
  });
  const selected = candidates[0];
  return {
    kind: selected.kind,
    events: selected.events.slice(0, 3),
    anchor_event: selected.anchor_event,
  };
}

// ================================ 今日排行 ================================ //

function rankEntries(kind, rows) {
  if (!rows.length) return null;
  const ordered = [...rows].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const byTime = compareKeyPair(timestampKey(a.achieved_at), timestampKey(b.achieved_at));
    if (byTime !== 0) return byTime;
    return a.user_id < b.user_id ? -1 : 1;
  });
  const entries = [];
  let previousScore = null;
  let currentRank = 0;
  ordered.forEach((row, index) => {
    if (row.score !== previousScore) {
      currentRank = index + 1;
      previousScore = row.score;
    }
    entries.push({ ...row, rank: currentRank });
  });
  return { kind, entries: entries.slice(0, 3) };
}

function buildRankings(participantIds, groupRolls, events, profiles) {
  const normalizedGroupRolls = normalizeGroupRolls(groupRolls);
  const candidates = new Set(participantIds);
  const successEvents = new Map();
  for (const event of events) {
    if (event.event_type === 'success' && !isReservation(event) && candidates.has(event.attacker_id)) {
      if (!successEvents.has(event.attacker_id)) successEvents.set(event.attacker_id, []);
      successEvents.get(event.attacker_id).push(event);
    }
  }

  const exRows = [];
  const successRows = [];
  const catalogRows = [];
  for (const userId of [...candidates].sort()) {
    const profile = profiles[userId] || { user_id: userId };
    const displayName = profile.display_name || userId;
    const dailyPigId = normalizedGroupRolls[userId] || '';
    if (dailyPigId && profile.daily_ex_level != null) {
      exRows.push({
        user_id: userId,
        display_name: displayName,
        score: Math.max(0, parseInt(profile.daily_ex_level, 10) || 0),
        pig_id: dailyPigId,
        pig_name: profile.daily_pig_name || '',
        image_name: profile.daily_image_name || '',
        achieved_at: profile.daily_achieved_at || '',
      });
    }

    const userSuccesses = (successEvents.get(userId) || []).slice().sort(eventSortCompare);
    if (userSuccesses.length && dailyPigId) {
      successRows.push({
        user_id: userId,
        display_name: displayName,
        score: userSuccesses.length,
        pig_id: dailyPigId,
        pig_name: profile.daily_pig_name || '',
        image_name: profile.daily_image_name || '',
        achieved_at: userSuccesses[userSuccesses.length - 1].created_at,
      });
    }

    if (profile.catalog_count != null && profile.catalog_count > 0) {
      const catalogPigId = dailyPigId || profile.recent_pig_id || '';
      catalogRows.push({
        user_id: userId,
        display_name: displayName,
        score: parseInt(profile.catalog_count, 10) || 0,
        pig_id: catalogPigId,
        pig_name: dailyPigId ? profile.daily_pig_name || '' : profile.recent_pig_name || '',
        image_name: dailyPigId ? profile.daily_image_name || '' : profile.recent_image_name || '',
        achieved_at: profile.catalog_achieved_at || '',
      });
    }
  }

  return [
    rankEntries('expert_level', exRows),
    rankEntries('roast_success', successRows),
    rankEntries('catalog', catalogRows),
  ].filter(Boolean);
}

/** 沿用规则：被成功烤至少两次且次数最高的一人获得次日保护。 */
export function selectDailyProtectedUserIds(events) {
  const roastedCounter = new Map();
  for (const event of events) {
    if (
      event.event_type === 'success' &&
      event.target_id &&
      event.target_id !== event.attacker_id
    ) {
      roastedCounter.set(event.target_id, (roastedCounter.get(event.target_id) || 0) + 1);
    }
  }
  if (!roastedCounter.size) return [];
  let bestUser = '';
  let bestCount = 0;
  for (const [userId, count] of roastedCounter) {
    if (count > bestCount) {
      bestUser = userId;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? [bestUser] : [];
}

// ================================ 日报总装配 ================================ //

export function buildDailyReport({
  dateStr,
  groupId,
  groupRolls,
  rawEvents,
  activeUserIds = [],
  botUserIds = [],
  userProfiles = {},
  protections = [],
  humanPigIds = null,
  cutoffAt = '',
}) {
  const humanSet =
    humanPigIds instanceof Set ? humanPigIds : new Set(resourceManager.humanPigIds || []);
  const events = normalizeDailyEvents(rawEvents, { groupId, cutoffAt });
  const normalizedBotIds = new Set([...botUserIds].map((id) => text(id)).filter(Boolean));
  const normalizedGroupRolls = {};
  for (const [userId, pigId] of Object.entries(normalizeGroupRolls(groupRolls))) {
    if (!normalizedBotIds.has(userId)) normalizedGroupRolls[userId] = pigId;
  }
  const participantIds = collectParticipants(
    normalizedGroupRolls,
    events,
    activeUserIds,
    normalizedBotIds
  );
  const displayNames = collectDisplayNames(events, userProfiles);
  const overview = buildDailyOverview(normalizedGroupRolls, events, { humanPigIds: humanSet });
  const overviewMetrics = selectOverviewMetrics(overview);
  const observation = selectObservation(overview, normalizedGroupRolls, events);
  const headline = selectHeadline(events);
  const timeline = selectTimeline(events, headline);
  const rankings = buildRankings(participantIds, normalizedGroupRolls, events, userProfiles);
  return {
    date_str: text(dateStr),
    group_id: text(groupId),
    has_activity: !!(
      Object.keys(normalizedGroupRolls).length ||
      events.length ||
      participantIds.length
    ),
    participant_ids: participantIds,
    display_names: displayNames,
    events,
    overview,
    overview_metrics: overviewMetrics,
    observation,
    headline,
    timeline,
    rankings,
    protections,
  };
}

// ================================ 用户资料聚合（本地 store） ================================ //

/**
 * 从本地 store 聚合排行所需的用户资料（EX 等级、图鉴数、最近抽猪）。
 * @param {string[]} participantIds
 * @param {object} groupRolls  {userId: pigId}
 * @param {object} memberNames {userId: displayName}
 */
export function buildDailyUserProfiles(participantIds, groupRolls, memberNames = {}) {
  const profiles = {};
  const normalized = normalizeGroupRolls(groupRolls);
  for (const userId of participantIds) {
    const drawState = store.getDrawState(userId);
    const dailyPigId = normalized[userId] || '';
    const catalogCount = drawState.pig_ids.length;

    let dailyName = '';
    let dailyImage = '';
    let dailyLevel = null;
    if (dailyPigId) {
      dailyLevel = drawState.expertLevelOf(dailyPigId);
      const pig = getPigById(dailyPigId);
      dailyName = pig ? String(pig.name || dailyPigId) : dailyPigId;
      const appearance = pig ? resourceManager.resolvePigAppearance(pig, dailyLevel || 0) : null;
      dailyImage = appearance ? appearance.image_path || appearance.base_image_path || '' : '';
    }

    // 最近一次抽猪（用于图鉴榜无今日猪时兜底头像）
    const snapshot = store.getCatalogSnapshot(userId, 14);
    let recentPigId = '';
    const recentRolls = snapshot.recent_rolls || {};
    const recentDates = Object.keys(recentRolls).sort().reverse();
    if (recentDates.length) recentPigId = String(recentRolls[recentDates[0]] || '');
    let recentName = '';
    let recentImage = '';
    if (recentPigId) {
      const pig = getPigById(recentPigId);
      recentName = pig ? String(pig.name || recentPigId) : recentPigId;
      const level = drawState.expertLevelOf(recentPigId);
      const appearance = pig ? resourceManager.resolvePigAppearance(pig, level || 0) : null;
      recentImage = appearance ? appearance.image_path || appearance.base_image_path || '' : '';
    }

    profiles[userId] = {
      user_id: userId,
      display_name: memberNames[userId] || '',
      daily_pig_id: dailyPigId,
      daily_pig_name: dailyName,
      daily_ex_level: dailyLevel,
      daily_image_name: dailyImage,
      daily_achieved_at: '',
      catalog_count: catalogCount,
      catalog_achieved_at: '',
      recent_pig_id: recentPigId,
      recent_pig_name: recentName,
      recent_image_name: recentImage,
    };
  }
  return profiles;
}

// ================================ 稳定文案与富文本 ================================ //

const TEMPLATE_FIELD_PATTERN = /\{([a-z][a-z0-9_]*)\}/g;

function stableTemplate(report, section, kind, identity, templates) {
  if (!templates || !templates.length) {
    throw new Error(`日报文案池不能为空: section=${section} kind=${kind}`);
  }
  const seed = [report.date_str, report.group_id, section, kind, identity].join('\x1f');
  const digest = crypto.createHash('sha256').update(seed, 'utf8').digest();
  const idx = Number(digest.readBigUInt64BE(0) % BigInt(templates.length));
  return templates[idx];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 把 {字段} 模板转成 HTML 富文本；缺字段立即报错。fields: {name: {text,color,bold}} */
function richTemplateHtml(template, fields) {
  let html = '';
  let cursor = 0;
  for (const match of template.matchAll(TEMPLATE_FIELD_PATTERN)) {
    if (match.index > cursor) {
      html += `<span class="ink">${escapeHtml(template.slice(cursor, match.index))}</span>`;
    }
    const fieldName = match[1];
    if (!(fieldName in fields)) throw new Error(`日报文案缺少字段: ${fieldName}`);
    const span = fields[fieldName];
    const cls = [span.color === RED ? 'red' : 'ink', span.bold ? 'bold' : '']
      .filter(Boolean)
      .join(' ');
    html += `<span class="${cls}">${escapeHtml(span.text)}</span>`;
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) {
    html += `<span class="ink">${escapeHtml(template.slice(cursor))}</span>`;
  }
  return html;
}

function span(t, color = INK, bold = false) {
  return { text: String(t), color, bold };
}

// 展示名最大长度：QQBot 端拿不到群名片时会回退到超长 openid/uin，
// 直接放进卡片会撑破排版。这里统一收口，超长名（尤其是纯字母数字 id）
// 截断为可读长度；渲染层的 CSS 再兜底换行。
const MAX_DISPLAY_NAME_LEN = 12;

function clampName(name, max = MAX_DISPLAY_NAME_LEN) {
  const normalized = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '群友';
  // 纯字母/数字/符号且偏长的多半是 openid/uin，给个更短更友好的兜底
  const looksLikeId = /^[A-Za-z0-9_\-]{15,}$/.test(normalized);
  if (looksLikeId) return `群友${normalized.slice(-4)}`;
  if (normalized.length > max) return `${normalized.slice(0, max)}…`;
  return normalized;
}

function reportName(report, userId, explicitName = '') {
  const value =
    explicitName || report.display_names[userId] || userId || '群友';
  return clampName(value);
}

function resourcePigName(pigId) {
  const pig = pigId ? getPigById(pigId) : null;
  return pig ? String(pig.name || pigId) : pigId || '小猪';
}

function reportDateParts(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!match) {
    return {
      volume: `VOL.${(dateStr || '').replace(/-/g, '')}   ★`,
      year: '----',
      month_day: '--.--',
      weekday: '日期未知',
    };
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return {
    volume: `VOL.${y}-${m}${d}   ★`,
    year: y,
    month_day: `${m}.${d}`,
    weekday: WEEKDAYS[date.getUTCDay()],
  };
}

function observationBreakdown(selection) {
  const parts = [];
  for (const [label, count] of [
    ['成功', selection.success_count || 0],
    ['逃脱', selection.escape_count || 0],
    ['反噬', selection.backfire_count || 0],
  ]) {
    if (count) parts.push(`${label} ${count} 场`);
  }
  const regularCount =
    (selection.success_count || 0) + (selection.escape_count || 0) + (selection.backfire_count || 0);
  const specialCount = Math.max(0, (selection.matched || 0) - regularCount);
  if (specialCount) parts.push(`特殊目标 ${specialCount} 场`);
  return parts.length ? parts.join('、') : '各场结果没有形成明显倾向';
}

function observationCard(report) {
  const selection = report.observation;
  if (!selection) return null;
  const overview = report.overview;
  const resultText =
    { success: '烤成了', escape: '跑了', backfire: '把自己烤了' }[selection.dominant_result] ||
    '结果各不相同';
  const identity = [
    selection.total,
    selection.matched,
    selection.success_count || 0,
    selection.escape_count || 0,
    selection.backfire_count || 0,
    overview.top_pig_id,
    overview.top_pig_count,
  ].join(':');
  const template = stableTemplate(
    report,
    'observation',
    selection.kind,
    identity,
    DAILY_REPORT_OBSERVATION_TEXTS[selection.kind]
  );
  const html = richTemplateHtml(template, {
    total: span(selection.total, INK, true),
    matched: span(selection.matched, RED, true),
    result: span(resultText, RED, true),
    breakdown: span(observationBreakdown(selection), RED),
    roll_count: span(overview.roll_count, INK, true),
    variety_count: span(overview.pig_variety_count, RED, true),
    top_pig: span(resourcePigName(overview.top_pig_id), RED, true),
    top_count: span(overview.top_pig_count, RED, true),
  });
  return { html };
}

function reservationSize(event) {
  const participantIds = new Set(event.participant_ids);
  const totalCount = Math.max(
    1,
    event.participant_count,
    participantIds.size + (participantIds.has(event.attacker_id) ? 0 : 1)
  );
  return { joined: Math.max(0, totalCount - 1), total: totalCount };
}

function headlineCard(report) {
  const selection = report.headline;
  if (!selection) return null;
  const event = selection.event;
  const attacker = reportName(report, event.attacker_id, event.attacker_name);
  const target = reportName(report, event.target_id, event.target_name);
  const victim = reportName(
    report,
    event.backfire_victim_id || event.attacker_id,
    event.backfire_victim_name || event.attacker_name
  );
  const kind = selection.kind;
  let food = (event.food || '今日出餐').replace(/\s+/g, ' ').trim();
  if (food.length > 10) food = `${food.slice(0, 9)}…`;
  const { joined, total } = reservationSize(event);
  let opening;
  let teamSubject;
  let team;
  if (joined) {
    opening = `${attacker}召集 ${joined} 名群友围住${target}`;
    teamSubject = `${attacker}和另外 ${joined} 名群友`;
    team = `由${attacker}带队的 ${total} 人预约队伍`;
  } else {
    opening = `${attacker}独自守着预约烤架等到${target}`;
    teamSubject = `${attacker}独自`;
    team = `${attacker}的单人预约`;
  }

  let tags;
  if (kind === 'normal_success') tags = ['普通烤猪', '成功出餐'];
  else if (kind === 'normal_escape') tags = ['普通烤猪', '目标逃脱'];
  else if (kind === 'normal_backfire') tags = ['普通烤猪', '当场翻车'];
  else if (kind === 'self_roast') tags = ['主动自烤', '自觉上桌'];
  else if (kind === 'bot_backfire') tags = ['挑战 Bot', '当场伏诛'];
  else {
    let sizeTag = total >= 6 ? '大型预约' : '预约烤猪';
    let countTag = `${total} 人参与`;
    const resultTag = {
      reservation_success: '成功出餐',
      reservation_escape: '集体扑空',
      reservation_backfire: '意外走火',
      reservation_human: '人类形态',
      reservation_food: '早已熟透',
      reservation_eaten: '已经吃掉',
      reservation_sold: '已经售出',
    }[kind];
    if (kind === 'reservation_food') {
      sizeTag = '预约烤猪';
      countTag = `${total} 人围观`;
    }
    tags = [sizeTag, countTag, resultTag];
  }

  const template = stableTemplate(
    report,
    'headline',
    kind,
    `${event.event_id}:${total}:${food}:${victim}`,
    DAILY_REPORT_HEADLINE_TEXTS[kind]
  );
  const html = richTemplateHtml(template, {
    attacker: span(attacker, INK, true),
    target: span(target, INK, true),
    victim: span(victim, INK, true),
    food: span(food, RED, true),
    success: span('被烤了', RED, true),
    escape: span('溜了', RED, true),
    backfire: span('被烤了', RED, true),
    self_result: span('自烤', RED, true),
    human_state: span('人类形态', RED, true),
    food_state: span('熟食', RED, true),
    eaten_state: span('被吃掉', RED, true),
    sold_state: span('售出', RED, true),
    opening: span(opening, INK),
    team_subject: span(teamSubject, INK),
    team: span(team, INK),
    forks: span(`${total} 把烤叉`, INK, true),
  });
  return { html, tags };
}

function timelineEventDetail(report, event) {
  const attacker = reportName(report, event.attacker_id, event.attacker_name);
  const target = reportName(report, event.target_id, event.target_name);
  const victim = reportName(
    report,
    event.backfire_victim_id || event.attacker_id,
    event.backfire_victim_name || event.attacker_name
  );
  let kind;
  if (event.event_type === 'self_roast') kind = 'self_roast';
  else if (event.event_type === 'success')
    kind = isReservation(event) ? 'reservation_success' : 'normal_success';
  else if (event.event_type === 'escape') kind = 'escape';
  else if (event.event_type === 'bot_backfire') kind = 'bot_backfire';
  else if (event.event_type === 'backfire') kind = 'backfire';
  else {
    kind =
      {
        human: 'special_human',
        food: 'special_food',
        eaten: 'special_eaten',
        sold: 'special_sold',
      }[event.special_reason] || 'special_other';
  }
  const template = stableTemplate(
    report,
    'timeline_detail',
    kind,
    event.event_id,
    DAILY_REPORT_TIMELINE_DETAIL_TEXTS[kind]
  );
  return template
    .replace(/\{attacker\}/g, attacker)
    .replace(/\{target\}/g, target)
    .replace(/\{victim\}/g, victim);
}

function timelineColor(event) {
  if (event.event_type === 'reserved_special') return '#b26e1c';
  if (isReservation(event)) return '#b26e1c';
  if (event.event_type === 'backfire' || event.event_type === 'bot_backfire') return '#ae3824';
  if (event.event_type === 'escape') return '#266f8e';
  return '#ac3723';
}

function timelineIntro(report, selection) {
  const events = selection.events;
  const first = selection.anchor_event || events[0];
  const attacker = reportName(report, first.attacker_id, first.attacker_name);
  const target = reportName(report, first.target_id, first.target_name);
  const identity = [first.event_id, ...events.map((e) => e.event_id)].join(':');
  const template = stableTemplate(
    report,
    'timeline_intro',
    selection.kind,
    identity,
    DAILY_REPORT_TIMELINE_INTRO_TEXTS[selection.kind]
  );
  return template
    .replace(/\{attacker\}/g, attacker)
    .replace(/\{target\}/g, target)
    .replace(/\{event_count\}/g, String(events.length));
}

function timelineCard(report) {
  const selection = report.timeline;
  if (!selection) return { intro: '', events: [] };
  const ordinal = ['第一次', '第二次', '第三次'];
  const items = selection.events.slice(0, 3).map((event, index) => ({
    title: ordinal[index],
    detail: timelineEventDetail(report, event),
    color: timelineColor(event),
  }));
  return { intro: timelineIntro(report, selection), events: items };
}

function rankingAvatar(kind, entry) {
  if (entry.image_name) return entry.image_name;
  const pigId = String(entry.pig_id || '');
  const pig = pigId ? getPigById(pigId) : null;
  if (pig) {
    const requestedLevel = kind === 'expert_level' ? parseInt(entry.score, 10) || 0 : 0;
    const appearance = resourceManager.resolvePigAppearance(pig, requestedLevel);
    return appearance.image_path || appearance.base_image_path || '';
  }
  return '';
}

function rankingCards(report) {
  const columns = [];
  for (const ranking of report.rankings) {
    const rows = ranking.entries.slice(0, 3).map((entry) => {
      const pigName = entry.pig_name || resourcePigName(entry.pig_id);
      const detail = {
        expert_level: `${pigName} Lv.${entry.score}`,
        roast_success: `${entry.score} 次`,
        catalog: `${entry.score} 种`,
      }[ranking.kind];
      return {
        name: clampName(entry.display_name),
        detail,
        avatar: rankingAvatar(ranking.kind, entry),
        rank: entry.rank,
      };
    });
    if (rows.length) {
      columns.push({ title: RANKING_TITLES[ranking.kind], entries: rows });
    }
  }
  return columns;
}

function couponCard(report) {
  if (!report.protections || !report.protections.length) return null;
  const protection = report.protections[0];
  const name = clampName(
    protection.display_name ||
      report.display_names[protection.user_id] ||
      protection.user_id
  );
  let benefit = protection.scope || '本群免烤';
  if (!benefit.includes('一天')) benefit = `${benefit}一天`;
  let expires = protection.expires_at || '';
  const parsed = parseTimestamp(expires);
  if (parsed !== null) {
    const d = new Date(parsed + 8 * 3600 * 1000); // 展示为业务时区
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    expires = `有效至 ${mm}.${dd} ${hh}:${mi}`;
  } else {
    expires = expires ? `有效至 ${expires}` : '次日有效';
  }
  const roastCount = report.events.filter(
    (e) =>
      e.event_type === 'success' &&
      e.target_id === protection.user_id &&
      e.target_id !== e.attacker_id
  ).length;
  return { name, benefit, expires, roast_count: roastCount };
}

/** 把纯业务日报快照转换为 HTML 模板所需的绘图数据。 */
export function buildDailyReportCardData(report, { cutoffTime = '23:45' } = {}) {
  const parts = reportDateParts(report.date_str);
  const timeline = timelineCard(report);
  return {
    volume: parts.volume,
    date_year: parts.year,
    date_month_day: parts.month_day,
    weekday: parts.weekday,
    stats: report.overview_metrics.map((m) => ({
      label: m.label,
      value: String(m.value),
      unit: m.unit,
    })),
    observation: observationCard(report),
    headline: headlineCard(report),
    event_intro: timeline.intro,
    events: timeline.events,
    rankings: rankingCards(report),
    coupon: couponCard(report),
    footer: `数据截止 ${cutoffTime} · 仅统计本群当日记录`,
  };
}

// ================================ 群开关 ================================ //

/** 判断某群是否开启日报推送（复用 control.js 的判定逻辑）。 */
export function isGroupReportEnabled(groupId) {
  const cfg = configControl.get();
  const enabledMap = cfg.daily_report_groups || {};
  const key = String(groupId);
  if (key in enabledMap) return !!enabledMap[key];
  return !!cfg.daily_summary_enabled;
}
