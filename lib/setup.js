import Path, { bindPaths } from '../constants/path.js';
import { bindContext, waitForOperations } from '../host/index.js';

// 两个入口共用初始化；绑定路径之前不导入会创建数据文件的业务单例。
export async function setupCommon(host) {
  await waitForOperations();
  host.signal.throwIfAborted();
  bindContext(host);
  bindPaths(host);
  const { default: store } = await import('./store/store.js');
  store.file = Path.dataFile;
  store.data = store._load();
  const { default: resources } = await import('./resource/resourceManager.js');
  resources.reload();
  store.pruneHistory(14);
  store.pruneEvents(7);
  const { registerDailyReportSchedule } = await import('./flow/dailyReportJob.js');
  registerDailyReportSchedule();
  const modules = await Promise.all(['roll', 'collection', 'roast', 'reservation', 'control', 'help', 'update']
    .map(name => import(`../apps/${name}.js`)));
  host.logger.info(`今日小猪已加载 ${resources.pigList.length} 只小猪；数据目录 ${host.dataDir}`);
  return { modules, store, resources };
}
