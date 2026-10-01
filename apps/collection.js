import { RollPigApp } from '../lib/flow/base.js';
import { segment } from 'oicq';
import store from '../lib/store/store.js';
import resourceManager from '../lib/resource/resourceManager.js';
import { renderCatalogImage, renderWeeklyImage, CATALOG_PAGE_SIZE } from '../lib/render/render.js';
import { buildPigstyGrowthSummary } from '../lib/flow/rollFlow.js';
import { getEventUserName } from '../lib/flow/helpers.js';
import { rollpigToday, rollpigDateStr } from '../lib/model/runtime.js';
import configControl from '../lib/model/config.js';
import { withButtons, catalogButtons, PANEL_BUTTONS } from '../lib/flow/qqbot.js';
import { quoteFlag } from '../lib/flow/reply.js';

export class RollPigCollection extends RollPigApp {
  constructor() {
    super({
      name: '小猪猪圈',
      dsc: '我的猪圈、小猪图鉴、本周小猪、小猪投稿',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#?(我的猪圈|我的小猪)$', fnc: 'pigsty' },
        { reg: '^#?(小猪图鉴|猪猪图鉴|完整图鉴)\\s*(\\d+)?$', fnc: 'catalog' },
        { reg: '^#?本周小猪$', fnc: 'weekly' },
        { reg: '^#?(小猪投稿|投稿小猪)$', fnc: 'submit' },
      ],
    });
  }

  async pigsty(e) {
    const userId = String(e.user_id);
    const drawState = store.getDrawState(userId);
    const totalPigs = resourceManager.pigList.length;
    const userCount = drawState.pig_ids.length;
    if (totalPigs <= 0) {
      await e.reply('猪图鉴为空，请先检查资源文件。', quoteFlag());
      return true;
    }
    if (userCount === 0) {
      await e.reply(withButtons(e, '你的猪圈空空如也！发送「今日小猪」开始收集。', PANEL_BUTTONS), quoteFlag());
      return true;
    }
    const msg = buildPigstyGrowthSummary(getEventUserName(e), drawState, totalPigs);
    await e.reply(withButtons(e, msg, PANEL_BUTTONS), quoteFlag());
    return true;
  }

  async catalog(e) {
    if (!configControl.get().catalog_enabled) {
      await e.reply('图片版小猪图鉴当前未启用。', quoteFlag());
      return true;
    }
    const m = e.msg.match(/(\d+)/);
    const page = m ? Math.max(1, parseInt(m[1], 10)) : 1;
    if (!resourceManager.pigList.length) {
      await e.reply('猪图鉴为空，请先检查资源文件。', quoteFlag());
      return true;
    }
    const snapshot = store.getCatalogSnapshot(userId(e), 14);
    const unlocked = snapshot.draw_state.pig_ids.length;
    if (!unlocked) {
      await e.reply(withButtons(e, '你的猪圈空空如也！发送「今日小猪」开始收集。', PANEL_BUTTONS), quoteFlag());
      return true;
    }
    const totalPages = Math.max(1, Math.ceil(unlocked / CATALOG_PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    try {
      const img = await renderCatalogImage({ userName: getEventUserName(e), snapshot, page: currentPage });
      await e.reply(withButtons(e, img, catalogButtons(currentPage, totalPages)), quoteFlag());
    } catch (err) {
      logger?.error?.(`[今日小猪] 图鉴渲染失败: ${err}`);
      await e.reply('小猪图鉴生成失败，请稍后再试。', quoteFlag());
    }
    return true;
  }

  async weekly(e) {
    const uid = String(e.user_id);
    const today = rollpigToday();
    const entries = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - (6 - i) * 86400000);
      const dateStr = d.toISOString().slice(0, 10);
      const pigId = store.getPigByDate(uid, dateStr);
      const pig = pigId ? resourceManager.getPigById(pigId) : null;
      if (pig) {
        const imgPath = resourceManager.findImageFile(pig.id);
        if (imgPath) {
          entries.push({ day: `${d.getMonth() + 1}/${d.getDate()}`, imagePath: imgPath });
        }
      }
    }
    if (!entries.length) {
      await e.reply(withButtons(e, '你这周还没抽过猪呢！', PANEL_BUTTONS), quoteFlag());
      return true;
    }
    try {
      const img = await renderWeeklyImage(entries);
      await e.reply([`你这周变了 ${entries.length} 次猪！`, img], quoteFlag());
    } catch (err) {
      logger?.error?.(`[今日小猪] 本周长图生成失败: ${err}`);
      await e.reply('生成图片失败。', quoteFlag());
    }
    return true;
  }

  async submit(e) {
    const message =
      '🐷 RollPig 小猪投稿\n' +
      '将你的小猪创意送进猪圈吧！\n\n' +
      '支持投稿：\n' +
      '• 小猪创意\n' +
      '• 完整小猪\n' +
      '• EX 等级差分\n\n' +
      '投稿地址：\n' +
      'https://pig.felislab.cc/submit\n' +
      '投稿完成后，记得保存投稿编号和私密查询码，方便随时查询审核进度。';
    await e.reply(
      withButtons(e, message, [[{ text: '📮 前往投稿', link: 'https://pig.felislab.cc/submit', style: 1 }]]),
      quoteFlag()
    );
    return true;
  }
}

function userId(e) {
  return String(e.user_id);
}
