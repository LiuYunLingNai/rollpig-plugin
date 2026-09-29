import configControl from './lib/model/config.js';

/**
 * 锅巴（Guoba）面板支持。
 * 让「今日小猪 Plus」的配置能在锅巴 Web 面板里可视化修改。
 * 配置读写统一走 lib/model/config.js（YAML 落盘）。
 */
export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'rollpig-plugin',
      title: '今日小猪 Plus',
      description: '每日抽猪、图鉴收集、烤猪互动，支持云端资源同步与 QQBot 按钮/Markdown',
      author: 'Bear_lele, Felis（Yunzai 移植）',
      authorLink: 'https://pig.felislab.cc',
      link: 'https://pig.felislab.cc',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:pig',
      iconColor: '#ff8fb3',
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: '烤群友',
        },
        {
          field: 'roast_cooldown_hours',
          label: '烤群友冷却(小时)',
          bottomHelpMessage: '普通烤群友恢复 1 次所需小时数',
          component: 'InputNumber',
          componentProps: { min: 1, max: 72 },
        },
        {
          field: 'roast_charge_max',
          label: '烤群友储存次数',
          bottomHelpMessage: '普通烤群友最多可储存的次数',
          component: 'InputNumber',
          componentProps: { min: 1, max: 6 },
        },
        {
          component: 'Divider',
          label: '图鉴 / 日报',
        },
        {
          field: 'catalog_enabled',
          label: '图片版图鉴',
          bottomHelpMessage: '是否启用图片版小猪图鉴',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          field: 'daily_summary_enabled',
          label: '日报默认开启',
          bottomHelpMessage: '未单独设置的群是否默认启用猪圈日报',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          component: 'Divider',
          label: 'PigHub（随机小猪 / 找猪）',
        },
        {
          field: 'pighub_enabled',
          label: '启用 PigHub',
          bottomHelpMessage: '随机小猪、找猪 是否联网使用 PigHub 图源',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          component: 'Divider',
          label: '渲染',
        },
        {
          field: 'render_scale',
          label: '截图缩放',
          bottomHelpMessage: 'Puppeteer 卡片截图缩放倍数，越大越清晰但越慢',
          component: 'InputNumber',
          componentProps: { min: 1, max: 4 },
        },
        {
          field: 'qqbot_markdown_enabled',
          label: 'QQBot Markdown 排版',
          bottomHelpMessage: '关=图文卡片截图；开=图片+Markdown 引用块（仅 QQBot 官方端生效）',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          component: 'Divider',
          label: 'AI 烤猪文案（可选）',
        },
        {
          field: 'ai_enabled',
          label: '启用 AI 文案',
          bottomHelpMessage: '烤猪结果是否用 AI 生成文案（需配置 API）',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          field: 'ai_api_key',
          label: 'AI API Key',
          bottomHelpMessage: 'AI 接口密钥',
          component: 'InputPassword',
        },
        {
          field: 'ai_base_url',
          label: 'AI 接口地址',
          bottomHelpMessage: '如 https://api.deepseek.com',
          component: 'Input',
        },
        {
          field: 'ai_model',
          label: 'AI 模型',
          bottomHelpMessage: '如 deepseek-chat',
          component: 'Input',
        },
        {
          field: 'ai_timeout',
          label: 'AI 超时(秒)',
          component: 'InputNumber',
          componentProps: { min: 5, max: 120 },
        },
        {
          field: 'ai_max_tokens',
          label: 'AI 最大 token',
          component: 'InputNumber',
          componentProps: { min: 64, max: 4096 },
        },
      ],

      getConfigData() {
        return configControl.get();
      },

      setConfigData(data, { Result }) {
        try {
          const patch = {};
          for (const [key, value] of Object.entries(data || {})) {
            // 锅巴按 field 扁平传回，直接写入
            patch[key] = value;
          }
          configControl.setMultiple(patch);
          return Result.ok({}, '保存成功~重启或部分功能即时生效');
        } catch (err) {
          return Result.error({}, `保存失败：${err.message || err}`);
        }
      },
    },
  };
}
