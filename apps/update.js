import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandGroup } from '../lib/flow/base.js';
import { hostKind } from '../host/index.js';
import Path from '../constants/path.js';
import { quoteFlag, reply } from '../lib/flow/reply.js';

export class RollPigUpdate extends CommandGroup {
  constructor() {
    super({
      name: '小猪更新', dsc: '今日小猪更新与更新日志', event: 'message', priority: 500,
      rule: [{ reg: '^[#/]?小猪(插件)?(强制)?更新(日志)?$', fnc: 'update' }],
    });
  }

  async update(e) {
    if (!e.isMaster) {
      await reply(e, '只有主人可以更新今日小猪插件。', quoteFlag());
      return true;
    }
    if (hostKind() !== 'trss') {
      await reply(e, '当前是支持 Yunzai-NG 的双宿主移植版；请更新保留 ng/ 与 host/ 的双宿主版文件后在面板重载 rollpig，不可用旧版上游覆盖。图片和小猪清单可用「同步小猪资源」更新。', quoteFlag());
      return true;
    }
    // 旧云崽保留内置更新功能；只改派生事件，不污染原事件和回复函数。
    const { update: Update } = await import(pathToFileURL(path.join(Path.root, '../other/update.js')).href);
    const isLog = e.text.includes('日志');
    const isForce = e.text.includes('强制');
    const update = new Update();
    update.e = Object.assign(Object.create(e.trssEvent), {
      msg: `#${isForce ? '强制' : ''}更新${isLog ? '日志' : ''}rollpig-plugin`,
    });
    return isLog ? update.updateLog() : update.update();
  }
}
