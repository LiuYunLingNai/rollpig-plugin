import { logger } from '../host/index.js';
import { CommandGroup } from '../lib/flow/base.js';
import configControl from '../lib/model/config.js';
import { rollpigDateStr } from '../lib/model/runtime.js';
import { buildGroupReportSegment } from '../lib/flow/dailyReportJob.js';
import { withButtons, DAILY_REPORT_BUTTONS } from '../lib/flow/qqbot.js';
import { quoteFlag, reply } from '../lib/flow/reply.js';

const ENABLE_WORDS = new Set(['开启', '打开', '启用', '开', 'on', 'enable', 'true']);
const DISABLE_WORDS = new Set(['关闭', '停用', '关', 'off', 'disable', 'false']);
const STATUS_WORDS = new Set(['状态', '查看', '查询', 'status', 'info']);

/**
 * 小猪日报群开关。日报默认关闭，需群主/管理员或主人开启。
 * 开关状态由 NG 配置中的 daily_report_groups 字段保存。
 */
export class RollPigControl extends CommandGroup {
  constructor() {
    super({
      name: '小猪日报开关',
      dsc: '控制本群猪圈日报',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^[#/]?(日报状态|每日总结设置|rollpig日报)\\s*(.*)$', fnc: 'dailyReportSwitch' },
        { reg: '^[#/]?(小猪日报|生成日报|生成小猪日报|预览日报|日报预览)\\s*(\\S*)$', fnc: 'dailyReportPreview' },
        { reg: '^[#/]?小猪(md|MD|markdown|Markdown|排版)\\s*(.*)$', fnc: 'markdownSwitch' },
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

  async _setGroupStatus(groupId, enabled) {
    const cfg = configControl.get();
    const map = { ...(cfg.daily_report_groups || {}) };
    map[groupId] = !!enabled;
    await configControl.set('daily_report_groups', map);
  }

  _isManager(e) {
    return e.isMaster || e.isGroupAdmin || e.isGroupOwner;
  }

  async dailyReportSwitch(e) {
    const m = e.text.match(/^[#/]?(?:日报状态|每日总结设置|rollpig日报)\s*(.*)$/i);
    const rawArg = m ? m[1].trim() : '';
    const tokens = rawArg.split(/\s+/).filter(Boolean);
    let action = 'status';
    let targetGroupId = '';
    for (const token of tokens) {
      const norm = token.toLowerCase();
      if (ENABLE_WORDS.has(norm)) action = 'enable';
      else if (DISABLE_WORDS.has(norm)) action = 'disable';
      else if (STATUS_WORDS.has(norm)) action = 'status';
      else targetGroupId = token;
    }
    if (!targetGroupId && e.group?.gid) targetGroupId = String(e.group?.gid);
    if (!targetGroupId) {
      await reply(e, '请在群内使用，或由主人指定群号：日报状态 开启 123456', quoteFlag());
      return true;
    }

    const formatStatus = (gid) => {
      const { enabled, source } = this._getGroupStatus(gid);
      return `小猪日报状态：${enabled ? '开启' : '关闭'}\n群号：${gid}\n来源：${source}`;
    };

    if (action === 'status') {
      if ((!e.group?.gid || String(e.group?.gid) !== targetGroupId) && !e.isMaster) {
        await reply(e, '只有主人可以查看其他群的小猪日报状态。', quoteFlag());
        return true;
      }
      await reply(e, formatStatus(targetGroupId), quoteFlag());
      return true;
    }

    // enable / disable 需要权限
    const canControl =
      e.isMaster || (e.group?.gid && String(e.group?.gid) === targetGroupId && this._isManager(e));
    if (!canControl) {
      await reply(e, '只有本群群主/管理员可以控制本群；控制其他群需要主人权限。', quoteFlag());
      return true;
    }

    await this._setGroupStatus(targetGroupId, action === 'enable');
    const label = action === 'enable' ? '开启' : '关闭';
    await reply(e, `已${label}群 ${targetGroupId} 的小猪日报。\n${formatStatus(targetGroupId)}`, quoteFlag());
    return true;
  }

  /**
   * 手动生成/预览本群猪圈日报（不写入次日保护，仅出图）。
   * 群主/管理员或主人可用；主人可带群号预览其他群。
   */
  async dailyReportPreview(e) {
    const m = e.text.match(/^[#/]?(?:小猪日报|生成日报|生成小猪日报|预览日报|日报预览)\s*(\S*)$/);
    let targetGroupId = m && m[1] ? m[1] : '';
    if (!targetGroupId && e.group?.gid) targetGroupId = String(e.group?.gid);
    if (!targetGroupId) {
      await reply(e, '请在群内使用，或由主人指定群号：小猪日报 123456', quoteFlag());
      return true;
    }

    const canControl =
      e.isMaster || (e.group?.gid && String(e.group?.gid) === targetGroupId && this._isManager(e));
    if (!canControl) {
      await reply(e, '只有本群群主/管理员可以生成本群日报；生成其他群需要主人权限。', quoteFlag());
      return true;
    }

    const quote = quoteFlag();
    await reply(e, '正在生成今日猪圈日报，请稍候…', quote);
    try {
      const { status, seg } = await buildGroupReportSegment(targetGroupId, {
        dateStr: rollpigDateStr(),
        writeProtection: false,
      });
      if (status === 'empty') {
        await reply(e, '今天这个群还没有可展示的活动（没人抽猪 / 没有烤猪记录）。', quote);
        return true;
      }
      await reply(e, withButtons(e, seg, DAILY_REPORT_BUTTONS), quote);
    } catch (err) {
      logger?.error?.(`[今日小猪] 手动生成日报失败 group=${targetGroupId}: ${err}`);
      await reply(e, `生成日报失败：${err.message || err}`, quote);
    }
    return true;
  }

  /**
   * 小猪详情排版开关（全局，仅主人可改），按 NG Markdown 能力生效。
   * 关闭（默认）：沿用图文卡片截图；开启：图片 + Markdown 引用块。
   */
  async markdownSwitch(e) {
    const m = e.text.match(/^[#/]?小猪(?:md|markdown|排版)\s*(.*)$/i);
    const arg = (m ? m[1] : '').trim().toLowerCase();
    const current = !!configControl.get().qqbot_markdown_enabled;

    if (!arg || STATUS_WORDS.has(arg)) {
      await reply(e,
        `小猪 Markdown 排版：${current ? '开启' : '关闭'}\n` +
          `（关闭=图文卡片截图；开启=图片+Markdown 引用块，需适配器支持 Markdown）\n` +
          `用法：小猪排版 开启 / 关闭`,
        quoteFlag()
      );
      return true;
    }
    if (!e.isMaster) {
      await reply(e, '只有主人可以切换小猪 Markdown 排版。', quoteFlag());
      return true;
    }
    let next;
    if (ENABLE_WORDS.has(arg)) next = true;
    else if (DISABLE_WORDS.has(arg)) next = false;
    else {
      await reply(e, '参数无效，请用：小猪排版 开启 / 关闭', quoteFlag());
      return true;
    }
    await configControl.set('qqbot_markdown_enabled', next);
    await reply(e,
      `已${next ? '开启' : '关闭'}小猪 Markdown 排版。\n` +
        `${next ? '支持 Markdown 的适配器会用「图片+Markdown 引用块」。' : '现在统一使用图文卡片截图。'}`,
      quoteFlag()
    );
    return true;
  }
}
