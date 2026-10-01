import { RollPigApp } from '../lib/flow/base.js';
import { withButtons, HELP_BUTTONS } from '../lib/flow/qqbot.js';
import { quoteFlag } from '../lib/flow/reply.js';

const HELP_TEXT = [
  '🐷 今日小猪 Plus 指令帮助',
  '━━━━━━━━━━━━━━',
  '【每日抽猪】',
  '· 今日小猪 / 今天是什么小猪 —— 抽取今天的命运之猪',
  '· 昨日小猪 —— 回顾昨天；没抽会自动补签',
  '· 明日小猪 —— 玄学预测明天',
  '· 随机小猪 [数量] —— 从 PigHub 随机看猪图（最多 10 张）',
  '· 找猪 关键词 / 搜猪 关键词 —— 搜索 PigHub 猪图',
  '',
  '【猪圈成长】',
  '· 我的猪圈 / 我的小猪 —— 查看收集进度与 EX 等级',
  '· 小猪图鉴 [页码] —— 图片版完整图鉴',
  '· 本周小猪 —— 本周抽猪长图',
  '· 小猪投稿 —— 前往投稿平台',
  '',
  '【烤猪互动】（群内）',
  '· 今日烤猪 —— 把自己的今日小猪做成料理',
  '· 烤群友 @对方 —— 烤群友；对方没抽猪会自动建立预约',
  '· 加急生火 @对方 —— 每日一次强制成功烤',
  '· 随机烤群友 / 随机烤猪 —— 随机抽群友烤',
  '· 回复预约通知发「加入」—— 加入他人预约',
  '· 烤箱续火 / 烤箱补货 —— 发起群体补货',
  '',
  '【管理】',
  '· 日报状态 开启/关闭/状态 —— 群主/管理员控制日报',
  '· 小猪日报 [群号] —— 立即生成本群日报（预览，不结算保护）',
  '· 同步小猪资源 —— 主人重新加载资源',
  '· 小猪更新 / 小猪强制更新 / 小猪更新日志 —— 主人更新插件',
  '━━━━━━━━━━━━━━',
  '所有指令可省略 # 前缀，例如直接发「今日小猪」。',
].join('\n');

export class RollPigHelp extends RollPigApp {
  constructor() {
    super({
      name: '小猪帮助',
      dsc: '今日小猪 Plus 指令帮助',
      event: 'message',
      priority: 500,
      rule: [{ reg: '^#?(小猪帮助|小猪菜单|小猪help|猪帮助|rollpig帮助)$', fnc: 'help' }],
    });
  }

  async help(e) {
    await e.reply(withButtons(e, HELP_TEXT, HELP_BUTTONS), quoteFlag());
    return true;
  }
}
