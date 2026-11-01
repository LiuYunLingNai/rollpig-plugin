import { definePlugin } from '@yunzai-ng/core';
import { createNgHost } from '../host/ng.js';
import { rememberGroup, runSerialized } from '../host/index.js';
import { setupCommon } from '../lib/setup.js';
import Path from '../constants/path.js';
import { configSchema } from './schema.js';

export default definePlugin({
  name: 'rollpig',
  configSchema,
  async setup(ctx) {
    const { modules, resources } = await setupCommon(createNgHost(ctx));
    for (const module of modules) {
      for (const App of Object.values(module)) {
        if (typeof App !== 'function') continue;
        const app = new App();
        for (const rule of app.rule ?? []) {
          ctx.command(new RegExp(rule.reg), { desc: app.dsc, group: '今日小猪', priority: app.priority })
            .action(e => runSerialized(async () => {
              await rememberGroup(e);
              return app[rule.fnc](e);
            }, ctx.signal));
        }
      }
    }
    ctx.provide('rollpig', {
      status: () => ({ pigs: resources.pigList.length, dataFile: Path.dataFile }),
    });
  },
});
