import { createTrssHost } from './host/trss.js';
import { makeTrssApps } from './apps/trss.js';
import { setupCommon } from './lib/setup.js';

// 旧云崽只读这个入口；NG 由 package.json 的 yunzai.entry 进入 ng/index.js。
const host = await createTrssHost();
const { modules } = await setupCommon(host);
const apps = await makeTrssApps(modules);

export { apps };
