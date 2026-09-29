import fs from 'fs';
import crypto from 'crypto';
import Path from '../../constants/path.js';
import { readJSONSync } from '../model/json.js';
import { rollpigDateStr, nowIso } from '../model/runtime.js';
import {
  MAX_EXPERT_LEVEL,
  expertLevelFromCopies,
  roastRefillThreshold,
  safeInt,
} from '../model/models.js';

// ================= 常量 =================
const ROAST_RESERVATION_MAX_PARTICIPANTS = 12;
const ROAST_REFILL_TTL_SECONDS = 10 * 60;

/**
 * 本地 JSON 存储层，对应原 data_manager.py + store/local_json.py。
 *
 * 数据结构（pig_data.json）：
 * - history: {date: {user_id: pig_id}}                     今日抽猪记录
 * - daily_roll_snapshots: {date: {user_id: snapshot}}      抽取时成长/资源快照
 * - group_rolls: {date: {group_id: {user_id: pig_id}}}     群内今日显形记录
 * - group_roll_seen_at: {date:{group_id:{user_id:iso}}}    群内首次显形时间
 * - collection: {user_id: [pig_id,...]}                    永久图鉴
 * - pig_progress: {user_id: {pig_id: {copies,growth_bonus,first_obtained_at}}}
 * - daily_feeds: {date: {user_id: feed}}                   每日加餐结果
 * - draw_state: {user_id: {duplicate_streak}}              连续重复次数
 * - usage: {user_id: {last_roast_ts,roast_charges,roast_charge_updated_ts}}
 * - force_usage: {user_id: "YYYY-MM-DD"}                   后门口令每日计数
 * - daily_events: {date: [event,...]}                      烧烤事件（日报）
 * - protected: {date: {group_id: [user_id,...]}}           次日保护名单
 * - unrolled_roast_attempts: {date: {user_id: count}}      未抽猪先烤违规次数
 * - roast_reservations: {reservation_id: reservation}      预约烤猪
 * - group_daily_active_users: {date: {group_id: [user_id,...]}}
 * - group_daily_active_at: {date: {group_id: {user_id: iso}}}
 * - roast_refill_requests: {request_id: request}           烤箱续火投票
 *
 * 单进程运行，使用同步文件读写 + 原子替换，不再引入异步锁。
 */
class PigStore {
  constructor() {
    this.file = Path.dataFile;
    this.data = this._load();
  }

  _defaultData() {
    return {
      history: {},
      daily_roll_snapshots: {},
      group_rolls: {},
      group_roll_seen_at: {},
      collection: {},
      pig_progress: {},
      daily_feeds: {},
      draw_state: {},
      usage: {},
      force_usage: {},
      daily_events: {},
      protected: {},
      unrolled_roast_attempts: {},
      roast_reservations: {},
      group_daily_active_users: {},
      group_daily_active_at: {},
      roast_refill_requests: {},
    };
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      if (!fs.existsSync(Path.data)) fs.mkdirSync(Path.data, { recursive: true });
      const def = this._defaultData();
      fs.writeFileSync(this.file, JSON.stringify(def, null, 2), 'utf8');
      return def;
    }
    try {
      const raw = readJSONSync(this.file) || {};
      return this._migrate(raw);
    } catch (err) {
      logger?.error?.(`[今日小猪] pig_data.json 读取失败，使用空数据: ${err}`);
      return this._defaultData();
    }
  }

  _migrate(data) {
    if (typeof data !== 'object' || data === null) data = {};
    const def = this._defaultData();
    for (const key of Object.keys(def)) {
      if (typeof data[key] !== 'object' || data[key] === null) {
        data[key] = def[key];
      }
    }
    // 旧版 history 存完整 pig dict → 只保留 pig_id
    for (const [, records] of Object.entries(data.history)) {
      if (typeof records !== 'object' || !records) continue;
      for (const [uid, val] of Object.entries(records)) {
        if (val && typeof val === 'object' && 'id' in val) {
          records[uid] = val.id;
        }
      }
    }
    // collection → pig_progress 回填（copies=1）
    for (const [userId, pigIds] of Object.entries(data.collection)) {
      if (!Array.isArray(pigIds)) continue;
      const userProgress = (data.pig_progress[userId] = data.pig_progress[userId] || {});
      for (const pigId of pigIds) {
        const item = userProgress[String(pigId)];
        if (!item || typeof item !== 'object') {
          userProgress[String(pigId)] = { copies: 1, growth_bonus: 0, first_obtained_at: null };
        } else if (safeInt(item.copies, 0) <= 0) {
          item.copies = 1;
        }
      }
      if (typeof data.draw_state[userId] !== 'object' || !data.draw_state[userId]) {
        data.draw_state[userId] = { duplicate_streak: 0 };
      }
    }
    return data;
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // ================= 今日/历史抽猪 =================

  getDailyRoll(userId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    return this.data.history[target]?.[userId] || null;
  }

  getDailyRolls(dateStr = null) {
    const target = dateStr || rollpigDateStr();
    return { ...(this.data.history[target] || {}) };
  }

  getPigByDate(userId, dateStr) {
    return this.data.history[dateStr]?.[userId] || null;
  }

  getUserCollection(userId) {
    const raw = this.data.collection[String(userId)];
    return Array.isArray(raw) ? raw.map(String) : [];
  }

  // ================= 图鉴成长状态 =================

  getDrawState(userId) {
    userId = String(userId);
    const rawCollection = this.data.collection[userId] || [];
    const collectionIds = Array.isArray(rawCollection) ? rawCollection.map(String) : [];
    const rawProgress = this.data.pig_progress[userId] || {};
    const progress = {};
    if (typeof rawProgress === 'object' && rawProgress) {
      for (const [pigId, item] of Object.entries(rawProgress)) {
        if (typeof item !== 'object' || !item) continue;
        const copies = Math.max(0, safeInt(item.copies, 0));
        const growthBonus = Math.max(0, safeInt(item.growth_bonus, 0));
        progress[String(pigId)] = {
          copies,
          growth_bonus: growthBonus,
          first_obtained_at: item.first_obtained_at || null,
          expert_level: expertLevelFromCopies(copies, growthBonus),
        };
      }
    }
    for (const pigId of collectionIds) {
      if (!progress[pigId]) {
        progress[pigId] = { copies: 1, growth_bonus: 0, first_obtained_at: null, expert_level: 0 };
      }
    }
    const rawState = this.data.draw_state[userId] || {};
    const duplicateStreak = Math.max(0, safeInt(rawState.duplicate_streak, 0));
    const pigIds = Object.keys(progress).sort();
    return {
      pig_ids: pigIds,
      progress,
      duplicate_streak: duplicateStreak,
      copiesOf(pigId) {
        return progress[pigId]?.copies || 0;
      },
      expertLevelOf(pigId) {
        return progress[pigId]?.expert_level || 0;
      },
    };
  }

  _applyCreatedRollProgress(userId, pigId) {
    const collection = this.data.collection;
    const userCollection = (collection[userId] = Array.isArray(collection[userId])
      ? collection[userId]
      : []);
    const pigProgress = this.data.pig_progress;
    const userProgress = (pigProgress[userId] =
      typeof pigProgress[userId] === 'object' && pigProgress[userId] ? pigProgress[userId] : {});
    const drawState = this.data.draw_state;
    const state = (drawState[userId] =
      typeof drawState[userId] === 'object' && drawState[userId]
        ? drawState[userId]
        : { duplicate_streak: 0 });

    const previousDuplicateStreak = Math.max(0, safeInt(state.duplicate_streak, 0));
    const previousItem = userProgress[pigId];
    const hasProgress = previousItem && typeof previousItem === 'object';
    const alreadyCollected = userCollection.includes(pigId);
    const previousCopies = hasProgress
      ? Math.max(1, safeInt(previousItem.copies, 1))
      : alreadyCollected
        ? 1
        : 0;
    const isNewPig = previousCopies <= 0 && !alreadyCollected;
    const growthBonus = hasProgress ? Math.max(0, safeInt(previousItem.growth_bonus, 0)) : 0;

    if (!userCollection.includes(pigId)) userCollection.push(pigId);

    let copies, duplicateStreak, firstObtainedAt;
    if (isNewPig) {
      copies = 1;
      duplicateStreak = 0;
      firstObtainedAt = nowIso();
    } else {
      copies = previousCopies + 1;
      duplicateStreak = previousDuplicateStreak + 1;
      firstObtainedAt = hasProgress && previousItem.first_obtained_at ? previousItem.first_obtained_at : null;
    }
    userProgress[pigId] = { copies, growth_bonus: growthBonus, first_obtained_at: firstObtainedAt };
    state.duplicate_streak = duplicateStreak;

    return {
      pig_id: pigId,
      created: true,
      is_new_pig: isNewPig,
      previous_copies: previousCopies,
      copies,
      previous_expert_level: expertLevelFromCopies(previousCopies, growthBonus),
      expert_level: expertLevelFromCopies(copies, growthBonus),
      previous_duplicate_streak: previousDuplicateStreak,
      duplicate_streak: duplicateStreak,
    };
  }

  _buildExistingRollResult(userId, pigId) {
    const drawState = this.getDrawState(userId);
    const copies = drawState.copiesOf(pigId);
    const expertLevel = drawState.expertLevelOf(pigId);
    return {
      pig_id: pigId,
      created: false,
      is_new_pig: false,
      previous_copies: copies,
      copies,
      previous_expert_level: expertLevel,
      expert_level: expertLevel,
      previous_duplicate_streak: drawState.duplicate_streak,
      duplicate_streak: drawState.duplicate_streak,
    };
  }

  _recordGroupRoll(dateStr, groupId, userId, pigId) {
    if (!groupId) return false;
    const groupRolls = this.data.group_rolls;
    const dayRolls = (groupRolls[dateStr] = groupRolls[dateStr] || {});
    const groupRollMap = (dayRolls[groupId] = dayRolls[groupId] || {});
    const changed = groupRollMap[userId] !== pigId;
    groupRollMap[userId] = pigId;
    if (changed) {
      const seenAt = (this.data.group_roll_seen_at[dateStr] =
        this.data.group_roll_seen_at[dateStr] || {});
      const groupSeen = (seenAt[groupId] = seenAt[groupId] || {});
      if (!(userId in groupSeen)) groupSeen[userId] = nowIso();
    }
    const activeChanged = this._markGroupActiveUsers(dateStr, groupId, [userId]);
    return activeChanged || changed;
  }

  /**
   * 取得或创建今日抽猪记录。makeup=true 时只允许补签昨天。
   */
  getOrCreateDailyRoll(userId, proposedPigId, { dateStr = null, groupId = '', makeup = false } = {}) {
    const targetDate = dateStr || rollpigDateStr();
    userId = String(userId);
    if (makeup) {
      if (targetDate !== rollpigDateStr(-1)) throw new Error('只能补签昨天的小猪');
      groupId = '';
    }
    const history = this.data.history;
    const dayHistory = (history[targetDate] = history[targetDate] || {});
    const existingPigId = dayHistory[userId];

    if (existingPigId) {
      let dirty = false;
      if (groupId) dirty = this._recordGroupRoll(targetDate, groupId, userId, existingPigId);
      if (dirty) this._save();
      return this._buildExistingRollResult(userId, existingPigId);
    }

    dayHistory[userId] = proposedPigId;
    this._recordGroupRoll(targetDate, groupId, userId, proposedPigId);
    const result = this._applyCreatedRollProgress(userId, proposedPigId);
    this._attachCreatedSnapshot(userId, targetDate, result, makeup);

    if (!makeup) {
      // 激活等待该目标抽猪的预约
      for (const reservation of Object.values(this.data.roast_reservations)) {
        if (typeof reservation !== 'object' || !reservation) continue;
        if (
          reservation.date_str === targetDate &&
          reservation.target_id === userId &&
          reservation.status === 'pending'
        ) {
          reservation.status = 'ready';
          reservation.target_pig_id = proposedPigId;
          reservation.ready_at = nowIso();
        }
      }
    }
    this._save();
    return result;
  }

  _attachCreatedSnapshot(userId, dateStr, result, makeup) {
    const collectionSize = (this.data.collection[userId] || []).length;
    const snapshot = {
      pig_id: result.pig_id,
      is_makeup: !!makeup,
      is_new_pig: result.is_new_pig,
      previous_copies: result.previous_copies,
      copies_after_roll: result.copies,
      previous_expert_level: result.previous_expert_level,
      expert_level_after_roll: result.expert_level,
      collection_size_after_roll: collectionSize,
      created_at: nowIso(),
    };
    const snaps = (this.data.daily_roll_snapshots[dateStr] =
      this.data.daily_roll_snapshots[dateStr] || {});
    snaps[userId] = snapshot;
    result.snapshot = snapshot;
  }

  getDailyRollSnapshot(userId, dateStr) {
    const pigId = this.data.history[dateStr]?.[String(userId)];
    if (!pigId) return null;
    const raw = this.data.daily_roll_snapshots[dateStr]?.[String(userId)];
    if (!raw || typeof raw !== 'object') {
      return { date_str: dateStr, pig_id: String(pigId), outcome_available: false };
    }
    return { date_str: dateStr, ...raw, outcome_available: raw.copies_after_roll != null };
  }

  markGroupRollSeen(userId, pigId, groupId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    if (this._recordGroupRoll(target, groupId, String(userId), pigId)) this._save();
  }

  getGroupRolls(groupId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    return { ...(this.data.group_rolls[target]?.[String(groupId)] || {}) };
  }

  getActiveGroupIds(dateStr = null) {
    const target = dateStr || rollpigDateStr();
    return new Set(Object.keys(this.data.group_rolls[target] || {}));
  }

  // ================= 群日活 =================

  _groupActiveUsers(dateStr, groupId) {
    const raw = this.data.group_daily_active_users[dateStr]?.[String(groupId)];
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  }

  _markGroupActiveUsers(dateStr, groupId, userIds) {
    if (!groupId) return false;
    const current = this._groupActiveUsers(dateStr, groupId);
    const updated = new Set(current);
    for (const uid of userIds) if (uid) updated.add(String(uid));
    if (updated.size === current.size) return false;
    const dayMap = (this.data.group_daily_active_users[dateStr] =
      this.data.group_daily_active_users[dateStr] || {});
    const activeAtDay = (this.data.group_daily_active_at[dateStr] =
      this.data.group_daily_active_at[dateStr] || {});
    const activeAt = (activeAtDay[String(groupId)] = activeAtDay[String(groupId)] || {});
    const iso = nowIso();
    for (const uid of updated) if (!(uid in activeAt)) activeAt[uid] = iso;
    dayMap[String(groupId)] = [...updated].sort();
    return true;
  }

  markGroupActiveUsers(groupId, userIds, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    if (this._markGroupActiveUsers(target, String(groupId), userIds)) this._save();
  }

  getGroupActiveUserIds(groupId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    return this._groupActiveUsers(target, String(groupId));
  }

  // ================= 烤群友充能 =================

  consumeRoastCooldown(userId, { cooldownSeconds, maxCharges } = {}) {
    const cooldown = Math.max(60, Math.trunc(cooldownSeconds || 8 * 3600));
    const chargeMax = Math.max(1, Math.min(6, Math.trunc(maxCharges || 2)));
    const now = Date.now() / 1000;
    const usage = this.data.usage;
    let raw = usage[userId];
    let charges, updatedTs;
    if (raw && typeof raw === 'object') {
      charges = safeInt(raw.roast_charges, 0);
      updatedTs = Number(raw.roast_charge_updated_ts) || now;
    } else {
      // 旧单时间戳迁移：最近一次使用后视为还剩 1 格
      const lastUse = Number(raw) || 0;
      if (lastUse <= 0) {
        charges = chargeMax;
        updatedTs = now;
      } else {
        const recovered = Math.floor(Math.max(0, now - lastUse) / cooldown);
        charges = Math.min(chargeMax, 1 + recovered);
        updatedTs = charges >= chargeMax ? now : lastUse + recovered * cooldown;
      }
    }
    // 恢复
    if (charges < chargeMax) {
      const recovered = Math.floor(Math.max(0, now - updatedTs) / cooldown);
      if (recovered > 0) {
        charges = Math.min(chargeMax, charges + recovered);
        updatedTs = charges >= chargeMax ? now : updatedTs + recovered * cooldown;
      }
    } else {
      updatedTs = now;
    }

    const nextSeconds = () => {
      if (charges >= chargeMax) return 0;
      const elapsed = Math.max(0, now - updatedTs);
      return Math.max(1, Math.trunc(cooldown - (elapsed % cooldown)));
    };

    if (charges <= 0) {
      const remaining = nextSeconds();
      usage[userId] = {
        last_roast_ts: raw && typeof raw === 'object' ? raw.last_roast_ts : Number(raw) || 0,
        roast_charges: charges,
        roast_charge_updated_ts: updatedTs,
      };
      this._save();
      return {
        allowed: false,
        remaining_seconds: remaining,
        charges_left: 0,
        max_charges: chargeMax,
        next_recover_seconds: remaining,
      };
    }

    const wasFull = charges >= chargeMax;
    charges -= 1;
    if (wasFull) updatedTs = now;
    usage[userId] = {
      last_roast_ts: now,
      roast_charges: charges,
      roast_charge_updated_ts: updatedTs,
    };
    this._save();
    return {
      allowed: true,
      remaining_seconds: 0,
      charges_left: charges,
      max_charges: chargeMax,
      next_recover_seconds: nextSeconds(),
    };
  }

  /** 后门口令每日一次。 */
  consumeForceUsage(userId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    userId = String(userId);
    if (this.data.force_usage[userId] === target) return false;
    this.data.force_usage[userId] = target;
    this._save();
    return true;
  }

  /** 未抽猪先烤违规计数。 */
  recordUnrolledRoastAttempt(userId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    userId = String(userId);
    const day = (this.data.unrolled_roast_attempts[target] =
      this.data.unrolled_roast_attempts[target] || {});
    const count = Math.max(0, safeInt(day[userId], 0)) + 1;
    day[userId] = count;
    this._save();
    return { date_str: target, user_id: userId, count };
  }

  // ================= 加餐 =================

  _applyDailyFeed(dateStr, userId, sourceType, sourceId) {
    userId = String(userId);
    const pigId = this.data.history[dateStr]?.[userId];
    if (!pigId) return { status: 'no_pig', user_id: userId };
    const dayFeeds = (this.data.daily_feeds[dateStr] = this.data.daily_feeds[dateStr] || {});
    if (dayFeeds[userId]) {
      return { status: 'already_fed', user_id: userId, pig_id: String(pigId) };
    }
    const progress = this.data.pig_progress[userId]?.[pigId];
    if (!progress || typeof progress !== 'object') {
      return { status: 'no_progress', user_id: userId, pig_id: String(pigId) };
    }
    const copies = Math.max(1, safeInt(progress.copies, 1));
    const growthBonus = Math.max(0, safeInt(progress.growth_bonus, 0));
    const previousLevel = expertLevelFromCopies(copies, growthBonus);
    if (previousLevel >= MAX_EXPERT_LEVEL) {
      return { status: 'maxed', user_id: userId, pig_id: String(pigId) };
    }
    progress.growth_bonus = growthBonus + 1;
    const newLevel = expertLevelFromCopies(copies, progress.growth_bonus);
    const feed = {
      status: 'fed',
      user_id: userId,
      pig_id: String(pigId),
      previous_level: previousLevel,
      new_level: newLevel,
      source_type: sourceType,
      source_id: sourceId,
      created_at: nowIso(),
    };
    dayFeeds[userId] = feed;
    return feed;
  }

  // ================= 烤猪事件 =================

  appendRoastEvent(event, { settleDailyFeed = false } = {}) {
    const dateStr = rollpigDateStr();
    const dayEvents = (this.data.daily_events[dateStr] = this.data.daily_events[dateStr] || []);
    const record = {
      type: event.event_type,
      attacker: event.attacker_id,
      target: event.target_id,
      attacker_name: event.attacker_name || '',
      target_name: event.target_name || '',
      food: event.food || '',
      group_id: event.group_id || '',
      reservation_id: event.reservation_id || '',
      participant_ids: event.participant_ids || [],
      backfire_victim_id: event.backfire_victim_id || '',
      special_reason: event.special_reason || '',
      event_id: event.event_id || crypto.randomBytes(8).toString('hex'),
      created_at: event.created_at || nowIso(),
    };
    dayEvents.push(record);
    if (event.group_id) {
      const users = [event.attacker_id, ...(event.participant_ids || [])];
      if (event.event_type !== 'bot_backfire') users.push(event.target_id);
      this._markGroupActiveUsers(dateStr, event.group_id, users.filter(Boolean));
    }

    let feed = null;
    if (settleDailyFeed && event.event_type === 'success') {
      feed = this._applyDailyFeed(dateStr, event.attacker_id, 'roast', record.event_id);
    }
    this._save();
    return feed;
  }

  getDailyEvents({ dateStr = null, groupId = null, userId = null } = {}) {
    const target = dateStr || rollpigDateStr();
    let events = this.data.daily_events[target] || [];
    if (!Array.isArray(events)) return [];
    return events.filter((e) => {
      if (groupId != null && String(e.group_id) !== String(groupId)) return false;
      if (userId != null) {
        const involved = [e.attacker, e.target, ...(e.participant_ids || [])].map(String);
        if (!involved.includes(String(userId))) return false;
      }
      return true;
    });
  }

  countSuccessRoasted(userId, days = 7) {
    userId = String(userId);
    let count = 0;
    for (let i = 0; i < days; i++) {
      const d = rollpigDateStr(-i);
      const events = this.data.daily_events[d] || [];
      for (const e of events) {
        if (e.type === 'success' && String(e.target) === userId) count++;
      }
    }
    return count;
  }

  // ================= 保护 =================

  isProtected(groupId, userId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    const users = this.data.protected[target]?.[String(groupId)] || [];
    return users.map(String).includes(String(userId));
  }

  replaceGroupProtections(groupId, userIds, protectDate = null) {
    const target = protectDate || rollpigDateStr();
    const dayMap = (this.data.protected[target] = this.data.protected[target] || {});
    dayMap[String(groupId)] = userIds.map(String);
    this._save();
  }

  // ================= 图鉴快照 =================

  getCatalogSnapshot(userId, days = 14) {
    const drawState = this.getDrawState(userId);
    const recentRolls = {};
    for (let i = 0; i < days; i++) {
      const d = rollpigDateStr(-i);
      const pig = this.data.history[d]?.[String(userId)];
      if (pig) recentRolls[d] = pig;
    }
    const roasted7d = this.countSuccessRoasted(userId, 7);
    return { draw_state: drawState, recent_rolls: recentRolls, roasted_7d: roasted7d };
  }

  // ================= 预约烤猪 =================

  _reservationFromRaw(raw) {
    return {
      reservation_id: raw.reservation_id,
      date_str: raw.date_str,
      group_id: raw.group_id,
      target_id: raw.target_id,
      target_name: raw.target_name,
      owner_id: raw.owner_id,
      owner_name: raw.owner_name,
      owner_pig_id: raw.owner_pig_id,
      participants: (raw.participants || []).map((p) => ({
        user_id: String(p.user_id || ''),
        display_name: String(p.display_name || ''),
        pig_id: String(p.pig_id || ''),
      })),
      delivery_bot_id: raw.delivery_bot_id || '',
      force_mode: raw.force_mode ?? null,
      status: raw.status || 'pending',
      target_pig_id: raw.target_pig_id || '',
      participant_count: (raw.participants || []).length,
    };
  }

  _findPendingReservation(dateStr, groupId, targetId) {
    for (const raw of Object.values(this.data.roast_reservations)) {
      if (typeof raw !== 'object' || !raw) continue;
      if (
        raw.date_str === dateStr &&
        raw.group_id === groupId &&
        raw.target_id === targetId &&
        raw.status === 'pending'
      ) {
        return raw;
      }
    }
    return null;
  }

  _joinReservation(raw, userId, name, pigId) {
    const participants = (raw.participants = raw.participants || []);
    if (participants.some((p) => String(p.user_id) === userId)) {
      return { status: 'already_joined', reservation: this._reservationFromRaw(raw) };
    }
    if (participants.length >= ROAST_RESERVATION_MAX_PARTICIPANTS) {
      return { status: 'reservation_full', reservation: this._reservationFromRaw(raw) };
    }
    participants.push({ user_id: userId, display_name: name, pig_id: pigId });
    this._recordGroupRoll(raw.date_str, raw.group_id, userId, pigId);
    return { status: 'reservation_joined', reservation: this._reservationFromRaw(raw) };
  }

  /**
   * 原子完成目标检查、免费加入或扣资源创建预约。
   */
  prepareRoastReservation({
    attackerId,
    attackerName,
    attackerPigId,
    targetId,
    targetName,
    groupId,
    deliveryBotId,
    forceMode = null,
    dateStr = null,
    cooldownSeconds,
    maxCharges,
  }) {
    const targetDate = dateStr || rollpigDateStr();
    attackerId = String(attackerId);
    targetId = String(targetId);

    const targetPigId = this.data.history[targetDate]?.[targetId];
    const existing = this._findPendingReservation(targetDate, String(groupId), targetId);
    if (existing) {
      const result = this._joinReservation(existing, attackerId, String(attackerName), String(attackerPigId));
      if (result.status === 'reservation_joined') this._save();
      return result;
    }

    const protectedUsers = this.data.protected[targetDate]?.[String(groupId)] || [];
    const isProtected = protectedUsers.map(String).includes(targetId);
    const protectionBroken = isProtected && (forceMode === 'normal' || forceMode === 'super');
    if (isProtected && !protectionBroken) {
      return { status: 'protected' };
    }
    if (targetPigId) {
      return { status: 'target_ready', target_pig_id: String(targetPigId), protection_broken: protectionBroken };
    }

    let cooldownResult = null;
    if (forceMode === 'normal') {
      if (!this.consumeForceUsage(attackerId, targetDate)) return { status: 'force_denied' };
    } else if (forceMode !== 'super') {
      cooldownResult = this.consumeRoastCooldown(attackerId, { cooldownSeconds, maxCharges });
      if (!cooldownResult.allowed) return { status: 'cooldown_denied', cooldown: cooldownResult };
    }

    const reservationId = crypto.randomBytes(16).toString('hex');
    const raw = {
      reservation_id: reservationId,
      date_str: targetDate,
      group_id: String(groupId),
      target_id: targetId,
      target_name: String(targetName),
      owner_id: attackerId,
      owner_name: String(attackerName),
      owner_pig_id: String(attackerPigId),
      participants: [
        { user_id: attackerId, display_name: String(attackerName), pig_id: String(attackerPigId) },
      ],
      delivery_bot_id: String(deliveryBotId),
      force_mode: forceMode,
      status: 'pending',
      target_pig_id: '',
      created_at: nowIso(),
      messages: [],
    };
    this.data.roast_reservations[reservationId] = raw;
    this._markGroupActiveUsers(targetDate, String(groupId), [attackerId]);
    this._save();
    return {
      status: 'reservation_created',
      reservation: this._reservationFromRaw(raw),
      cooldown: cooldownResult,
      protection_broken: protectionBroken,
    };
  }

  bindRoastReservationMessage({ reservationId, botId, groupId, messageId, dateStr = null }) {
    const raw = this.data.roast_reservations[reservationId];
    const target = dateStr || rollpigDateStr();
    if (!raw || raw.group_id !== String(groupId) || raw.date_str !== target) return false;
    const reference = { bot_id: String(botId), message_id: String(messageId) };
    const messages = (raw.messages = raw.messages || []);
    if (!messages.some((m) => m.bot_id === reference.bot_id && m.message_id === reference.message_id)) {
      messages.push(reference);
      this._save();
    }
    return true;
  }

  joinRoastReservationByMessage({ botId, groupId, messageId, attackerId, attackerName, dateStr = null }) {
    const target = dateStr || rollpigDateStr();
    attackerId = String(attackerId);
    let raw = null;
    for (const item of Object.values(this.data.roast_reservations)) {
      if (typeof item !== 'object' || !item || item.group_id !== String(groupId)) continue;
      if ((item.messages || []).some((m) => m.bot_id === String(botId) && m.message_id === String(messageId))) {
        raw = item;
        break;
      }
    }
    if (!raw) return { status: 'message_not_found' };
    const history = this.data.history[target] || {};
    if (raw.date_str !== target || raw.status !== 'pending' || history[raw.target_id]) {
      return { status: 'reservation_closed' };
    }
    if (raw.target_id === attackerId) return { status: 'self_target' };
    const pigId = history[attackerId];
    if (!pigId) return { status: 'attacker_unrolled' };
    const result = this._joinReservation(raw, attackerId, String(attackerName), String(pigId));
    if (result.status === 'reservation_joined') this._save();
    return result;
  }

  /** 领取当前 Bot 当天待投递（ready）的预约。 */
  claimReadyReservations(deliveryBotId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    const claimed = [];
    for (const raw of Object.values(this.data.roast_reservations)) {
      if (typeof raw !== 'object' || !raw) continue;
      if (
        raw.date_str === target &&
        raw.delivery_bot_id === String(deliveryBotId) &&
        raw.status === 'ready'
      ) {
        raw.status = 'completed';
        raw.completed_at = nowIso();
        claimed.push(this._reservationFromRaw(raw));
      }
    }
    if (claimed.length) this._save();
    return claimed;
  }

  /** 预约成功结算时给参与者加餐。 */
  settleReservationFeeds(reservation) {
    const results = [];
    if (reservation.force_mode) return results;
    for (const p of reservation.participants) {
      const feed = this._applyDailyFeed(reservation.date_str, p.user_id, 'reservation', reservation.reservation_id);
      results.push(feed);
    }
    this._save();
    return results;
  }

  // ================= 烤箱续火 =================

  _expireRefill(raw, now) {
    if (raw.status !== 'voting') return false;
    const expiresAt = new Date(raw.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
    raw.status = 'expired';
    raw.failure_reason = 'expired';
    return true;
  }

  getGroupRoastRefill(groupId, dateStr = null) {
    const target = dateStr || rollpigDateStr();
    const now = Date.now();
    let changed = false;
    let found = null;
    for (const raw of Object.values(this.data.roast_refill_requests)) {
      if (typeof raw !== 'object' || !raw) continue;
      if (raw.date_str !== target || raw.group_id !== String(groupId)) continue;
      if (this._expireRefill(raw, now)) changed = true;
      if (raw.status === 'voting') found = raw;
    }
    if (changed) this._save();
    return found ? { ...found } : null;
  }

  prepareGroupRoastRefill({ groupId, initiatorId, initiatorName, deliveryBotId, eligibleUserIds = null, dateStr = null }) {
    const targetDate = dateStr || rollpigDateStr();
    const now = Date.now();
    let changed = false;

    for (const raw of Object.values(this.data.roast_refill_requests)) {
      if (typeof raw !== 'object' || !raw || raw.group_id !== String(groupId)) continue;
      if (this._expireRefill(raw, now)) changed = true;
      if (raw.status === 'voting') {
        if (changed) this._save();
        return { status: 'existing', request: { ...raw } };
      }
    }

    let activeSet = this._groupActiveUsers(targetDate, String(groupId));
    if (eligibleUserIds != null) {
      const eligible = new Set(eligibleUserIds.map(String));
      activeSet = new Set([...activeSet].filter((u) => eligible.has(u)));
    }
    const activeUserIds = [...activeSet].sort();
    if (activeUserIds.length < 3) {
      if (changed) this._save();
      return { status: 'insufficient_active', active_user_ids: activeUserIds };
    }

    let successCount = 0;
    for (const raw of Object.values(this.data.roast_refill_requests)) {
      if (
        typeof raw === 'object' &&
        raw &&
        raw.date_str === targetDate &&
        raw.group_id === String(groupId) &&
        raw.status === 'succeeded'
      ) {
        successCount++;
      }
    }
    const { ratio, requiredVotes } = roastRefillThreshold(activeUserIds.length, successCount);
    const requestId = crypto.randomBytes(16).toString('hex');
    const raw = {
      request_id: requestId,
      date_str: targetDate,
      group_id: String(groupId),
      initiator_id: String(initiatorId),
      initiator_name: String(initiatorName),
      delivery_bot_id: String(deliveryBotId),
      message_id: '',
      active_count_snapshot: activeUserIds.length,
      required_ratio: ratio,
      required_votes: requiredVotes,
      success_count_before: successCount,
      status: 'voting',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ROAST_REFILL_TTL_SECONDS * 1000).toISOString(),
      completed_at: '',
      benefited_user_ids: [],
      failure_reason: '',
    };
    this.data.roast_refill_requests[requestId] = raw;
    this._save();
    return { status: 'created', request: { ...raw }, active_user_ids: activeUserIds };
  }

  bindGroupRoastRefillMessage(requestId, messageId) {
    const raw = this.data.roast_refill_requests[requestId];
    if (!raw) return null;
    const now = Date.now();
    if (this._expireRefill(raw, now)) {
      this._save();
      return null;
    }
    if (raw.status !== 'voting') return null;
    raw.message_id = String(messageId);
    this._save();
    return { ...raw };
  }

  failGroupRoastRefill(requestId, reason) {
    const raw = this.data.roast_refill_requests[requestId];
    if (!raw || raw.status !== 'voting') return false;
    raw.status = 'failed';
    raw.failure_reason = reason;
    raw.completed_at = nowIso();
    this._save();
    return true;
  }

  /**
   * 补货成功：为本群今日活跃用户恢复烧烤次数至上限。
   */
  completeGroupRoastRefill({ requestId, voterIds, maxCharges = 2 }) {
    const raw = this.data.roast_refill_requests[requestId];
    if (!raw || raw.status !== 'voting') {
      return { completed: false, status: raw?.status || 'not_found' };
    }
    const chargeMax = Math.max(1, Math.min(6, Math.trunc(maxCharges)));
    const now = Date.now() / 1000;
    const activeUsers = this._groupActiveUsers(raw.date_str, raw.group_id);
    const benefited = [];
    for (const uid of activeUsers) {
      this.data.usage[uid] = {
        last_roast_ts: now,
        roast_charges: chargeMax,
        roast_charge_updated_ts: now,
      };
      benefited.push(uid);
    }
    raw.status = 'succeeded';
    raw.completed_at = nowIso();
    raw.benefited_user_ids = benefited.sort();
    this._save();
    return {
      completed: true,
      status: 'succeeded',
      request: { ...raw },
      benefited_user_ids: benefited,
      effective_votes: (voterIds || []).length,
    };
  }

  // ================= 清理 =================

  pruneHistory(daysToKeep = 14) {
    this._pruneDated('history', daysToKeep);
    this._pruneDated('daily_roll_snapshots', daysToKeep);
    this._pruneDated('group_rolls', daysToKeep);
    this._pruneDated('group_roll_seen_at', daysToKeep);
    this._pruneDated('daily_feeds', daysToKeep);
    this._pruneDated('protected', daysToKeep);
    this._pruneDated('unrolled_roast_attempts', daysToKeep);
    this._pruneDated('group_daily_active_users', daysToKeep);
    this._pruneDated('group_daily_active_at', daysToKeep);
    this._save();
  }

  pruneEvents(daysToKeep = 7) {
    this._pruneDated('daily_events', daysToKeep);
    this._save();
  }

  _pruneDated(key, daysToKeep) {
    const cutoff = rollpigDateStr(-daysToKeep);
    const bucket = this.data[key];
    if (!bucket || typeof bucket !== 'object') return;
    for (const dateStr of Object.keys(bucket)) {
      if (dateStr < cutoff) delete bucket[dateStr];
    }
  }
}

const store = new PigStore();
export default store;
