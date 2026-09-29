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
          field: 'yesterday_style',
          label: '昨日小猪样式',
          bottomHelpMessage: 'recap=昨日回顾卡（足迹/经历/小结）；pig=图文小猪卡',
          component: 'Select',
          componentProps: {
            options: [
              { label: '昨日回顾卡', value: 'recap' },
              { label: '图文小猪卡', value: 'pig' },
            ],
          },
        },
        {
          field: 'daily_summary_enabled',
          label: '日报默认开启',
          bottomHelpMessage: '未单独设置的群是否默认启用猪圈日报',
          component: 'Switch',
          componentProps: { checkedValue: true, unCheckedValue: false },
        },
        {
          field: 'daily_report_group_list',
          label: '日报推送群',
          bottomHelpMessage:
            '选中的群每晚 23:45 推送猪圈日报（等同在群里发「小猪日报 开启」）。未选中的群按上面的默认开关处理。',
          component: 'GSelectGroup',
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
          field: 'reply_quote',
          label: '引用消息回复',
          bottomHelpMessage: '开启后回复会引用（@ 并引用）触发指令的那条消息；关闭则直接发送',
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
        const cfg = configControl.get();
        const map = cfg.daily_report_groups || {};
        return {
          ...cfg,
          // 把 {群号: true/false} 映射成锅巴群选择器需要的数组
          daily_report_group_list: Object.keys(map).filter((gid) => map[gid]),
        };
      },

      setConfigData(data, { Result }) {
        try {
          const patch = {};
          for (const [key, value] of Object.entries(data || {})) {
            patch[key] = value;
          }
          // 群选择器 -> {群号: true} 映射；未选中的群移除显式开启
          if ('daily_report_group_list' in patch) {
            const selected = Array.isArray(patch.daily_report_group_list)
              ? patch.daily_report_group_list.map(String)
              : [];
            delete patch.daily_report_group_list;
            const oldMap = configControl.get().daily_report_groups || {};
            const newMap = {};
            for (const gid of selected) newMap[gid] = true;
            // 保留此前被显式关闭（false）的群，避免选择器覆盖手动关闭
            for (const [gid, val] of Object.entries(oldMap)) {
              if (val === false && !(gid in newMap)) newMap[gid] = false;
            }
            patch.daily_report_groups = newMap;
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
