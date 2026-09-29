import crypto from 'crypto';
import store from '../store/store.js';
import resourceManager, { getPigById } from '../resource/resourceManager.js';
import { expertLevelFromCopies, safeInt } from '../model/models.js';
import { rollpigDateStr } from '../model/runtime.js';
import {
  YESTERDAY_RECAP_TEXT_VERSION,
  YESTERDAY_EXPERIENCE_TEXTS,
  YESTERDAY_SUMMARY_TEXTS,
} from '../model/texts.js';

/**
 * 昨日回顾数据层，移植自原 yesterday_recap.py。
 * 产出与绘图无关的回顾快照（抽取结果 + 足迹 + 经历 + 小结 + 今日余波）。
 */

// ================================ 稳定散列与工具 ================================ //

function stablePick(pool, ...parts) {
  if (!pool || !pool.length) throw new Error('昨日回顾文案池不能为空');
  const seed = [YESTERDAY_RECAP_TEXT_VERSION, ...parts].map(String).join('\x1f');
  const digest = crypto.createHash('sha256').update(seed, 'utf8').digest();
  const idx = Number(digest.readBigUInt64BE(0) % BigInt(pool.length));
  return pool[idx];
}

function txt(value) {
  return String(value ?? '');
}

/** 规范 JSON（键升序、无空格、保留 unicode），对齐 Python json.dumps(sort_keys)。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventFingerprint(dateStr, raw) {
  const rawIds = Array.isArray(raw.participant_ids) ? raw.participant_ids : [];
  const payload = {
    date: dateStr,
    type: txt(raw.type),
    attacker: txt(raw.attacker),
    target: txt(raw.target),
    food: txt(raw.food),
    group: txt(raw.group_id),
    reservation_id: txt(raw.reservation_id),
    participant_ids: [...new Set(rawIds.map((x) => txt(x)).filter(Boolean))].sort(),
    backfire_victim_id: txt(raw.backfire_victim_id),
    special_reason: txt(raw.special_reason),
  };
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function createdAtKey(value, sourceIndex) {
  const ms = Date.parse(txt(value).replace('Z', '+00:00'));
  return Number.isNaN(ms) ? sourceIndex : ms / 1000;
}

function eventIdKey(eventId) {
  return /^\d+$/.test(eventId) ? `1:${eventId.padStart(20, '0')}` : `0:${eventId}`;
}

// ================================ 事件归类 ================================ //

function normalEventFamily(eventType, attackerId, targetId, userId) {
  if (eventType === 'self_roast' && attackerId === userId) return ['self_roast', 'self'];
  if (eventType === 'success' && attackerId === userId) return ['success_as_attacker', 'attacker'];
  if (eventType === 'success' && targetId === userId) return ['success_as_target', 'target'];
  if (eventType === 'escape' && targetId === userId) return ['escape_as_target', 'target'];
  if (eventType === 'escape' && attackerId === userId) return ['escape_as_attacker', 'attacker'];
  if (eventType === 'backfire' && attackerId === userId) return ['normal_backfire', 'backfire_victim'];
  if (eventType === 'bot_backfire' && attackerId === userId) return ['bot_backfire', 'backfire_victim'];
  return ['', ''];
}

function reservationEventFamily(eventType, { userId, attackerId, targetId, participantIds, backfireVictimId, specialReason }) {
  if (eventType === 'backfire' && backfireVictimId === userId) return ['reservation_backfire_victim', 'backfire_victim'];
  let role;
  if (targetId === userId) role = 'target';
  else if (attackerId === userId) role = 'owner';
  else if (participantIds.includes(userId)) role = 'participant';
  else return ['', ''];

  if (eventType === 'success') return [role === 'target' ? 'reservation_success_target' : 'reservation_success_participant', role];
  if (eventType === 'escape') return [role === 'target' ? 'reservation_escape_target' : 'reservation_escape_participant', role];
  if (eventType === 'backfire') return ['reservation_backfire_participant', role];
  if (eventType === 'reserved_special') {
    if (role !== 'target') return ['reserved_special_participant', role];
    if (['human', 'food', 'eaten', 'sold'].includes(specialReason)) return [`reserved_special_target_${specialReason}`, role];
    return ['', ''];
  }
  return ['', ''];
}

export function normalizeYesterdayEvents(rawEvents, { dateStr, userId }) {
  const normalized = [];
  const seenReservations = new Set();
  const list = Array.isArray(rawEvents) ? rawEvents : [];
  list.forEach((raw, sourceIndex) => {
    if (!raw || typeof raw !== 'object') return;
    const eventType = txt(raw.type);
    const attackerId = txt(raw.attacker);
    const targetId = txt(raw.target);

    const rawIds = Array.isArray(raw.participant_ids) ? raw.participant_ids : [];
    const rawNames = Array.isArray(raw.participant_names) ? raw.participant_names : [];
    const idList = [];
    const nameMap = {};
    rawIds.forEach((item, index) => {
      const pid = txt(item);
      if (!pid) return;
      if (!(pid in nameMap)) idList.push(pid);
      const pname = index < rawNames.length ? txt(rawNames[index]) : '';
      if (pname || !(pid in nameMap)) nameMap[pid] = pname;
    });
    const reservationId = txt(raw.reservation_id);
    const backfireVictimId = txt(raw.backfire_victim_id);
    const specialReason = txt(raw.special_reason);
    if (reservationId && attackerId && !(attackerId in nameMap)) {
      idList.push(attackerId);
      nameMap[attackerId] = txt(raw.attacker_name);
    }
    const participantIds = idList;
    const participantNames = participantIds.map((id) => nameMap[id]);

    let family;
    let userRole;
    if (reservationId) {
      if (seenReservations.has(reservationId)) return;
      [family, userRole] = reservationEventFamily(eventType, {
        userId,
        attackerId,
        targetId,
        participantIds,
        backfireVictimId,
        specialReason,
      });
    } else {
      [family, userRole] = normalEventFamily(eventType, attackerId, targetId, userId);
    }
    if (!family) return;

    const fingerprint = eventFingerprint(dateStr, raw);
    const eventId = txt(raw.event_id) || `legacy-${String(sourceIndex).padStart(8, '0')}-${fingerprint.slice(0, 12)}`;
    const createdAt = txt(raw.created_at) || `${dateStr}T00:00:00+00:00`;
    const participantCount = Math.max(participantIds.length, Math.max(0, safeInt(raw.participant_count, 0)));

    normalized.push({
      event_id: eventId,
      created_at: createdAt,
      source_index: sourceIndex,
      event_type: eventType,
      family,
      user_role: userRole,
      attacker_id: attackerId,
      target_id: targetId,
      attacker_name: txt(raw.attacker_name),
      target_name: txt(raw.target_name),
      food: txt(raw.food),
      group_id: txt(raw.group_id),
      reservation_id: reservationId,
      participant_ids: participantIds,
      participant_names: participantNames,
      participant_count: participantCount,
      backfire_victim_id: backfireVictimId,
      backfire_victim_name: txt(raw.backfire_victim_name),
      special_reason: specialReason,
      fingerprint,
    });
    if (reservationId) seenReservations.add(reservationId);
  });
  return normalized;
}

// ================================ 经历选择 ================================ //

function displayName(name, scope) {
  if (scope === 'group') return name || '一名群友';
  return '一名群友';
}

function specialReasonText(reason) {
  return (
    {
      human: '它以人类形态出现',
      food: '它现身时已经是熟食',
      eaten: '它出现时只剩空盘',
      sold: '它出现前已经售出',
    }[reason] || '它以无法开烤的特殊形态出现'
  );
}

function experienceContext(event, scope) {
  const nameMap = {};
  event.participant_ids.forEach((id, i) => {
    nameMap[id] = event.participant_names[i];
  });
  const victimName = event.backfire_victim_name || nameMap[event.backfire_victim_id] || '';
  return {
    attacker: ['attacker', 'owner'].includes(event.user_role) ? '你' : displayName(event.attacker_name, scope),
    target: event.user_role === 'target' ? '你' : displayName(event.target_name, scope),
    victim: event.user_role === 'backfire_victim' ? '你' : displayName(victimName, scope),
    food: event.food || '一道不明熟食',
    participant_count: event.participant_count,
    other_count: Math.max(0, event.participant_count - 1),
    special_reason: specialReasonText(event.special_reason),
  };
}

function experienceScore(event) {
  const bonus = Math.min(Math.max(event.participant_count - 1, 0), 5);
  if (event.family === 'bot_backfire') return 100;
  if (event.family === 'reservation_backfire_victim') return 96;
  if (event.reservation_id && event.user_role === 'target') return 93;
  if (event.family === 'reservation_success_participant') return 85 + bonus;
  if (event.family === 'reserved_special_participant') return 81 + bonus;
  if (event.family === 'reservation_backfire_participant') return 79 + bonus;
  if (event.family === 'normal_backfire') return 84;
  if (event.family === 'self_roast') return 80;
  if (event.family === 'reservation_escape_participant') return 75 + bonus;
  return (
    { escape_as_target: 76, success_as_target: 72, success_as_attacker: 68, escape_as_attacker: 64 }[event.family] || 0
  );
}

function experiencePoolKey(event) {
  const countAware = new Set([
    'reservation_success_participant',
    'reservation_success_target',
    'reservation_escape_participant',
    'reservation_escape_target',
  ]);
  if (!countAware.has(event.family)) return event.family;
  const suffix = event.participant_count >= 2 ? 'multi' : event.participant_count === 1 ? 'single' : 'unknown';
  return `${event.family}_${suffix}`;
}

function formatTemplate(template, ctx) {
  return template.replace(/\{([a-z_]+)\}/g, (m, k) => (k in ctx ? String(ctx[k]) : m));
}

function buildExperienceCandidate(event, { dateStr, userId, scope, groupId }) {
  const poolKey = experiencePoolKey(event);
  const template = stablePick(
    YESTERDAY_EXPERIENCE_TEXTS[poolKey],
    dateStr,
    userId,
    scope,
    groupId,
    poolKey,
    event.fingerprint
  );
  return {
    family: event.family,
    text: formatTemplate(template, experienceContext(event, scope)),
    event_id: event.event_id,
    fingerprint: event.fingerprint,
    score: experienceScore(event),
    participant_count: event.participant_count,
    created_at_key: createdAtKey(event.created_at, event.source_index),
    event_id_key: eventIdKey(event.event_id),
  };
}

export function selectYesterdayExperiences(events, { dateStr, userId, scope, groupId }) {
  const candidates = events.map((e) => buildExperienceCandidate(e, { dateStr, userId, scope, groupId }));
  if (!candidates.length) return [];
  // 先按 fingerprint 稳定打底，再按四指标降序
  candidates.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.participant_count !== b.participant_count) return b.participant_count - a.participant_count;
    if (a.created_at_key !== b.created_at_key) return b.created_at_key - a.created_at_key;
    return a.event_id_key < b.event_id_key ? 1 : a.event_id_key > b.event_id_key ? -1 : 0;
  });
  const selected = [candidates[0]];
  const second = candidates.slice(1).find((c) => c.family !== candidates[0].family);
  if (second) selected.push(second);
  return selected.map((c) => ({ family: c.family, text: c.text, event_id: c.event_id }));
}

// ================================ 足迹与小结 ================================ //

function eventCounts(events) {
  const counts = {
    related_event_count: events.length,
    success_count: 0,
    roasted_count: 0,
    escaped_count: 0,
    backfire_count: 0,
    self_roast_count: 0,
    bot_backfire_count: 0,
    reservation_result_count: 0,
    collaborative_reservation_count: 0,
    targeted_count: 0,
  };
  for (const event of events) {
    if (event.reservation_id && ['owner', 'participant', 'backfire_victim'].includes(event.user_role)) {
      counts.reservation_result_count += 1;
      if (event.participant_count >= 2) counts.collaborative_reservation_count += 1;
    }
    if (event.reservation_id && event.user_role === 'target') counts.targeted_count += 1;

    if (['success_as_attacker', 'reservation_success_participant'].includes(event.family)) counts.success_count += 1;
    else if (['success_as_target', 'reservation_success_target'].includes(event.family)) {
      counts.roasted_count += 1;
      if (!event.reservation_id) counts.targeted_count += 1;
    } else if (['escape_as_target', 'reservation_escape_target'].includes(event.family)) {
      counts.escaped_count += 1;
      if (!event.reservation_id) counts.targeted_count += 1;
    } else if (['normal_backfire', 'reservation_backfire_victim'].includes(event.family)) counts.backfire_count += 1;
    else if (event.family === 'bot_backfire') {
      counts.backfire_count += 1;
      counts.bot_backfire_count += 1;
    } else if (event.family === 'self_roast') counts.self_roast_count += 1;
  }
  return counts;
}

export function buildYesterdayFootprints(events) {
  const counts = eventCounts(events);
  if (counts.related_event_count < 3) return [];
  const definitions = [
    ['bot_backfire_count', '挑战 Bot', 0, 0],
    ['reservation_result_count', '已结算预约', 0, 1],
    ['backfire_count', '反噬落到本人', 1, 0],
    ['escaped_count', '成功逃脱', 1, 1],
    ['success_count', '烤成别人', 2, 0],
    ['roasted_count', '被成功烤', 2, 1],
    ['self_roast_count', '自烤', 3, 0],
  ];
  const visible = definitions.filter((d) => counts[d[0]] > 0);
  visible.sort((a, b) => a[2] - b[2] || counts[b[0]] - counts[a[0]] || a[3] - b[3]);
  return visible.slice(0, 3).map(([key, label]) => ({ kind: key, label, count: counts[key] }));
}

export function buildYesterdaySummary(events, { dateStr, userId, scope, groupId }) {
  const counts = eventCounts(events);
  const related = counts.related_event_count;
  if (related <= 0) {
    const text = scope === 'group' ? '本群昨天没有发生与你有关的烤猪事件。' : '昨天没有记录到与你有关的烤猪事件。';
    return { kind: 'none', text };
  }
  if (related < 3) return null;

  const passiveCount = counts.roasted_count + counts.escaped_count;
  let kind;
  if (counts.self_roast_count >= 2) kind = 'self_service';
  else if (counts.backfire_count >= 2) kind = 'cursed';
  else if (counts.escaped_count >= 3 && counts.targeted_count > 0 && counts.escaped_count / counts.targeted_count >= 0.6) kind = 'escape_artist';
  else if (counts.roasted_count >= 3 && counts.roasted_count / related >= 0.5) kind = 'victim';
  else if (counts.collaborative_reservation_count >= 2 && counts.collaborative_reservation_count / related >= 0.5) kind = 'team_player';
  else if (counts.success_count >= 3 && counts.success_count / related >= 0.5) kind = 'chef';
  else if (counts.success_count >= 2 && passiveCount >= 2) kind = 'chaotic';
  else return null;

  const signature = canonicalJson(counts);
  const text = stablePick(YESTERDAY_SUMMARY_TEXTS[kind], dateStr, userId, scope, groupId, kind, signature);
  return { kind, text };
}

// ================================ 抽取结果 ================================ //

export function buildYesterdayOutcomeText(snapshot) {
  if (!snapshot.outcome_available) return '';
  if (snapshot.is_new_pig) {
    if (snapshot.collection_size_after_roll) return `新猪入圈 · 图鉴第 ${snapshot.collection_size_after_roll} 只`;
    return '新猪入圈';
  }
  const previousLevel =
    snapshot.previous_expert_level != null
      ? safeInt(snapshot.previous_expert_level, 0)
      : expertLevelFromCopies(snapshot.previous_copies || 0);
  const currentLevel =
    snapshot.expert_level_after_roll != null
      ? safeInt(snapshot.expert_level_after_roll, 0)
      : expertLevelFromCopies(snapshot.copies_after_roll || 0);
  if (currentLevel <= previousLevel) return '';
  return `EX Lv.${previousLevel} → ${currentLevel}`;
}

// ================================ 总装配 ================================ //

/**
 * 组装昨日回顾快照；没有昨日抽取记录时返回 null。
 * @param {string} userId
 * @param {object} opts { groupId, dateStr }
 */
export function buildYesterdayRecap(userId, { groupId = '', dateStr = null } = {}) {
  const targetDate = dateStr || rollpigDateStr(-1);
  const uid = String(userId);
  const gid = String(groupId || '');
  const scope = gid ? 'group' : 'cross_group';

  const roll = store.getDailyRollSnapshot(uid, targetDate);
  if (!roll) return null;

  const pig = getPigById(roll.pig_id);
  let pigName = roll.pig_id;
  let imagePath = null;
  let fallbackImagePath = null;
  let pigDescription = '';
  let pigAnalysis = '';
  let exLevel = 0;
  if (pig) {
    exLevel =
      roll.expert_level_after_roll != null
        ? safeInt(roll.expert_level_after_roll, 0)
        : roll.copies_after_roll != null
          ? expertLevelFromCopies(roll.copies_after_roll)
          : 0;
    const appearance = resourceManager.resolvePigAppearance(pig, exLevel);
    pigName = String(appearance.pig_data.name || roll.pig_id);
    imagePath = appearance.image_path;
    fallbackImagePath = appearance.base_image_path;
    pigDescription = String(appearance.pig_data.description || '');
    pigAnalysis = String(appearance.pig_data.analysis || '');
  }

  const outcomeText = buildYesterdayOutcomeText(roll);

  if (roll.is_makeup) {
    return {
      date_str: targetDate,
      scope,
      group_id: gid,
      pig_name: pigName,
      ex_level: exLevel,
      image_path: imagePath,
      fallback_image_path: fallbackImagePath,
      pig_description: pigDescription,
      pig_analysis: pigAnalysis,
      outcome_text: outcomeText,
      footprints: [],
      experiences: [],
      summary: null,
      aftereffect_text: '',
      events_available: false,
      is_makeup: true,
    };
  }

  // 取昨日与本人相关的事件（不按 store 的 userId 过滤，交给 normalize 判定角色，
  // 以便包含仅作为反噬受害者的记录）
  const rawEvents = store.getDailyEvents({ dateStr: targetDate, groupId: gid || null });
  const events = normalizeYesterdayEvents(rawEvents, { dateStr: targetDate, userId: uid });

  const footprints = buildYesterdayFootprints(events);
  const experiences = selectYesterdayExperiences(events, { dateStr: targetDate, userId: uid, scope, groupId: gid });
  const summary = buildYesterdaySummary(events, { dateStr: targetDate, userId: uid, scope, groupId: gid });

  let aftereffectText = '';
  if (gid) {
    try {
      if (store.isProtected(gid, uid, rollpigDateStr())) {
        aftereffectText = '昨天挨的烤没白挨：今天你在本群获得了一层保护，普通烤猪会被拦下。';
      }
    } catch {
      /* ignore */
    }
  }

  return {
    date_str: targetDate,
    scope,
    group_id: gid,
    pig_name: pigName,
    ex_level: exLevel,
    image_path: imagePath,
    fallback_image_path: fallbackImagePath,
    pig_description: pigDescription,
    pig_analysis: pigAnalysis,
    outcome_text: outcomeText,
    footprints,
    experiences,
    summary,
    aftereffect_text: aftereffectText,
    events_available: true,
    is_makeup: false,
  };
}
