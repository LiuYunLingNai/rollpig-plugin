import plugin from '../../../lib/plugins/plugin.js';
import { segment } from 'oicq';
import store from '../lib/store/store.js';
import resourceManager from '../lib/resource/resourceManager.js';
import { renderPigCard, renderYesterdayRecapImage } from '../lib/render/render.js';
import { resolveDailyPig, ensureYesterdayPig, RECORDED_PIG_RESOURCE_MISSING_TEXT } from '../lib/flow/rollFlow.js';
import { getEventGroupId, getEventUserName } from '../lib/flow/helpers.js';
import { deliverReadyReservations } from '../lib/flow/reservationFlow.js';
import { buildYesterdayRecap } from '../lib/flow/yesterdayRecap.js';
import { rollpigDateStr } from '../lib/model/runtime.js';
import * as T from '../lib/model/texts.js';
import pighub from '../lib/flow/pighub.js';
import {
  withButtons,
  PANEL_BUTTONS,
  RANDOM_BUTTONS,
  SEARCH_BUTTONS,
  isQQBot,
  buildPigDetailMarkdown,
} from '../lib/flow/qqbot.js';
import { syncBaseResource, syncGifOverlay, getSyncState } from '../lib/resource/resourceSync.js';
import configControl from '../lib/model/config.js';
import { quoteFlag } from '../lib/flow/reply.js';

/**
 * 发送小猪卡片。
 * - 非 QQBot 端：puppeteer 渲染整卡（图文合一）。
 * - QQBot 端：图片单独发，名称/描述/分析放进 Markdown 引用块，末尾追加功能按钮。
 */
async function sendRenderedPig(e, pigData, { extraText = '', trailingText = '', exLevel = 0, buttons = PANEL_BUTTONS } = {}) {
  const appearance = resourceManager.resolvePigAppearance(pigData, exLevel);
  const renderData = appearance.pig_data;
  const imagePath = appearance.image_path;

  // QQBot 端且开启 Markdown 格式：只发「图片段 + 引用块文字 + 按钮」，
  // 交给 QQBot-Plugin 适配器（raw markdown 模式）自动把三者合并成一条 markdown 消息。
  // 不再手拼 segment.markdown（那会被适配器单独推成一条，反而拆两条）。
  if (isQQBot(e) && configControl.get().qqbot_markdown_enabled) {
    const msg = [];
    if (imagePath) msg.push(segment.image(imagePath));
    let text = buildPigDetailMarkdown(renderData, {
      exLevel: appearance.applied_level,
      heading: extraText,
    });
    if (trailingText) text += '\r' + String(trailingText).replace(/^[\r\n]+/, '');
    if (text) msg.push(text);
    await e.reply(withButtons(e, msg, buttons), quoteFlag());
    return true;
  }

  let img;
  try {
    img = await renderPigCard(renderData, imagePath, appearance.applied_level);
  } catch (err) {
    logger?.error?.(`[今日小猪] 卡片渲染失败: ${err}`);
    await e.reply('图片生成失败。', quoteFlag());
    return false;
  }
  const msg = [];
  if (extraText) msg.push(extraText.replace(/[\r\n]+$/, ''));
  msg.push(img);
  if (trailingText) msg.push(trailingText.replace(/^[\r\n]+/, ''));
  await e.reply(withButtons(e, msg, buttons), quoteFlag());
  return true;
}

export class RollPigRoll extends plugin {
  constructor() {
    super({
      name: '今天是什么小猪',
      dsc: '每日抽取小猪、随机小猪、找猪、明日/昨日小猪',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#?(今天是什么小猪|今日小猪|本日小猪|当日小猪)$', fnc: 'todayPig' },
        { reg: '^#?随机小猪\\s*(\\d+)?$', fnc: 'randomPig' },
        { reg: '^#?(找猪|搜猪)\\s+(.+)$', fnc: 'findPig' },
        { reg: '^#?明日小猪$', fnc: 'tomorrowPig' },
        { reg: '^#?昨日小猪$', fnc: 'yesterdayPig' },
        { reg: '^#?同步小猪(资源|动图|gif|GIF).*$', fnc: 'syncResources' },
      ],
    });
  }

  get sendRenderedPig() {
    return sendRenderedPig;
  }

  async todayPig(e) {
    const userId = String(e.user_id);
    const groupId = getEventGroupId(e);
    store.recordUserName(userId, getEventUserName(e));
    const resolution = resolveDailyPig(userId, groupId, { includeProgress: true });
    if (resolution.recorded_pig_missing) {
      await e.reply(RECORDED_PIG_RESOURCE_MISSING_TEXT, quoteFlag());
      return true;
    }
    if (resolution.missing_resources || !resolution.pig) {
      await e.reply('猪圈塌房了（数据缺失）', quoteFlag());
      return true;
    }
    await sendRenderedPig(e, resolution.pig, {
      extraText: resolution.growth_text,
      exLevel: resolution.ex_level || 0,
    });
    if (resolution.was_auto_created) {
      await deliverReadyReservations(e).catch((err) => logger?.warn?.(`[今日小猪] 预约投递失败: ${err}`));
    }
    return true;
  }

  async randomPig(e) {
    if (!configControl.get().pighub_enabled) {
      await e.reply('随机小猪功能已关闭。', quoteFlag());
      return true;
    }
    const m = e.msg.match(/(\d+)/);
    let count = m ? parseInt(m[1], 10) : 1;
    count = Math.max(1, Math.min(count, 10));
    if (!(await pighub.ensureReady())) {
      await e.reply(withButtons(e, '连不上 PigHub，请稍后再试。', RANDOM_BUTTONS), quoteFlag());
      return true;
    }
    const selected = pighub.sample(count);
    if (!selected.length) {
      await e.reply(withButtons(e, 'PigHub 图片索引为空，请稍后再试。', RANDOM_BUTTONS), quoteFlag());
      return true;
    }
    if (count === 1) {
      const url = pighub.buildImageUrl(selected[0]);
      await e.reply(withButtons(e, [segment.image(url)], RANDOM_BUTTONS), quoteFlag());
      return true;
    }
    // 多图合并转发（仅群聊）
    if (!e.group_id) {
      const url = pighub.buildImageUrl(selected[0]);
      await e.reply(
        withButtons(e, ['私聊暂不支持多张连发，先给你一张：\n', segment.image(url)], RANDOM_BUTTONS),
        quoteFlag()
      );
      return true;
    }
    const forwardMsgs = [];
    for (const pig of selected) {
      const url = pighub.buildImageUrl(pig);
      if (!url) continue;
      forwardMsgs.push({
        message: [String(pig.title || '随机小猪'), segment.image(url)],
        nickname: '随机小猪Bot',
        user_id: e.self_id,
      });
    }
    if (!forwardMsgs.length) {
      await e.reply(withButtons(e, 'PigHub 图片数据异常，请稍后再试。', RANDOM_BUTTONS), quoteFlag());
      return true;
    }
    try {
      const forward = await e.group.makeForwardMsg(forwardMsgs);
      await e.reply(withButtons(e, forward, RANDOM_BUTTONS));
    } catch (err) {
      logger?.warn?.(`[随机小猪] 合并转发失败: ${err}`);
      await e.reply(
        withButtons(e, 'PigHub 图片加载或合并转发超时了，请稍后再试。', RANDOM_BUTTONS),
        quoteFlag()
      );
    }
    return true;
  }

  async findPig(e) {
    if (!configControl.get().pighub_enabled) {
      await e.reply('找猪功能已关闭。', quoteFlag());
      return true;
    }
    const m = e.msg.match(/^#?(找猪|搜猪)\s+(.+)$/);
    const keyword = m ? m[2].trim() : '';
    if (!keyword) {
      await e.reply(withButtons(e, '请加上关键词，如：找猪 玩偶', SEARCH_BUTTONS), quoteFlag());
      return true;
    }
    if (!(await pighub.ensureReady())) {
      await e.reply(withButtons(e, '连不上 PigHub，请稍后再试。', SEARCH_BUTTONS), quoteFlag());
      return true;
    }
    const found = pighub.search(keyword);
    if (!found.length) {
      await e.reply(withButtons(e, `没找到叫「${keyword}」的猪。`, SEARCH_BUTTONS), quoteFlag());
      return true;
    }
    if (!e.group_id) {
      const url = pighub.buildImageUrl(found[0]);
      const extra = found.length > 1 ? `\n共找到 ${found.length} 张，私聊仅展示第 1 张。` : '';
      await e.reply(
        withButtons(e, [String(found[0].title || '未命名小猪'), segment.image(url), extra], SEARCH_BUTTONS),
        quoteFlag()
      );
      return true;
    }
    const forwardMsgs = [];
    for (const pig of found.slice(0, 10)) {
      const url = pighub.buildImageUrl(pig);
      if (!url) continue;
      forwardMsgs.push({
        message: [String(pig.title || '未命名小猪'), segment.image(url)],
        nickname: '搜猪小助手',
        user_id: e.self_id,
      });
    }
    try {
      const forward = await e.group.makeForwardMsg(forwardMsgs);
      await e.reply(withButtons(e, forward, SEARCH_BUTTONS));
    } catch (err) {
      logger?.warn?.(`[找猪] 合并转发失败: ${err}`);
      await e.reply(
        withButtons(e, 'PigHub 图片加载或合并转发超时了，请稍后再试。', SEARCH_BUTTONS),
        quoteFlag()
      );
    }
    return true;
  }

  async tomorrowPig(e) {
    await e.reply(withButtons(e, T.pick(T.TOMORROW_TEXTS), PANEL_BUTTONS), quoteFlag());
    return true;
  }

  async yesterdayPig(e) {
    const userId = String(e.user_id);
    const targetDate = rollpigDateStr(-1);
    let makeupCreated = false;
    let pigId = store.getDailyRoll(userId, targetDate);
    if (!pigId) {
      if (!resourceManager.pigList.length) {
        await e.reply('小猪资源暂时不可用，无法补签。', quoteFlag());
        return true;
      }
      try {
        makeupCreated = ensureYesterdayPig(userId, targetDate);
      } catch (err) {
        await e.reply(`补签失败：${err.message || err}`, quoteFlag());
        return true;
      }
      pigId = store.getDailyRoll(userId, targetDate);
    }
    const pig = resourceManager.getPigById(pigId);
    if (!pig) {
      await e.reply(withButtons(e, '昨天那只猪暂时不在当前资源包里。', PANEL_BUTTONS), quoteFlag());
      return true;
    }
    const snapshot = store.getDailyRollSnapshot(userId, targetDate);
    const exLevel = snapshot?.expert_level_after_roll || 0;
    const prefix = makeupCreated ? T.pick(T.YESTERDAY_MAKEUP_TEXTS) : '';

    // 昨日样式：recap=原项目「昨日回顾卡」（默认）；pig=原来的图文小猪卡
    if (configControl.get().yesterday_style !== 'pig') {
      try {
        const recap = buildYesterdayRecap(userId, { groupId: getEventGroupId(e), dateStr: targetDate });
        if (recap) {
          const seg = await renderYesterdayRecapImage(recap);
          const msg = prefix ? [prefix + '\n', seg] : seg;
          await e.reply(withButtons(e, msg, PANEL_BUTTONS), quoteFlag());
          return true;
        }
      } catch (err) {
        logger?.error?.(`[今日小猪] 昨日回顾渲染失败，回退图文卡: ${err}`);
      }
    }
    await sendRenderedPig(e, pig, { extraText: prefix, exLevel });
    return true;
  }

  async syncResources(e) {
    if (!e.isMaster) {
      await e.reply('只有主人可以同步小猪资源。', quoteFlag());
      return true;
    }
    const raw = (e.msg || '').replace(/^#?/, '');
    // 「同步小猪资源」= 基础资源；「同步小猪动图/同步小猪GIF」= GIF 动图包；「同步小猪资源 全部」= 两者
    const wantGif = /动图|gif/i.test(raw);
    const wantAll = /全部|all/i.test(raw);
    const force = /强制|force/i.test(raw);
    await e.reply('🐷 开始同步小猪资源，请稍候（首次下载图片较多可能要几分钟）...', quoteFlag());

    const lines = [];
    try {
      if (!wantGif || wantAll) {
        const r = await syncBaseResource({ force });
        lines.push(r.message);
      }
      if (wantGif || wantAll) {
        const g = await syncGifOverlay({ force });
        lines.push(g.message);
      }
    } catch (err) {
      logger?.error?.(`[今日小猪] 资源同步失败: ${err}`);
      await e.reply(`资源同步失败：${err.message || err}`, quoteFlag());
      return true;
    }

    resourceManager.reload();
    const state = getSyncState();
    await e.reply(
      [
        '🐷 小猪资源同步完成',
        ...lines,
        `🐽 当前小猪数量：${resourceManager.pigList.length}`,
        `📦 基础版本：${state.base}`,
        `🎞 动图版本：${state.gif}`,
      ].join('\n'),
      quoteFlag()
    );
    return true;
  }
}
