import { segment, hostKind } from '../../host/index.js';

/** Markdown 详情和按钮根据 NG 适配器能力声明，不识别旧宿主全局。 */
export function isRichAdapter(e) { return isRichAdapterBot(e.bot); }
export function isRichAdapterBot(bot) { return Boolean(bot?.caps?.has('markdown')); }
export const isQQBot = isRichAdapter;
export const isQQBotBot = isRichAdapterBot;

export function button(opt) {
  return {
    ...(hostKind() === 'trss' ? { style: opt.style ?? 0 } : {}),
    label: opt.text,
    visitedLabel: opt.clickedText,
    action: opt.link ? 'link' : 'input',
    data: opt.link ?? opt.input ?? opt.cmd,
    enter: opt.cmd != null || Boolean(opt.enter),
  };
}

export function buildButtons(rows) {
  const square = rows.slice(0, 5).map(row => row.slice(0, 5).filter(Boolean).map(button)).filter(row => row.length);
  return square.length ? [segment.keyboard(square)] : [];
}

export function withButtons(e, content, rows) {
  if (!e.bot.caps.has('keyboard') || !rows?.length) return content;
  return [content, ...buildButtons(rows)];
}

// ================= 常用按钮布局 =================

/** 主功能面板按钮（今日小猪等卡片下方）。 */
export const PANEL_BUTTONS = [
  [
    { text: '🐷 今日小猪', cmd: '今日小猪', style: 1 },
    { text: '🔥 今日烤猪', cmd: '今日烤猪' },
  ],
  [
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
    { text: '🖼 小猪图鉴', cmd: '小猪图鉴' },
  ],
  [
    { text: '🎲 随机小猪', cmd: '随机小猪' },
    { text: '📅 昨日小猪', cmd: '昨日小猪' },
    { text: '🔮 明日小猪', cmd: '明日小猪' },
  ],
];

/** 帮助面板按钮。 */
export const HELP_BUTTONS = [
  [
    { text: '🐷 今日小猪', cmd: '今日小猪', style: 1 },
    { text: '🔥 今日烤猪', cmd: '今日烤猪' },
  ],
  [
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
    { text: '🖼 小猪图鉴', cmd: '小猪图鉴' },
    { text: '📆 本周小猪', cmd: '本周小猪' },
  ],
  [
    { text: '🎲 随机小猪', cmd: '随机小猪' },
    { text: '🔮 明日小猪', cmd: '明日小猪' },
    { text: '📅 昨日小猪', cmd: '昨日小猪' },
  ],
  [
    { text: '🍖 随机烤猪', cmd: '随机烤猪' },
    { text: '🧰 烤箱续火', cmd: '烤箱续火' },
    { text: '🔎 找猪', input: '找猪 ' },
  ],
];

/** 图鉴翻页按钮。 */
export function catalogButtons(currentPage, totalPages) {
  const row = [];
  if (currentPage > 1) row.push({ text: '⬅ 上一页', cmd: `小猪图鉴 ${currentPage - 1}` });
  if (currentPage < totalPages) row.push({ text: '下一页 ➡', cmd: `小猪图鉴 ${currentPage + 1}` });
  const rows = [];
  if (row.length) rows.push(row);
  rows.push([
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
    { text: '🐷 今日小猪', cmd: '今日小猪', style: 1 },
  ]);
  return rows;
}

/** 烤猪结果下方按钮。 */
export const ROAST_BUTTONS = [
  [
    { text: '🎲 随机再烤', cmd: '随机烤猪', style: 1 },
    { text: '🐷 今日小猪', cmd: '今日小猪' },
  ],
  [
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
    { text: '🧰 烤箱续火', cmd: '烤箱续火' },
  ],
];

/** 烤箱续火·活跃小猪不足时的引导按钮：先把猪圈热起来，凑够活跃数再来续火。 */
export const ROAST_REFILL_GUIDE_BUTTONS = [
  [
    { text: '🐷 今日小猪', cmd: '今日小猪', style: 1 },
    { text: '🔥 今日烤猪', cmd: '今日烤猪' },
  ],
  [
    { text: '🍖 随机烤猪', cmd: '随机烤猪' },
    { text: '🧰 再试续火', cmd: '烤箱续火' },
  ],
];

/** 随机小猪下方按钮。 */
export const RANDOM_BUTTONS = [
  [
    { text: '🎲 再来一张', cmd: '随机小猪', style: 1 },
    { text: '🐷 今日小猪', cmd: '今日小猪' },
  ],
  [
    { text: '🔎 找猪', input: '找猪 ' },
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
  ],
];

/** 找猪下方按钮。 */
export const SEARCH_BUTTONS = [
  [
    { text: '🔎 换个词找', input: '找猪 ' },
    { text: '🎲 随机小猪', cmd: '随机小猪', style: 1 },
  ],
  [
    { text: '🐷 今日小猪', cmd: '今日小猪' },
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
  ],
];

/** 猪圈日报下方按钮。 */
export const DAILY_REPORT_BUTTONS = [
  [
    { text: '🐷 今日小猪', cmd: '今日小猪', style: 1 },
    { text: '🔥 今日烤猪', cmd: '今日烤猪' },
  ],
  [
    { text: '📖 我的猪圈', cmd: '我的猪圈' },
    { text: '🖼 小猪图鉴', cmd: '小猪图鉴' },
    { text: '📆 本周小猪', cmd: '本周小猪' },
  ],
  [
    { text: '🍖 随机烤猪', cmd: '随机烤猪' },
    { text: '📊 小猪日报', cmd: '小猪日报' },
  ],
];

// ================= Markdown =================

/**
 * 生成 Markdown 消息段（原生 Markdown，需 QQBot 后台配置支持）。
 * 大多数 QQBot 使用「模板 Markdown」，原生 Markdown 需申请；这里提供原生文本型。
 */
export function markdown(content) {
  return segment.markdown(content);
}

/**
 * 把多行文字拼成 QQ Markdown 引用块（左侧竖线样式）。
 * QQ Markdown 用 `\r` 换行，每行以 `> ` 开头即为引用。空行用 `> ` 维持竖线连续。
 * @param {string} text 原始文字（含 \n 换行）
 * @returns {string} 引用块 markdown 文本
 */
export function quoteBlock(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  return lines.map((line) => (line.length ? `> ${line}` : '> ')).join('\r');
}

/**
 * 构造「小猪详情」的 Markdown 文字：标题加粗，描述与分析放进引用块。
 * 图片由适配器（raw markdown 模式）自动内嵌，这里只负责文字部分。
 * @param {object} pigData { name, description, analysis }
 * @param {object} opt { exLevel, heading } heading 为顶部提示行（如成长文案）
 * @returns {string}
 */
export function buildPigDetailMarkdown(pigData, { exLevel = 0, heading = '' } = {}) {
  const parts = [];
  if (heading) parts.push(String(heading).replace(/[\r\n]+$/, ''));
  const name = pigData?.name || '未知小猪';
  const level = Math.max(0, parseInt(exLevel, 10) || 0);
  parts.push(level > 0 ? `**【${name}】** EX Lv.${level}` : `**【${name}】**`);

  const quoteLines = [];
  if (pigData?.description) quoteLines.push(String(pigData.description));
  if (pigData?.analysis) {
    if (quoteLines.length) quoteLines.push('');
    quoteLines.push(String(pigData.analysis));
  }
  if (quoteLines.length) parts.push(quoteBlock(quoteLines.join('\n')));
  return parts.join('\r');
}
