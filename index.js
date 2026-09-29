import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!global.segment) {
  try {
    global.segment = (await import('oicq')).segment;
  } catch (err) {
    global.segment = (await import('icqq')).segment;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appsDir = path.join(__dirname, 'apps');

logger.info('----------------------------');
logger.info('🐷 今日小猪 Plus 插件载入中...');
logger.info('----------------------------');

// 预加载资源、PigHub 与定时维护
try {
  const { default: resourceManager } = await import('./lib/resource/resourceManager.js');
  logger.info(`[今日小猪] 已加载 ${resourceManager.pigList.length} 只小猪`);
  const { default: pighub } = await import('./lib/flow/pighub.js');
  // 启动后延迟随机刷新 PigHub 索引，避免多 Bot 同时打接口
  setTimeout(
    () => pighub.refresh('startup').catch((err) => logger.warn(`[今日小猪] PigHub 刷新失败: ${err}`)),
    (60 + Math.floor(Math.random() * 240)) * 1000
  ).unref?.();
  const { default: store } = await import('./lib/store/store.js');
  // 启动时清理过期数据
  try {
    store.pruneHistory(14);
    store.pruneEvents(7);
  } catch (err) {
    logger.warn(`[今日小猪] 数据清理失败: ${err}`);
  }
  // 注册猪圈日报定时任务（每晚 23:45 推送 + 结算次日保护）
  try {
    const { registerDailyReportSchedule } = await import('./lib/flow/dailyReportJob.js');
    registerDailyReportSchedule();
  } catch (err) {
    logger.warn(`[今日小猪] 日报定时任务注册失败: ${err}`);
  }
} catch (err) {
  logger.error(`[今日小猪] 初始化失败: ${err}`);
}

const files = fs.readdirSync(appsDir).filter((file) => file.endsWith('.js'));

let ret = files.map((file) => import(`./apps/${file}`));
ret = await Promise.allSettled(ret);

let apps = {};
for (const i in files) {
  const name = files[i].replace('.js', '');
  const result = ret[i];
  if (result.status !== 'fulfilled') {
    logger.error(`[今日小猪] 载入应用错误：${name}`);
    logger.error(result.reason);
    continue;
  }
  const mod = result.value;
  // 支持默认导出与具名导出的 plugin 类
  for (const key of Object.keys(mod)) {
    const cls = mod[key];
    if (typeof cls === 'function') {
      apps[`${name}_${key}`] = cls;
    }
  }
}

logger.info('🐷 今日小猪 Plus 插件载入成功~');

export { apps };
