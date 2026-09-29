import url from 'url';
import path from 'path';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// 所有绝对路径统一在这里维护
const Path = {
  root: rootDir,
  apps: path.join(rootDir, 'apps'),
  lib: path.join(rootDir, 'lib'),
  constants: path.join(rootDir, 'constants'),
  resource: path.join(rootDir, 'resource'),
  image: path.join(rootDir, 'resource', 'image'),
  fonts: path.join(rootDir, 'resource', 'fonts'),
  pigJson: path.join(rootDir, 'resource', 'pig.json'),
  rulesJson: path.join(rootDir, 'resource', 'pig_rules.json'),
  exVariantsJson: path.join(rootDir, 'resource', 'pig_ex_variants.json'),
  // YAML 配置：default_config 为默认模板（随插件更新），config 为用户配置（不覆盖）
  defaultConfigDir: path.join(rootDir, 'config', 'default_config'),
  defaultConfigYaml: path.join(rootDir, 'config', 'default_config', 'config.yaml'),
  userConfigDir: path.join(rootDir, 'config', 'config'),
  userConfigYaml: path.join(rootDir, 'config', 'config', 'config.yaml'),
  data: path.join(rootDir, 'data'),
  dataFile: path.join(rootDir, 'data', 'pig_data.json'),
  configFile: path.join(rootDir, 'data', 'config.json'),
  pigHubCache: path.join(rootDir, 'data', 'pighub_images.json'),
  cardCache: path.join(rootDir, 'data', 'cards'),
  // 图床上传缓存（md5 -> 公网 URL，避免同图重复上传）
  // 云端资源同步缓存
  resourceCache: path.join(rootDir, 'data', 'resources'),
  activeResourceDir: path.join(rootDir, 'data', 'resources', 'active'),
  activeImageDir: path.join(rootDir, 'data', 'resources', 'active', 'images'),
  resourceStateFile: path.join(rootDir, 'data', 'resources', 'state.json'),
  gifOverlayDir: path.join(rootDir, 'data', 'resources', 'gif-overlay'),
  gifOverlayImageDir: path.join(rootDir, 'data', 'resources', 'gif-overlay', 'images'),
  gifOverlayStateFile: path.join(rootDir, 'data', 'resources', 'gif-overlay', 'state.json'),
  yunzai: path.join(rootDir, '../../'),
  index: path.join(rootDir, 'index.js'),
  pkg: path.join(rootDir, 'package.json'),
};

export default Path;
