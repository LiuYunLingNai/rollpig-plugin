import fs from 'fs';
import Path from '../../constants/path.js';
import { readJSONSync } from '../model/json.js';

const PIGHUB_IMAGE_BASE_URL = 'https://pighub.top/data/';
const PIGHUB_ORIGIN = 'https://pighub.top/';
const PIGHUB_API_URLS = [
  'https://pighub.top/api/images?sort=2&limit=200',
  'https://pighub.top/api/images?sort=2',
  'https://pighub.top/api/all-images',
];
const PIGHUB_CACHE_TTL_SECONDS = 12 * 3600;
const PIGHUB_HTTP_TIMEOUT_MS = 10000;

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const thumbnail = item.thumbnail || item.image_url;
  if (typeof thumbnail !== 'string' || !thumbnail) return null;
  const filename = item.filename || thumbnail.split('/').pop();
  return {
    ...item,
    thumbnail,
    title: String(item.title || filename || '未命名小猪'),
    filename: String(filename || ''),
  };
}

/**
 * PigHub 图片索引服务，对应原 pighub_service.py。只缓存列表元数据。
 */
class PigHubService {
  constructor() {
    this.cacheFile = Path.pigHubCache;
    this.images = [];
    this.lastLoaded = 0;
    this._refreshing = null;
    this._loadCacheSync();
  }

  _loadCacheSync() {
    if (!fs.existsSync(this.cacheFile)) return;
    try {
      const payload = readJSONSync(this.cacheFile);
      const rawImages = payload?.images;
      if (!Array.isArray(rawImages)) return;
      const images = rawImages.map(normalizeItem).filter(Boolean);
      if (!images.length) return;
      this.images = images;
      this.lastLoaded = Number(payload.cached_at) || Date.now() / 1000;
    } catch {
      /* ignore */
    }
  }

  _saveCacheSync() {
    try {
      if (!fs.existsSync(Path.data)) fs.mkdirSync(Path.data, { recursive: true });
      const payload = { cached_at: Math.trunc(this.lastLoaded), images: this.images };
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload), 'utf8');
    } catch (err) {
      logger?.warn?.(`[PigHub] 缓存写入失败: ${err}`);
    }
  }

  isFresh(now = Date.now() / 1000) {
    return this.images.length > 0 && now - this.lastLoaded < PIGHUB_CACHE_TTL_SECONDS;
  }

  async ensureReady() {
    if (this.isFresh()) return true;
    if (this.images.length) {
      // 有旧缓存时后台刷新，立即返回可用
      this.refresh('stale-cache').catch(() => {});
      return true;
    }
    return this.refresh('first-load');
  }

  async refresh(reason = 'manual') {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._refreshFromRemote(reason).finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _refreshFromRemote(reason) {
    for (const apiUrl of PIGHUB_API_URLS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PIGHUB_HTTP_TIMEOUT_MS);
        const resp = await fetch(apiUrl, {
          headers: { 'User-Agent': 'RollPig-Yunzai/1.0' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const rawItems = Array.isArray(data?.data) ? data.data : data?.images;
        if (!Array.isArray(rawItems)) throw new Error('缺少 data/images 列表');
        const images = rawItems.map(normalizeItem).filter(Boolean);
        if (!images.length) throw new Error('空图集');
        this.images = images;
        this.lastLoaded = Date.now() / 1000;
        this._saveCacheSync();
        logger?.info?.(`[PigHub] 索引刷新完成: reason=${reason}, images=${images.length}`);
        return true;
      } catch (err) {
        logger?.warn?.(`[PigHub] 接口刷新失败，尝试备用接口: ${apiUrl}: ${err}`);
      }
    }
    if (this.images.length) return true;
    return false;
  }

  sample(count) {
    if (!this.images.length) return [];
    const poolSize = Math.max(1, Math.min(count, this.images.length));
    const pool = [...this.images];
    const result = [];
    for (let i = 0; i < poolSize; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool.splice(idx, 1)[0]);
    }
    return result;
  }

  search(keyword) {
    const lowered = keyword.toLowerCase();
    return this.images.filter(
      (item) =>
        String(item.title || '').toLowerCase().includes(lowered) ||
        String(item.filename || '').toLowerCase().includes(lowered)
    );
  }

  buildImageUrl(item) {
    const thumbnail = item?.thumbnail;
    if (typeof thumbnail !== 'string' || !thumbnail) return null;
    let url;
    if (thumbnail.startsWith('http://') || thumbnail.startsWith('https://')) {
      url = thumbnail;
    } else if (thumbnail.startsWith('/')) {
      url = PIGHUB_ORIGIN.replace(/\/$/, '') + thumbnail;
    } else {
      url = PIGHUB_IMAGE_BASE_URL + thumbnail.split('/').pop();
    }
    return url;
  }
}

const pighub = new PigHubService();
export default pighub;
