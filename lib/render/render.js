import path from 'path';
import { pathToFileURL } from 'url';
import puppeteer from '../../../../lib/puppeteer/puppeteer.js';
import Path from '../../constants/path.js';
import resourceManager from '../resource/resourceManager.js';
import configControl from '../model/config.js';
import { MAX_EXPERT_LEVEL } from '../model/models.js';
import { rollpigDateStr } from '../model/runtime.js';

const HTML_DIR = path.join(Path.resource, 'html');
// 与原项目一致：图鉴只展示已拥有的小猪，每页 38 张
export const CATALOG_PAGE_SIZE = 38;
const NEW_BADGE_DAYS = 7;

/**
 * 把本地文件路径转成 file:// URL，供 puppeteer 模板 <img src> 使用。
 */
function fileUrl(p) {
  if (!p) return '';
  return pathToFileURL(String(p)).href;
}

/**
 * 解析渲染缩放（config.render_scale），限制在 1~4。
 */
function resolveScale() {
  const s = Number(configControl.get().render_scale);
  if (!Number.isFinite(s) || s <= 0) return 2;
  return Math.max(1, Math.min(4, s));
}

/**
 * 调用 Yunzai puppeteer 渲染器。
 * 注意：该 screenshot 返回的已经是 segment.image(...)（消息段），失败返回 false。
 */
async function screenshot(name, data) {
  if (!puppeteer?.screenshot) {
    throw new Error('Yunzai 渲染器不可用');
  }
  const seg = await puppeteer.screenshot(name, {
    scale: resolveScale(),
    ...data,
    pageGotoParams: { waitUntil: 'networkidle0' },
  });
  if (!seg) throw new Error('渲染器返回空结果');
  return seg;
}

/**
 * 渲染小猪卡片（今日小猪、烤猪结果等通用卡片）。
 * @param {object} pigData { name, description, analysis }
 * @param {string|null} imagePath 图片绝对路径
 * @param {number} exLevel EX 等级
 * @returns {Promise<Buffer>}
 */
export async function renderPigCard(pigData, imagePath, exLevel = 0) {
  return await screenshot('rollpig-card', {
    tplFile: path.join(HTML_DIR, 'pig_card.html'),
    avatar: fileUrl(imagePath),
    name: pigData.name || '未知小猪',
    desc: pigData.description || '',
    analysis: pigData.analysis || '',
    exLevel: Math.max(0, parseInt(exLevel, 10) || 0),
  });
}

/** 判断某次首次获得时间是否在近 NEW_BADGE_DAYS 天内（业务时区）。 */
function isRecentNew(firstObtainedAt) {
  if (!firstObtainedAt) return false;
  const ms = Date.parse(String(firstObtainedAt).replace('Z', '+00:00'));
  if (Number.isNaN(ms)) return false;
  // 转成业务日（UTC+8）当天零点
  const biz = new Date(ms + 8 * 3600 * 1000);
  const obtainedDay = Date.UTC(biz.getUTCFullYear(), biz.getUTCMonth(), biz.getUTCDate());
  const [ty, tm, td] = rollpigDateStr().split('-').map(Number);
  const todayDay = Date.UTC(ty, tm - 1, td);
  const diff = Math.floor((todayDay - obtainedDay) / 86400000);
  return diff >= 0 && diff < NEW_BADGE_DAYS;
}

/** 连续打卡天数：从今天往前数 recent_rolls 里连续存在的天数。 */
function calcCheckinStreak(recentRolls) {
  let streak = 0;
  for (let offset = 0; offset < 60; offset++) {
    if (!(rollpigDateStr(-offset) in recentRolls)) break;
    streak += 1;
  }
  return streak;
}

/** 下一个收集里程碑（每 10 只一档）。 */
function nextMilestone(unlocked, total) {
  if (total <= 0) return 0;
  if (unlocked >= total) return total;
  return Math.min(total, Math.max(10, (Math.floor(unlocked / 10) + 1) * 10));
}

/** 解析小猪立绘为 file:// URL（EX 差分优先，回退基础图）。 */
function resolvePigAvatar(pigId, level) {
  const pig = resourceManager.getPigById(pigId);
  if (!pig) return '';
  const appearance = resourceManager.resolvePigAppearance(pig, level || 0);
  return fileUrl(appearance.image_path || appearance.base_image_path || '');
}

/**
 * 渲染图片版图鉴（复刻原项目样式：仅展示已拥有小猪，按 EX/抽取次数排序，每页 38 张）。
 * @param {object} params { userName, snapshot, page }
 * @returns {Promise<segment>}
 */
export async function renderCatalogImage({ userName, snapshot, page = 1 }) {
  const drawState = snapshot.draw_state;
  const recentRolls = snapshot.recent_rolls || {};
  const roasted7d = snapshot.roasted_7d || 0;
  const total = resourceManager.pigList.length;
  const unlocked = drawState.pig_ids.length;

  // 资源顺序，用于同级同抽次时保持稳定排序
  const resourceOrder = new Map(resourceManager.pigList.map((p, i) => [String(p.id), i]));
  const progressEntries = Object.entries(drawState.progress);
  // 排序：EX 等级↓ → 抽取次数↓ → 首次获得时间↑ → 资源顺序 → id
  const sorted = progressEntries.slice().sort((a, b) => {
    const [aid, ap] = a;
    const [bid, bp] = b;
    if ((bp.expert_level || 0) !== (ap.expert_level || 0)) return (bp.expert_level || 0) - (ap.expert_level || 0);
    if ((bp.copies || 0) !== (ap.copies || 0)) return (bp.copies || 0) - (ap.copies || 0);
    const at = ap.first_obtained_at || '';
    const bt = bp.first_obtained_at || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return (resourceOrder.get(aid) ?? 1e9) - (resourceOrder.get(bid) ?? 1e9) || (aid < bid ? -1 : 1);
  });

  const totalPages = Math.max(1, Math.ceil(Math.max(1, unlocked) / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * CATALOG_PAGE_SIZE;
  const pageItems = sorted.slice(start, start + CATALOG_PAGE_SIZE);

  const levels = sorted.map(([, p]) => p.expert_level || 0);
  const maxLevel = levels.length ? Math.max(...levels) : 0;
  const maxedCount = levels.filter((l) => l >= MAX_EXPERT_LEVEL).length;
  const recentNewCount = sorted.filter(([, p]) => isRecentNew(p.first_obtained_at)).length;
  const percent = total > 0 ? Math.round((unlocked / total) * 1000) / 10 : 0;

  const cards = pageItems.map(([pigId, p], index) => {
    const level = p.expert_level || 0;
    const isMax = level >= MAX_EXPERT_LEVEL;
    const isNew = !isMax && isRecentNew(p.first_obtained_at);
    const pig = resourceManager.getPigById(pigId);
    // 网格坐标（对应原项目布局）：8 列，第 5 行整体右移一格
    const row = Math.floor(index / 8);
    let col = index % 8;
    if (row === 4) col += 1;
    return {
      name: pig ? String(pig.name || pigId) : pigId,
      avatar: resolvePigAvatar(pigId, level),
      level,
      badge: isMax ? 'MAX' : isNew ? 'NEW' : '',
      x: 104 + col * 161,
      y: 233 + row * 126,
    };
  });

  // 本命猪：按真实抽取次数最多
  let favorite = { name: '暂无', avatar: '', level: 0, copies: 0 };
  if (progressEntries.length) {
    const favEntry = progressEntries.slice().sort((a, b) => {
      if ((b[1].copies || 0) !== (a[1].copies || 0)) return (b[1].copies || 0) - (a[1].copies || 0);
      const at = a[1].first_obtained_at || '';
      const bt = b[1].first_obtained_at || '';
      if (at !== bt) return at < bt ? -1 : 1;
      return a[0] < b[0] ? -1 : 1;
    })[0];
    const [favId, favP] = favEntry;
    const favPig = resourceManager.getPigById(favId);
    favorite = {
      name: favPig ? String(favPig.name || favId) : favId,
      avatar: resolvePigAvatar(favId, favP.expert_level || 0),
      level: favP.expert_level || 0,
      copies: favP.copies || 0,
    };
  }

  return await screenshot('rollpig-catalog', {
    tplFile: path.join(HTML_DIR, 'catalog.html'),
    fontSans: fileUrl(path.join(Path.fonts, 'SourceHanSansSC-Medium.otf')),
    bg: fileUrl(path.join(Path.resource, 'catalog_base.jpg')),
    userName,
    unlocked,
    total,
    percent: percent.toFixed(1),
    maxLevel,
    maxedCount,
    recentNewCount,
    checkinStreak: calcCheckinStreak(recentRolls),
    roasted7d,
    nextMilestone: nextMilestone(unlocked, total),
    page: currentPage,
    totalPages,
    cards,
    favorite,
  });
}

/**
 * 渲染猪圈日报卡片（报纸风格）。
 * @param {object} cardData buildDailyReportCardData 的输出
 * @returns {Promise<segment>} Yunzai 图片消息段
 */
export async function renderDailyReportImage(cardData) {
  // 排行头像的绝对路径转 file:// URL 供模板 <img> 使用
  const rankings = (cardData.rankings || []).map((col) => ({
    ...col,
    entries: (col.entries || []).map((en) => ({ ...en, avatar: fileUrl(en.avatar) })),
  }));
  return await screenshot('rollpig-daily-report', {
    tplFile: path.join(HTML_DIR, 'daily_report.html'),
    fontSans: fileUrl(path.join(Path.fonts, 'SourceHanSansSC-Medium.otf')),
    ...cardData,
    rankings,
  });
}

const YESTERDAY_FOOTPRINT_ICONS = {
  success_count: '🔥',
  roasted_count: '🍖',
  escaped_count: '🏃',
  backfire_count: '💥',
  self_roast_count: '🪤',
  bot_backfire_count: '🤖',
  reservation_result_count: '📋',
};

/**
 * 渲染昨日回顾卡片。
 * @param {object} recap buildYesterdayRecap 的输出
 * @returns {Promise<segment>}
 */
export async function renderYesterdayRecapImage(recap) {
  const cardDir = path.join(Path.resource, 'yesterday_card');
  const asset = (name) => fileUrl(path.join(cardDir, name));
  const avatar = fileUrl(recap.image_path || recap.fallback_image_path || '');
  const footprints = (recap.footprints || []).map((f) => ({
    label: f.label,
    count: f.count,
    icon: YESTERDAY_FOOTPRINT_ICONS[f.kind] || '🐷',
  }));
  return await screenshot('rollpig-yesterday', {
    tplFile: path.join(HTML_DIR, 'yesterday.html'),
    fontSans: fileUrl(path.join(Path.fonts, 'SourceHanSansSC-Medium.otf')),
    bg: asset('pink_dream.jpg'),
    dividerHighlight: asset('highlight_divider@4x.png'),
    dividerSummary: asset('summary_divider@4x.png'),
    iconBook: asset('header_book@4x.png'),
    iconShield: asset('shield@4x.png'),
    avatar,
    pigName: recap.pig_name || '未知小猪',
    exLevel: recap.ex_level || 0,
    outcomeText: recap.outcome_text || '',
    dateStr: recap.date_str || '',
    scopeText: recap.scope === 'group' ? '本群' : '跨群',
    footprints,
    experiences: (recap.experiences || []).map((e) => e.text),
    summaryText: recap.summary ? recap.summary.text : '',
    aftereffectText: recap.aftereffect_text || '',
    isMakeup: !!recap.is_makeup,
    pigDesc: recap.pig_description || '',
  });
}

/**
 * 渲染本周小猪长图。
 * @param {Array<{day:string, imagePath:string}>} entries
 * @returns {Promise<Buffer>}
 */
export async function renderWeeklyImage(entries) {
  const items = entries.map((e) => ({
    day: e.day,
    avatar: fileUrl(e.imagePath),
  }));
  return await screenshot('rollpig-weekly', {
    tplFile: path.join(HTML_DIR, 'weekly.html'),
    fontSans: fileUrl(path.join(Path.fonts, 'SourceHanSansSC-Medium.otf')),
    bg: fileUrl(path.join(Path.resource, 'yesterday_card', 'pink_dream.jpg')),
    subtitle: `你这周变了 ${items.length} 次猪！`,
    items,
  });
}
