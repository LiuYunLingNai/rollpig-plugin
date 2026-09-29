import plugin from '../../../lib/plugins/plugin.js';
import configControl from '../lib/model/config.js';
import { rollpigDateStr } from '../lib/model/runtime.js';

const ENABLE_WORDS = new Set(['开启', '打开', '启用', '开', 'on', 'enable', 'true']);
const DISABLE_WORDS = new Set(['关闭', '停用', '关', 'off', 'disable', 'false']);
const STATUS_WORDS = new Set(['状态', '查看', '查询', 'status', 'info']);

/**
 * 小猪日报群开关。日报默认关闭，需群主/管理员或主人开启。
 * 开关状态存储在插件 config.json 的 daily_report_groups 字段。
 */
export class RollPigControl extends plugin {
  constructor() {
    super({
      name: '小猪日报开关',
      dsc: '控制本群猪圈日报',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#?(小猪日报|每日总结设置|rollpig日报)\\s*(.*)$', fnc: 'dailyReportSwitch' },
        { reg: '^#?小猪(md|MD|markdown|Markdown|排版)\\s*(.*)$', fnc: 'markdownSwitch' },
      ],
    });
  }

  _getGroupStatus(groupId) {
    const cfg = configControl.get();
    const enabledMap = cfg.daily_report_groups || {};
    if (groupId in enabledMap) {
      return { enabled: !!enabledMap[groupId], source: enabledMap[groupId] ? '本群已开启' : '本群已关闭' };
    }
    const def = !!cfg.daily_summary_enabled;
    return { enabled: def, source: def ? '全局默认开启' : '全局默认关闭' };
  }

  _setGroupStatus(groupId, enabled) {
    const cfg = configControl.get();
    const map = { ...(cfg.daily_report_groups || {}) };
    map[groupId] = !!enabled;
    configControl.set('daily_report_groups', map);
  }

  _isManager(e) {
    if (e.isMaster) return true;
    const role = e.sender?.role || '';
    return role === 'owner' || role === 'admin';
  }

  async dailyReportSwitch(e) {
    const m = e.msg.match(/^#?(?:小猪日报|每日总结设置|rollpig日报)\s*(.*)$/i);
    const rawArg = m ? m[1].trim() : '';
    const tokens = rawArg.split(/\s+/).filter(Boolean);
    let action = 'status';
    let targetGroupId = '';
    for (const token of tokens) {
      const norm = token.toLowerCase();
      if (ENABLE_WORDS.has(norm)) action = 'enable';
      else if (DISABLE_WORDS.has(norm)) action = 'disable';
      else if (STATUS_WORDS.has(norm)) action = 'status';
      else if (/^\d+$/.test(token)) targetGroupId = token;
    }
    if (!targetGroupId && e.group_id) targetGroupId = String(e.group_id);
    if (!targetGroupId) {
      await e.reply('请在群内使用，或由主人指定群号：小猪日报 开启 123456', true);
      return true;
    }

    const formatStatus = (gid) => {
      const { enabled, source } = this._getGroupStatus(gid);
      return `小猪日报状态：${enabled ? '开启' : '关闭'}\n群号：${gid}\n来源：${source}`;
    };

    if (action === 'status') {
      if ((!e.group_id || String(e.group_id) !== targetGroupId) && !e.isMaster) {
        await e.reply('只有主人可以查看其他群的小猪日报状态。', true);
        return true;
      }
      await e.reply(formatStatus(targetGroupId), true);
      return true;
    }

    // enable / disable 需要权限
    const canControl =
      e.isMaster || (e.group_id && String(e.group_id) === targetGroupId && this._isManager(e));
    if (!canControl) {
      await e.reply('只有本群群主/管理员可以控制本群；控制其他群需要主人权限。', true);
      return true;
    }

    this._setGroupStatus(targetGroupId, action === 'enable');
    const label = action === 'enable' ? '开启' : '关闭';
    await e.reply(`已${label}群 ${targetGroupId} 的小猪日报。\n${formatStatus(targetGroupId)}`, true);
    return true;
  }

  /**
   * QQBot 端小猪详情排版开关（全局，仅主人可改）。
   * 关闭（默认）：沿用图文卡片截图；开启：图片 + Markdown 引用块。
   */
  async markdownSwitch(e) {
    const m = e.msg.match(/^#?小猪(?:md|markdown|排版)\s*(.*)$/i);
    const arg = (m ? m[1] : '').trim().toLowerCase();
    const current = !!configControl.get().qqbot_markdown_enabled;

    if (!arg || STATUS_WORDS.has(arg)) {
      await e.reply(
        `QQBot 小猪 Markdown 排版：${current ? '开启' : '关闭'}\n` +
          `（关闭=图文卡片截图；开启=图片+Markdown 引用块，仅 QQBot 官方端生效）\n` +
          `用法：小猪排版 开启 / 关闭`,
        true
      );
      return true;
    }
    if (!e.isMaster) {
      await e.reply('只有主人可以切换小猪 Markdown 排版。', true);
      return true;
    }
    let next;
    if (ENABLE_WORDS.has(arg)) next = true;
    else if (DISABLE_WORDS.has(arg)) next = false;
    else {
      await e.reply('参数无效，请用：小猪排版 开启 / 关闭', true);
      return true;
    }
    configControl.set('qqbot_markdown_enabled', next);
    await e.reply(
      `已${next ? '开启' : '关闭'} QQBot 小猪 Markdown 排版。\n` +
        `${next ? '现在 QQBot 端会用「图片+Markdown 引用块」。' : '现在统一使用图文卡片截图。'}`,
      true
    );
    return true;
  }
}
