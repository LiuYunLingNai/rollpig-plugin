# 🐖 rollpig-plugin（今天是什么小猪 · Yunzai 版）

> 由 NoneBot 插件 [nonebot-plugin-rollpig-plus](https://github.com/Felis2026/nonebot-plugin-rollpig-plus) 移植到 Yunzai / TRSS-Yunzai 的大插件版本。
> 每天抽一只属于你的小猪，养成猪圈、提升 EX 等级，还能把群友烤了~

## ✨ 功能

| 模块 | 指令 |
| --- | --- |
| 每日抽猪 | `今日小猪` / `今天是什么小猪`、`昨日小猪`（自动补签）、`明日小猪` |
| 随机 / 找猪 | `随机小猪 [数量]`、`找猪 关键词` / `搜猪 关键词`（PigHub 图源） |
| 猪圈成长 | `我的猪圈`、`小猪图鉴 [页码]`、`本周小猪`、`小猪投稿` |
| 烤猪互动 | `今日烤猪`、`烤群友 @目标`、`随机烤猪`、`加急生火 @目标`、`强行点火`（主人） |
| 预约烤猪 | 目标未抽猪时 `烤群友 @目标` 自动建立预约；回复通知发送 `加入` 参与 |
| 烤箱续火 | `烤箱续火` / `烤箱补货`（简化版：群主 / 管理员 / 主人确认放行） |
| 日报开关 | `小猪日报 开启/关闭/状态`（群主 / 管理员 / 主人） |
| 资源同步 | `同步小猪资源`（主人，重新加载本地资源与 PigHub 索引） |

指令均支持可选 `#` / `/` 前缀。

## 📦 安装

将本目录放入 Yunzai 的 `plugins/` 下：

```
Yunzai/plugins/rollpig-plugin/
```

无需额外安装依赖，渲染复用 Yunzai 自带的 `puppeteer` 渲染器；`oicq`、`node-schedule` 等均由框架提供。重启 Bot 即可。

## 🗂️ 目录结构

```
rollpig-plugin/
├── index.js                # 入口：加载资源、聚合 apps
├── constants/path.js       # 绝对路径常量
├── apps/                   # 指令处理（plugin 类）
│   ├── roll.js             # 今日/昨日/明日/随机/找猪/同步资源
│   ├── collection.js       # 我的猪圈/图鉴/本周/投稿
│   ├── roast.js            # 今日烤猪/烤群友/随机烤猪/烤箱续火
│   ├── reservation.js      # 回复通知加入预约
│   └── control.js          # 小猪日报开关
├── lib/
│   ├── model/              # config / json / runtime / models / texts
│   ├── store/store.js      # 本地 JSON 存储（抽猪/图鉴/烤猪/预约/续火）
│   ├── resource/           # 小猪资源管理器
│   ├── flow/               # 业务流程（rollFlow/roastFlow/roastManager/reservationFlow/pighub/helpers）
│   └── render/render.js    # Puppeteer 卡片/图鉴/长图渲染
├── resource/
│   ├── pig.json            # 小猪列表
│   ├── pig_rules.json      # 特殊形态规则（熟食/人类/吃掉了/卖掉了）
│   ├── image/              # 小猪图片
│   ├── fonts/              # 字体
│   └── html/               # 渲染模板（pig_card/catalog/weekly）
└── data/                   # 运行时数据（自动生成，勿手动改）
    ├── pig_data.json       # 全部持久化数据
    ├── config.json         # 配置（首次运行生成）
    └── pighub_images.json  # PigHub 索引缓存
```

## ⚙️ 配置

首次运行会在 `data/config.json` 生成默认配置，可按需修改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `roast_cooldown_hours` | `8` | 普通烤群友恢复 1 次所需小时数 |
| `roast_charge_max` | `2` | 普通烤群友最多储存次数 |
| `catalog_enabled` | `true` | 是否启用图片版图鉴 |
| `daily_summary_enabled` | `false` | 未单独设置的群日报默认状态 |
| `pighub_enabled` | `true` | 随机小猪 / 找猪 是否启用 PigHub |
| `render_scale` | `2` | 卡片渲染缩放 |
| `ai_enabled` | `false` | 是否用 AI 生成烤猪文案 |
| `ai_api_key` / `ai_base_url` / `ai_model` | — | OpenAI 兼容接口配置 |

## 📄 说明

- 本 Yunzai 版为单进程本地存储实现，不含原版的多 Bot Cloud 同步、EX 差分云端下载、GIF Overlay、猪圈日报定时推送长图等能力；核心玩法（抽猪 / 图鉴 / EX 成长 / 烤猪 / 预约 / 续火）完整保留。
- 卡片使用 Puppeteer + HTML 模板渲染，替代原版 Pillow 手绘。
- 资源与文案版权以原项目 [rollpig-resources](https://github.com/Felis2026/rollpig-resources) 与 `THIRD_PARTY_NOTICES` 为准；插件代码沿用 MIT。

## 🙏 致谢

- 原作：[Bearlele/nonebot-plugin-rollpig](https://github.com/Bearlele/nonebot-plugin-rollpig)
- Plus：[Felis2026/nonebot-plugin-rollpig-plus](https://github.com/Felis2026/nonebot-plugin-rollpig-plus)
- [PigHub](https://pighub.top/)
