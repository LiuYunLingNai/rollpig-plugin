import fs from 'fs';
import YAML from 'yaml';
import Path from '../../constants/path.js';
import { readJSONSync } from './json.js';

// 默认值仅作兜底：真正的默认模板是 config/default_config/config.yaml，
// 用户配置在 config/config/config.yaml（首次运行自动从模板生成）。
const FALLBACK_CONFIG = {
  roast_cooldown_hours: 8,
  roast_charge_max: 2,
  catalog_enabled: true,
  daily_summary_enabled: false,
  daily_report_groups: {},
  yesterday_style: 'recap',
  pighub_enabled: true,
  render_scale: 2,
  qqbot_markdown_enabled: false,
  reply_quote: true,
  ai_enabled: false,
  ai_api_key: '',
  ai_base_url: 'https://api.deepseek.com',
  ai_model: 'deepseek-chat',
  ai_timeout: 20,
  ai_max_tokens: 512,
};

function readYaml(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logger?.warn?.(`[今日小猪] 配置读取失败 ${file}: ${err}`);
    return {};
  }
}

/**
 * 配置管理：以 YAML 为准，支持锅巴面板。
 * - config/default_config/config.yaml  默认模板（随插件分发，勿改）
 * - config/config/config.yaml          用户配置（生效文件，可手改或锅巴改）
 * 读取顺序：FALLBACK <- 默认模板 <- 用户配置。
 */
class ConfigControl {
  constructor() {
    this._cache = null;
  }

  _ensureUserConfig() {
    if (!fs.existsSync(Path.userConfigDir)) {
      fs.mkdirSync(Path.userConfigDir, { recursive: true });
    }
    // 首次运行：把默认模板复制成用户配置
    if (!fs.existsSync(Path.userConfigYaml) && fs.existsSync(Path.defaultConfigYaml)) {
      fs.copyFileSync(Path.defaultConfigYaml, Path.userConfigYaml);
    }
    // 旧版 data/config.json 迁移：仅首次，用户 YAML 优先
    if (fs.existsSync(Path.configFile)) {
      try {
        const legacy = readJSONSync(Path.configFile) || {};
        if (legacy && typeof legacy === 'object' && Object.keys(legacy).length) {
          const current = readYaml(Path.userConfigYaml);
          const merged = { ...legacy, ...current };
          fs.writeFileSync(Path.userConfigYaml, YAML.stringify(merged), 'utf8');
        }
        fs.renameSync(Path.configFile, Path.configFile + '.migrated');
      } catch (err) {
        logger?.warn?.(`[今日小猪] 旧配置迁移失败: ${err}`);
      }
    }
  }

  get() {
    if (this._cache) return this._cache;
    this._ensureUserConfig();
    const defaults = readYaml(Path.defaultConfigYaml);
    const user = readYaml(Path.userConfigYaml);
    this._cache = { ...FALLBACK_CONFIG, ...defaults, ...user };
    return this._cache;
  }

  /**
   * 写入配置项到用户 YAML 并刷新缓存。
   */
  set(key, value) {
    const user = readYaml(Path.userConfigYaml);
    user[key] = value;
    this._writeUser(user);
    this._cache = null;
    return this.get();
  }

  setMultiple(patch) {
    const user = readYaml(Path.userConfigYaml);
    Object.assign(user, patch);
    this._writeUser(user);
    this._cache = null;
    return this.get();
  }

  _writeUser(obj) {
    if (!fs.existsSync(Path.userConfigDir)) fs.mkdirSync(Path.userConfigDir, { recursive: true });
    const tmp = Path.userConfigYaml + '.tmp';
    fs.writeFileSync(tmp, YAML.stringify(obj), 'utf8');
    fs.renameSync(tmp, Path.userConfigYaml);
  }

  reload() {
    this._cache = null;
    return this.get();
  }
}

const configControl = new ConfigControl();
export default configControl;
export { FALLBACK_CONFIG };
