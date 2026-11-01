# rollpig-plugin · 今日小猪双宿主版

由 [nonebot-plugin-rollpig-plus](https://github.com/Felis2026/nonebot-plugin-rollpig-plus) 经 [Yunzai 移植版](https://github.com/LiuYunLingNai/rollpig-plugin) 继续适配。当前这份代码同时支持 **Yunzai/TRSS-Yunzai** 和 **Yunzai-NG**，采用与 relay-checkin-plugin 类似的双入口、宿主适配层结构。

**两边共用玩法、资源和模板，不需要在 NG 全局伪造 `Bot`、`plugin`、`redis`。** 旧云崽事件和消息转换仅发生在 TRSS 适配层；NG 直接使用原生事件、消息段、配置、定时任务与渲染接口。

## 安装与入口

需要 Node.js ≥ 20.11。

| 宿主 | 入口 | 配置 | 玩家数据 | 渲染 |
| --- | --- | --- | --- | --- |
| Yunzai / TRSS | 根目录 `index.js`，导出旧框架 `apps` | 插件内 `config/config/config.yaml`，保留锅巴支持 | 插件内 `data/pig_data.json` | 旧框架 Puppeteer |
| Yunzai-NG ≥ 0.7.0 | `package.json` 的 `yunzai.entry` → `ng/index.js` | NG 主目录 `config/rollpig.yaml` | NG 主目录 `data/plugin/rollpig/pig_data.json` | 原生 renderer-puppeteer |

### 已安装的旧云崽

保留本目录，重启云崽即可。现有用户配置、玩家记录、内置资源继续使用原路径。无需安装 `@yunzai-ng/core`；TRSS 所需 `yaml`、`node-schedule`、消息段和浏览器由旧宿主提供。

### 安装到 NG

1. 把**当前这份双宿主版**代码与 `resource/` 放到 NG 主目录 `plugins/rollpig-plugin/`。
2. **不要复制旧云崽的 `data/`、用户 `config/config/`、`.git/` 或 `node_modules/`**。两边不会自动迁移配置或玩家数据。
3. 配置 NG 原生适配器，并加载 renderer-puppeteer；图片功能需要可用 Chromium。
4. 重启 NG；已安装后的更新可在 NG 面板重载 **rollpig**。
5. 发送 `小猪帮助`、`今日小猪` 验证。

本插件没有新增运行依赖，两边按各自宿主解析依赖。不需要为了 NG 在旧云崽插件里安装 core，也不要无必要地运行安装命令。

目前改动只在本地工作区，**上游在线仓库未发布这些适配**；从旧上游重新克隆/拉取不能保证保留本次双宿主支持。

## 功能与命令

命令可省略前缀，也支持 `#`、`/`。

| 功能 | 命令 / 说明 |
| --- | --- |
| 每日抽猪 | `今日小猪`、`今天是什么小猪`、`猪来`；当天重复抽取不重复增长 |
| 昨日与明日 | `昨日小猪`：昨日回顾，未抽会补签；`明日小猪`：趣味文案，不预抽 |
| PigHub | `随机小猪 [数量]`（1–10）、`找猪 关键词`、`搜猪 关键词`；按需访问外部图源，不计入收集 |
| 猪圈 | `我的猪圈`、`我的小猪`、`小猪图鉴 [页码]`：已拥有的小猪与 EX 成长 |
| 长图与投稿 | `本周小猪`：最近七天记录；`小猪投稿`：外部投稿链接 |
| 烤猪 | `今日烤猪`；群内 `烤群友 @目标` 或回复目标消息、`随机烤猪` / `随机烤群友` |
| 加急 | `加急生火 @目标`：每日一次，仍受形态规则限制；`强行点火 @目标`：仅主人 |
| 预约 | 目标没抽猪时建立预约；回复机器人通知发 `加入` / `加入预约` / `加入烤猪`；目标抽猪后同步结算投递 |
| 续火 | `烤箱续火` / `烤箱补货`：沿用简化版，至少三名当日活跃用户，活跃的群管/群主/主人确认，不是完整投票流程 |
| 日报开关 | `日报状态 开启/关闭/状态 [群ID]`；修改本群需群管/群主/主人，其他群需主人 |
| 日报预览 | `小猪日报 [群ID]`：本群管理者或主人使用，只出图，不结算保护；不是开关命令 |
| 排版 | `小猪排版 开启/关闭/状态`；修改仅主人 |
| 资源 | 主人使用 `同步小猪资源`、`同步小猪动图` / `同步小猪gif`、`同步小猪资源 全部`，可追加 `强制` |
| 更新 | 旧云崽 `小猪更新` / `小猪强制更新` / `小猪更新日志` 仍委托宿主更新器；**拉旧上游可能丢失本地适配**。NG 只提示更新双宿主版文件，不运行旧更新器 |
| 帮助 | `小猪帮助`、`小猪菜单`、`rollpig帮助` |

## 配置

旧云崽默认模板为 `config/default_config/config.yaml`，用户 YAML 与锅巴入口仍保留。NG 由 `ng/schema.js` 管理，可以用 NG 面板或编辑其主目录 `config/rollpig.yaml`；配置监听是否启用由 NG 决定。

| 配置键 | 默认 | 用途 |
| --- | --- | --- |
| `roast_cooldown_hours` | `8` | 普通烤猪恢复一次所需小时数 |
| `roast_charge_max` | `2` | 最多储存次数，运行上限 1–6 |
| `catalog_enabled` | `true` | 图片版图鉴 |
| `daily_summary_enabled` | `false` | 没有单独群配置时的日报推送默认值 |
| `daily_report_groups` | `{}` | 群ID → 开关，覆盖全局推送默认值 |
| `yesterday_style` | `recap` | `recap` 昨日回顾或 `pig` 小猪卡 |
| `pighub_enabled` | `true` | 随机与找猪功能，按需联网 |
| `render_scale` | `2` | 渲染倍率，1–4；旧渲染后端是否支持由其实现决定 |
| `qqbot_markdown_enabled` | `false` | 图片配 Markdown 详情；旧云崽按 QQBot/钉钉判断，NG 按适配器能力判断 |
| `reply_quote` | `true` | 请求引用触发消息 |
| `ai_enabled` | `false` | 可选外部 AI 烤猪文案，默认只用本地模板 |
| `ai_api_key` | 空 | OpenAI 兼容接口 Key；NG 标为敏感字段，但不是磁盘加密 |
| `ai_base_url` | `https://api.deepseek.com` | API 基址，追加 `/v1/chat/completions` |
| `ai_model` | `deepseek-chat` | 服务商模型名 |
| `ai_timeout` | `20` | 请求超时秒数 |
| `ai_max_tokens` | `512` | AI 最大输出 Token；运行最低 64 |

## 日报、存储与外部访问

- 业务日期统一 UTC+8，日报每天 **23:45（Asia/Shanghai）** 执行。关闭推送的活跃群仍结算次日保护；离线/渲染/发送失败不保证推送送达，但不阻止保护结算。停机不补发。
- 当前规则给被其他人成功烤最多且至少两次的一人次日本群普通免烤保护；加急/主人点火可绕过。手动预览不写保护。
- 单进程同步 JSON + 原子替换，保持旧玩家字段。损坏玩家 JSON 会令加载失败，避免清空覆盖；请备份并修复。超过14天的日期历史和超过7天的事件会在加载时清理，收集/成长另行保留。
- 两边独立存储，**不支持多进程共写、Cloud 同步或多实例协调**；同宿主多账号仍共享玩家数据，用户/群键未按平台隔离。
- 群投递记忆账号路由；原账号离线不会随意换未知账号。TRSS 路由存储在插件 `data/rollpig_routes.json`，NG 使用插件 KV。
- 命令和日报共用有界队列，NG 卸载会取消旧操作，重载等待其收尾。旧框架自身的热重载回收能力依实现而定，更新后建议重启。
- 启动不自动刷新 PigHub，也不下载资源。PigHub 随机/搜索、主人资源同步、开启 AI 后烤猪会请求外部服务；AI 会发送猪名称/描述、料理及群友昵称，可能产生费用。失败回退本地文案。
- 按钮、Markdown、转发、引用、成员查询由宿主适配器负责。不能保证每个平台效果一致；截图不保留 GIF 动画。

## 代码结构

```text
index.js                 # TRSS 入口，只加载旧宿主适配
ng/index.js              # NG definePlugin 入口
ng/schema.js             # NG 配置 schema
host/index.js            # 公共宿主门面与队列，不依赖任一框架
host/ng.js               # ctx/原生消息段
host/trss.js             # 旧 Bot、消息、渲染、定时任务适配
host/trss-event.js       # 旧事件转公共事件，不修改原 e.reply
host/trss-config.js      # 旧 YAML 配置读写与原配置迁移
apps/trss.js             # 公共命令包装为旧 plugin 类
apps/                    # 两边共用玩法命令
lib/setup.js             # 路径绑定后的公共初始化
lib/                     # 共用流程、存储、渲染数据与资源管理
resource/                # 两边共用内置图片、字体、模板
```

## 本地测试

```bash
node --test test/*.test.js
```

渲染与资源模块测试通过 VM 注入假宿主/HTTP，必要时自行启动带 `--experimental-vm-modules` 的测试子进程，插件启动不需要此标志。

NG 集成使用真实 `createApp` + mock 适配器；在非 NG 环境默认跳过，可指定 NG 框架目录：

```bash
YZNG_FRAMEWORK=/path/to/yunzai-ng node --test test/*.test.js
```

临时 NG 主目录建在框架检出目录的 `temp/`，不用真实账号和玩家文件。

本次在 Node.js 24.21.0 验证：

- 完整测试实际展开 **29 项全部通过**（显式启用 VM modules）；普通命令也通过，两个 VM 模块套件由子进程运行。
- 旧云崽根入口使用真实旧 `plugin` 基类、隔离的假账号/渲染器，验证7个命令类、5种模板调用、旧玩家收集保留、配置不被改写、重复抽取、权限和预约加入/投递；未启动真实旧云崽进程。
- NG 真实 `createApp` + mock 适配器验证预约、跨群隔离、日报、保护、持久化、卸载与重载；实际 Chromium 另行验证今日卡、图鉴、昨日回顾、本周长图和日报5种出图。
- 未在最低 Node 20.11 上执行。真实聊天账号与在线 PigHub、资源、AI 服务需要另行联调，单元测试不代表实号验证。

## 署名与许可

插件代码沿用 MIT；图片、字体、文案和第三方资源按各原作者许可，不把代码许可当作全部素材授权。

- 原作：[Bearlele/nonebot-plugin-rollpig](https://github.com/Bearlele/nonebot-plugin-rollpig)
- Plus：[Felis2026/nonebot-plugin-rollpig-plus](https://github.com/Felis2026/nonebot-plugin-rollpig-plus)
- Yunzai 移植：[LiuYunLingNai/rollpig-plugin](https://github.com/LiuYunLingNai/rollpig-plugin)
- 资源：[Felis2026/rollpig-resources](https://github.com/Felis2026/rollpig-resources)
- 图源：[PigHub](https://pighub.top/)
