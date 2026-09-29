/**
 * QQBot 官方端按钮 / Markdown 支持。
 *
 * 背景：QQ 官方机器人（QQBot 适配器）支持消息按钮和 Markdown 排版；
 * OneBotv11 / ICQQ 等非官方端不支持，收到按钮段会忽略或降级。
 *
 * 本模块提供：
 * 1. isQQBot(e)        —— 判定当前事件是否来自 QQBot 官方端
 * 2. buildButtons(rows)—— 生成 segment.button 行数组
 * 3. withButtons(e,msg,rows) —— 仅在 QQBot 时追加按钮，其它端原样返回
 *
 * 按钮点击采用 callback 回填指令文本，复用现有命令正则（命令都兼容无 # 前缀）。
 */

/**
 * 判定事件是否来自 QQBot 官方适配器。
 */
export function isQQBot(e) {
  const adapterName = String(e?.bot?.adapter?.name || e?.bot?.adapter?.id || '').toLowerCase();
  if (adapterName.includes('qqbot')) return true;
  // 兼容部分实现把标识放在 version.id
  const versionId = String(e?.bot?.version?.id || '').toLowerCase();
  if (versionId.includes('qqbot')) return true;
  return false;
}

/**
 * 直接判定一个 Bot 实例是否来自 QQBot 官方适配器（定时推送无事件时使用）。
 */
export function isQQBotBot(bot) {
  const adapterName = String(bot?.adapter?.name || bot?.adapter?.id || '').toLowerCase();
  if (adapterName.includes('qqbot')) return true;
  const versionId = String(bot?.version?.id || '').toLowerCase();
  if (versionId.includes('qqbot')) return true;
  return false;
}

/**
 * 构造单个按钮。
 * @param {object} opt { text, cmd, link, input, enter, style, clickedText }
 *  - cmd:   回填并直接发送的指令（callback）
 *  - input: 回填到输入框但不自动发送
 *  - link:  跳转链接
 *  - enter: 配合 input 时是否自动发送（默认 false）
 *  - style: 0 灰色 / 1 蓝色（默认 0）
 */
export function button(opt) {
  const btn = {
    text: opt.text,
    style: opt.style ?? 0,
  };
  if (opt.clickedText) btn.clicked_text = opt.clickedText;
  if (opt.link) {
    btn.link = opt.link;
  } else if (opt.input != null) {
    btn.input = opt.input;
    if (opt.enter) btn.enter = true;
  } else if (opt.cmd != null) {
    // callback：点击后作为该用户消息回填并发送
    btn.callback = opt.cmd;
    btn.enter = true;
  }
  return btn;
}

/**
 * 生成按钮消息段。rows 为二维数组：[[btnOpt,...], [btnOpt,...]]
 * 每行最多 5 个按钮，最多 5 行（QQ 官方限制）。
 */
export function buildButtons(rows) {
  const square = [];
  for (const row of rows.slice(0, 5)) {
    const line = [];
    for (const opt of row.slice(0, 5)) {
      if (opt) line.push(button(opt));
    }
    if (line.length) square.push(line);
  }
  if (!square.length) return null;
  return segment.button(...square);
}

/**
 * 仅在 QQBot 端为消息追加按钮；其它端原样返回。
 * @param {object} e 事件
 * @param {any} msg 原消息（字符串 / 段 / 数组）
 * @param {Array} rows 按钮行定义
 * @returns 追加按钮后的消息数组（或原消息）
 */
export function withButtons(e, msg, rows) {
  if (!isQQBot(e) || !rows?.length) return msg;
  const btnSeg = buildButtons(rows);
  if (!btnSeg) return msg;
  const arr = Array.isArray(msg) ? [...msg] : [msg];
  arr.push(btnSeg);
  return arr;
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
  return segment.markdown({ content });
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
