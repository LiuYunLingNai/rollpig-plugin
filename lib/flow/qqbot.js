/**
 * 官方机器人端的按钮 / Markdown 支持（QQBot + 钉钉）。
 *
 * 背景：QQ 官方机器人（QQBot 适配器）与钉钉机器人（DingTalk-Plugin）都支持
 * 消息按钮和 Markdown 排版；OneBotv11 / ICQQ 等非官方端不支持，
 * 收到按钮段会忽略或降级。
 *
 * 适配器兼容：本模块统一走 `segment.button()`（miao 原生风格），
 * QQBot-Plugin / Lain-plugin 的 QQBot 适配器与 DingTalk-Plugin 都实现了该 API
 * 且字段映射一致（text/callback/input/link/style），因此同一份按钮定义多端通用，
 * 不会互相冲突。这里只负责“发出去”，按钮如何渲染由各适配器自行处理：
 * - QQBot：原生按钮 / Markdown
 * - 钉钉：ActionCard，或配置 cardTemplateId 后转互动卡片
 * 差异仅在“如何判定当前是不是这类端”，见下方适配器白名单。
 *
 * 本模块提供：
 * 1. isRichAdapter(e)  —— 判定当前事件是否来自白名单内的适配器
 * 2. buildButtons(rows)—— 生成 segment.button 行数组
 * 3. withButtons(e,msg,rows) —— 仅在白名单端追加按钮，其它端原样返回
 *
 * 按钮点击采用 callback 回填指令文本，复用现有命令正则（命令都兼容无 # 前缀）。
 */

/**
 * 适配器白名单：支持 Markdown 正文与按钮消息段的适配器标识。
 * 取子串匹配，因此 'QQBot' / 'dingtalk' / 'DingDing' 都能命中。
 */
const RICH_ADAPTERS = ['qqbot', 'dingtalk', 'dingding'];

/** 从 adapter 描述（字符串 或 { id, name }）取出用于比对的标识串 */
function adapterKey(adapter) {
  return String(
    (typeof adapter === 'string' ? adapter : adapter?.name || adapter?.id) || '',
  ).toLowerCase();
}

/** 标识串是否命中适配器白名单 */
function inWhitelist(key) {
  return RICH_ADAPTERS.some((name) => key.includes(name));
}

/**
 * 判定事件是否来自支持 Markdown / 按钮的适配器（QQBot、钉钉）。
 *
 * 兼容各适配器的标识方式：
 * - TRSS QQBot-Plugin：bot.adapter 是对象，name/id === 'QQBot'
 * - Lain-plugin（喵崽常用）：事件上直接 e.adapter = 'QQBot'，bot.adapter 是字符串
 * - DingTalk-Plugin：bot.adapter 是对象 { id:'DingDing', name:'DingTalk' }，
 *   事件上另由 lib/bot.js 注入 e.adapter_id / e.adapter_name
 */
export function isRichAdapter(e) {
  // Lain-plugin 在事件对象上直接标记 e.adapter
  if (inWhitelist(String(e?.adapter || '').toLowerCase())) return true;
  // 框架统一注入的 adapter 标识（钉钉事件走这里）
  if (inWhitelist(`${e?.adapter_name || ''} ${e?.adapter_id || ''}`.toLowerCase())) return true;
  return isRichAdapterBot(e?.bot);
}

/**
 * 直接判定一个 Bot 实例是否来自白名单适配器（定时推送无事件时使用）。
 * adapter 既可能是对象（TRSS/钉钉：{ name/id }），也可能是字符串（Lain）。
 */
export function isRichAdapterBot(bot) {
  if (inWhitelist(adapterKey(bot?.adapter))) return true;
  if (inWhitelist(String(bot?.version?.name || '').toLowerCase())) return true;
  if (inWhitelist(String(bot?.version?.id || '').toLowerCase())) return true;
  return false;
}

/** @deprecated 名称保留供既有调用方使用，语义已扩展为「白名单适配器」，见 isRichAdapter。 */
export const isQQBot = isRichAdapter;

/** @deprecated 名称保留供既有调用方使用，见 isRichAdapterBot。 */
export const isQQBotBot = isRichAdapterBot;

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
    // 显式声明是否自动发送：Lain-plugin 对 input(type=2) 默认 enter=true 会直接把
    // 半截文本（如“找猪 ”）发出去，这里默认 false 保持“仅回填输入框”的语义。
    btn.enter = opt.enter ? true : false;
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
 * @returns {Array} 展平后的消息段数组（Lain 的 getQQBot 只按 i.type 处理顶层段，
 *   若把 segment.button() 的返回值整个塞进消息数组会形成嵌套数组被静默丢弃，
 *   因此这里统一返回“可直接展开进消息数组”的扁平段数组）。
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
  if (!square.length) return [];
  const seg = segment.button(...square);
  if (!seg) return [];
  return Array.isArray(seg) ? seg : [seg];
}

/**
 * 仅在白名单适配器（QQBot / 钉钉）为消息追加按钮；其它端原样返回。
 * 按钮如何渲染由适配器决定：QQBot 用原生按钮，钉钉转 ActionCard / 互动卡片。
 * @param {object} e 事件
 * @param {any} msg 原消息（字符串 / 段 / 数组）
 * @param {Array} rows 按钮行定义
 * @returns 追加按钮后的消息数组（或原消息）
 */
export function withButtons(e, msg, rows) {
  if (!isQQBot(e) || !rows?.length) return msg;
  const btnSegs = buildButtons(rows);
  if (!btnSegs.length) return msg;
  const arr = Array.isArray(msg) ? [...msg] : [msg];
  // 展开追加，避免形成嵌套数组（Lain 会丢弃嵌套数组里的按钮）
  arr.push(...btnSegs);
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
