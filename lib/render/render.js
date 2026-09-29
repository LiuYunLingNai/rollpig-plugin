import path from 'path';
import { pathToFileURL } from 'url';
import puppeteer from '../../../../lib/puppeteer/puppeteer.js';
import Path from '../../constants/path.js';
import resourceManager from '../resource/resourceManager.js';
import { rollpigToday } from '../model/runtime.js';

const HTML_DIR = path.join(Path.resource, 'html');
const CATALOG_PAGE_SIZE = 40;

/**
 * 把本地文件路径转成 file:// URL，供 puppeteer 模板 <img src> 使用。
 */
function fileUrl(p) {
  if (!p) return '';
  return pathToFileURL(String(p)).href;
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

/**
 * 渲染图片版图鉴。
 * @param {object} params { userName, snapshot, page }
 * @returns {Promise<Buffer>}
 */
export async function renderCatalogImage({ userName, snapshot, page = 1 }) {
  const drawState = snapshot.draw_state;
  const recentRolls = snapshot.recent_rolls || {};
  const allPigs = resourceManager.pigList;
  const total = allPigs.length;
  const unlockedSet = new Set(drawState.pig_ids);
  const unlockedCount = unlockedSet.size;

  const totalPages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * CATALOG_PAGE_SIZE;
  const pageItems = allPigs.slice(start, start + CATALOG_PAGE_SIZE);

  const today = rollpigToday();
  const recentPigIds = new Set(Object.values(recentRolls));

  let maxLevel = 0;
  for (const pid of drawState.pig_ids) {
    const lv = drawState.progress[pid]?.expert_level || 0;
    if (lv > maxLevel) maxLevel = lv;
  }

  const items = pageItems.map((pig) => {
    const pigId = String(pig.id);
    const owned = unlockedSet.has(pigId);
    const progress = drawState.progress[pigId];
    const level = progress ? progress.expert_level : 0;
    return {
      name: owned ? pig.name : '？？？',
      avatar: owned ? fileUrl(resourceManager.findImageFile(pigId)) : '',
      owned,
      level,
      isNew: owned && recentPigIds.has(pigId),
    };
  });

  return await screenshot('rollpig-catalog', {
    tplFile: path.join(HTML_DIR, 'catalog.html'),
    userName,
    unlocked: unlockedCount,
    total,
    percent: total > 0 ? Math.floor((unlockedCount / total) * 100) : 0,
    maxLevel,
    streak: drawState.duplicate_streak,
    page: currentPage,
    totalPages,
    items,
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
    subtitle: `你这周变了 ${items.length} 次猪！`,
    items,
  });
}
