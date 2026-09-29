import fs from 'fs';
import path from 'path';
import Path from '../../constants/path.js';
import { readJSONSync } from '../model/json.js';
import { MAX_EXPERT_LEVEL } from '../model/models.js';

const IMAGE_SUFFIX_PRIORITY = ['.gif', '.png'];

/**
 * 资源管理器，对应原 resource_manager.py。
 * 负责加载 pig.json（小猪列表）、pig_rules.json（特殊形态规则）、
 * pig_ex_variants.json（EX 差分）以及图片查找与形态解析。
 * Yunzai 版只加载内置资源，不做云端同步。
 */
class ResourceManager {
  constructor() {
    this.pigList = [];
    this.pigMap = {};
    this.foodPigIds = new Set();
    this.humanPigIds = new Set();
    this.eatenPigIds = new Set();
    this.soldPigIds = new Set();
    this.roastExcludedPigIds = new Set();
    this.imageDirs = [Path.image];
    this.exVariants = {}; // { pigId: { level: {image_path, description, analysis} } }
    this.resourceVersion = 'builtin';
    this.reload();
  }

  reload() {
    try {
      // 优先读取云端同步的 active 资源，缺失时回退内置。
      const activePigJson = path.join(Path.activeResourceDir, 'pig.json');
      const useActive = fs.existsSync(activePigJson);
      const pigJsonPath = useActive ? activePigJson : Path.pigJson;
      const rulesPath = useActive
        ? path.join(Path.activeResourceDir, 'pig_rules.json')
        : Path.rulesJson;
      const exVariantsPath = useActive
        ? path.join(Path.activeResourceDir, 'pig_ex_variants.json')
        : Path.exVariantsJson;

      const pigList = readJSONSync(pigJsonPath);
      if (!Array.isArray(pigList) || pigList.length === 0) {
        throw new Error('pig.json 为空或格式错误');
      }
      this.pigList = pigList;
      this.pigMap = {};
      for (const item of pigList) this.pigMap[String(item.id)] = item;

      // 图片查找优先级：GIF overlay > active > 内置。resolvePigAppearance/findImageFile
      // 走 .gif 优先，因此 overlay 里的 gif 会自动覆盖同 id 的静态 png。
      this.imageDirs = [];
      if (fs.existsSync(Path.gifOverlayImageDir)) this.imageDirs.push(Path.gifOverlayImageDir);
      if (useActive && fs.existsSync(Path.activeImageDir)) this.imageDirs.push(Path.activeImageDir);
      this.imageDirs.push(Path.image);

      const rules = fs.existsSync(rulesPath) ? readJSONSync(rulesPath) : {};
      this.foodPigIds = this._readIdSet(rules, 'food_pigs');
      this.humanPigIds = this._readIdSet(rules, 'human_pigs');
      this.eatenPigIds = this._readIdSet(rules, 'eaten_pigs');
      this.soldPigIds = this._readIdSet(rules, 'sold_pigs');
      this.roastExcludedPigIds = this._readIdSet(rules, 'roast_excluded_pigs');

      this._exVariantsPath = exVariantsPath;
      this.exVariants = this._loadExVariants();
      this.resourceVersion = useActive ? 'cloud' : 'builtin';

      logger?.info?.(
        `[今日小猪] 资源已加载: pigs=${this.pigList.length}, food=${this.foodPigIds.size}, variants=${Object.keys(this.exVariants).length}, imageDirs=${this.imageDirs.length}`
      );
    } catch (err) {
      logger?.error?.(`[今日小猪] 资源加载失败: ${err}`);
      if (!this.pigList.length) this.pigList = [];
    }
  }

  _readIdSet(rules, key) {
    const arr = rules?.[key];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  }

  _loadExVariants() {
    const exPath = this._exVariantsPath || Path.exVariantsJson;
    if (!fs.existsSync(exPath)) return {};
    try {
      const raw = readJSONSync(exPath);
      const variants = {};
      const items = Array.isArray(raw) ? raw : raw?.variants || [];
      for (const spec of items) {
        const pigId = String(spec.pig_id || '');
        const level = parseInt(spec.level, 10);
        if (!pigId || !Number.isFinite(level) || level < 1 || level > MAX_EXPERT_LEVEL) continue;
        if (!this.pigMap[pigId]) continue;
        const entry = { image_path: null, description: null, analysis: null };
        if (spec.filename) {
          const p = this.findNamedImageFile(String(spec.filename));
          if (p) entry.image_path = p;
        }
        if (typeof spec.description === 'string') entry.description = spec.description;
        if (typeof spec.analysis === 'string') entry.analysis = spec.analysis;
        (variants[pigId] = variants[pigId] || {})[level] = entry;
      }
      return variants;
    } catch (err) {
      logger?.warn?.(`[今日小猪] EX 差分加载失败: ${err}`);
      return {};
    }
  }

  findImageFile(pigId) {
    if (!pigId) return null;
    for (const dir of this.imageDirs) {
      for (const suffix of IMAGE_SUFFIX_PRIORITY) {
        const p = path.join(dir, `${pigId}${suffix}`);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  }

  findNamedImageFile(filename) {
    if (!filename || path.basename(filename) !== filename || filename.includes('\\')) return null;
    for (const dir of this.imageDirs) {
      const p = path.join(dir, filename);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  }

  getPigById(pigId) {
    if (!pigId) return null;
    return this.pigMap[String(pigId)] || null;
  }

  /**
   * 按当前 EX Lv. 解析差分外观。返回 { pig_data, image_path, base_image_path, applied_level }。
   */
  resolvePigAppearance(pigData, exLevel) {
    const resolved = { ...pigData };
    const pigId = String(resolved.id || '');
    const requestedLevel = Math.min(Math.max(parseInt(exLevel, 10) || 0, 0), MAX_EXPERT_LEVEL);
    const baseImagePath = pigId ? this.findImageFile(pigId) : null;
    let imagePath = baseImagePath;
    let appliedLevel = 0;

    if (pigId) {
      const levels = this.exVariants[pigId] || {};
      for (let candidate = 1; candidate <= requestedLevel; candidate++) {
        const variant = levels[candidate];
        if (!variant) continue;
        if (variant.image_path && !fs.existsSync(variant.image_path)) continue;
        if (variant.image_path) imagePath = variant.image_path;
        if (variant.description != null) resolved.description = variant.description;
        if (variant.analysis != null) resolved.analysis = variant.analysis;
        appliedLevel = candidate;
      }
    }
    return {
      pig_data: resolved,
      image_path: imagePath,
      base_image_path: baseImagePath,
      requested_level: requestedLevel,
      applied_level: appliedLevel,
      resource_version: this.resourceVersion,
    };
  }

  availableVariantLevels(pigId) {
    if (!pigId) return [];
    return Object.keys(this.exVariants[pigId] || {})
      .map(Number)
      .sort((a, b) => a - b);
  }

  newlyUnlockedVariantLevels(pigId, previousLevel, currentLevel) {
    const prev = Math.min(Math.max(previousLevel || 0, 0), MAX_EXPERT_LEVEL);
    const cur = Math.min(Math.max(currentLevel || 0, 0), MAX_EXPERT_LEVEL);
    if (cur <= prev) return [];
    return this.availableVariantLevels(pigId).filter((l) => prev < l && l <= cur);
  }

  variantSnapshotFields(pigId, level) {
    const variant = this.exVariants[pigId]?.[parseInt(level, 10) || 0];
    if (!variant) return new Set();
    const fields = new Set();
    if (variant.image_path) fields.add('image');
    if (variant.description != null) fields.add('description');
    if (variant.analysis != null) fields.add('analysis');
    return fields;
  }

  // ================= 形态判定 =================

  isFoodPig(pigData) {
    return !!(pigData && this.foodPigIds.has(String(pigData.id)));
  }
  isHumanPig(pigData) {
    return !!(pigData && this.humanPigIds.has(String(pigData.id)));
  }
  isEatenPig(pigData) {
    return !!(pigData && this.eatenPigIds.has(String(pigData.id)));
  }
  isSoldPig(pigData) {
    return !!(pigData && this.soldPigIds.has(String(pigData.id)));
  }
  isRoastExcludedPig(pigData) {
    return !!(pigData && this.roastExcludedPigIds.has(String(pigData.id)));
  }

  /** 攻击者是否还能被做成食物（特殊终态只走文字反噬）。 */
  canBackfireRoast(attackerPig) {
    return !!(
      attackerPig &&
      !this.isFoodPig(attackerPig) &&
      !this.isHumanPig(attackerPig) &&
      !this.isEatenPig(attackerPig) &&
      !this.isSoldPig(attackerPig)
    );
  }

  /** 随机取一个熟食模板猪。 */
  pickFoodPig() {
    const ids = [...this.foodPigIds].filter((id) => this.pigMap[id]);
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    return this.pigMap[id];
  }

  get pigListArr() {
    return this.pigList;
  }
}

const resourceManager = new ResourceManager();
export default resourceManager;

export function getPigById(pigId) {
  return resourceManager.getPigById(pigId);
}
export function findImageFile(pigId) {
  return resourceManager.findImageFile(pigId);
}
