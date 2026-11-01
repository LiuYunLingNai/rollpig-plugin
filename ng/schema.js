import { s } from '@yunzai-ng/core';

export const configSchema = s.object({
  roast_cooldown_hours: s.number().min(0.1).max(168).default(8).title('恢复一次烤猪的小时数'),
  roast_charge_max: s.number().int().min(1).max(6).default(2).title('最多储存烤猪次数'),
  catalog_enabled: s.boolean().default(true).title('图片版图鉴'),
  daily_summary_enabled: s.boolean().default(false).title('未单独设置的群默认推送日报'),
  daily_report_groups: s.record(s.boolean()).default({}).title('各群日报开关'),
  yesterday_style: s.enum(['recap', 'pig']).default('recap').title('昨日小猪样式'),
  pighub_enabled: s.boolean().default(true).title('启用 PigHub 随机与搜索'),
  render_scale: s.number().min(1).max(4).default(2).title('图片渲染缩放'),
  qqbot_markdown_enabled: s.boolean().default(false).title('QQBot 图片配 Markdown 正文'),
  reply_quote: s.boolean().default(true).title('引用触发消息'),
  ai_enabled: s.boolean().default(false).title('AI 烤猪文案').desc('仅在烤猪时调用配置的 OpenAI 兼容接口；默认关闭。'),
  ai_api_key: s.password().default('').title('AI API Key'),
  ai_base_url: s.string().default('https://api.deepseek.com').title('OpenAI 兼容 API 地址')
    .check('请输入不含用户名密码的 HTTP(S) 地址', value => {
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
      catch { return false; }
    }),
  ai_model: s.string().default('deepseek-chat').title('AI 模型'),
  ai_timeout: s.number().int().min(1).max(120).default(20).title('AI 请求超时（秒）'),
  ai_max_tokens: s.number().int().min(32).max(4096).default(512).title('AI 最大输出 Token'),
});
