import plugin from '../../../lib/plugins/plugin.js';
import { update as Update } from '../../other/update.js';
import { quoteFlag } from '../lib/flow/reply.js';

/**
 * 今日小猪 Plus 插件更新。
 * 复用 TRSS-Yunzai 内置更新逻辑（git pull / 强制更新 / 更新日志 / 自动重启），
 * 只把「小猪更新」系列指令映射到本插件目录 rollpig-plugin。
 */
export class RollPigUpdate extends plugin {
  constructor() {
    super({
      name: '小猪更新',
      dsc: '更新今日小猪 Plus 插件',
      event: 'message',
      priority: 500,
      rule: [{ reg: '^#?小猪(插件)?(强制)?更新(日志)?$', fnc: 'update' }],
    });
  }

  async update() {
    if (!this.e.isMaster) {
      await this.e.reply('只有主人可以更新今日小猪插件。', quoteFlag());
      return true;
    }
    const isLog = this.e.msg.includes('日志');
    const isForce = this.e.msg.includes('强制');
    // 拼成内置更新识别的指令：#[强制]更新[日志]rollpig-plugin
    this.e.msg = `#${isForce ? '强制' : ''}更新${isLog ? '日志' : ''}rollpig-plugin`;
    const up = new Update();
    up.e = this.e;
    return isLog ? up.updateLog() : up.update();
  }
}
