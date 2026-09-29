import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import Path from '../../constants/path.js';
import { readJSONSync } from '../model/json.js';

/**
 * 云端资源同步（对应原 resource_manager.py 的 sync_from_remote / GIF overlay）。
 *
 * 两个来源：
 * 1. 基础资源包 base manifest —— 更新 pig.json / pig_rules.json / 图片（含新猪）
 * 2. 官方 GIF overlay manifest —— 把部分静态图升级成 GIF 动图（同 id 覆盖）
 *
 * 下载后落到 data/resources 下，resourceManager 会优先读取这些目录（gif 优先）。
 * 全部下载校验 sha256 + size，原子激活（先下到 staging，成功后整目录替换）。
 */

const BASE_MANIFEST_URL = 'https://pig.felislab.cc/resources/rollpig/manifest.json';
const GIF_MANIFEST_URL = 'https://pig.felislab.cc/resources/rollpig-gif/manifest.json';

const MANIFEST_MAX_SIZE = 1 * 1024 * 1024;
const PIG_JSON_MAX_SIZE = 2 * 1024 * 1024;
const RULES_JSON_MAX_SIZE = 256 * 1024;
const IMAGE_MAX_SIZE = 16 * 1024 * 1024;
const MAX_IMAGES = 800;
const HTTP_TIMEOUT_MS = 30000;

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * 拉取字节流，带大小上限与超时。
 */
async function fetchBytes(url, maxSize) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > maxSize) throw new Error(`文件超出大小上限: ${url}`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, maxSize) {
  const buf = await fetchBytes(url, maxSize);
  // 去掉可能的 BOM
  const text = buf.toString('utf-8').replace(/^\uFEFF/, '');
  const data = JSON.parse(text);
  if (typeof data !== 'object' || data === null) throw new Error('manifest 不是 JSON object');
  return data;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验 manifest 文件路径合法（禁止绝对路径、越级、反斜杠）。
 */
function validatePath(p) {
  if (!p || p.startsWith('/') || p.includes('\\') || /^[a-z]+:\/\//i.test(p)) {
    throw new Error(`manifest 路径非法: ${p}`);
  }
  const parts = p.split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..')) {
    throw new Error(`manifest 路径非法: ${p}`);
  }
}

/**
 * 把 manifest 里的相对 path 拼成完整下载 URL（相对 manifest URL）。
 */
function resolveUrl(manifestUrl, relPath) {
  return new URL(relPath, manifestUrl).href;
}

/**
 * 按 meta（path/size/sha256）下载并校验，写入 target。
 */
async function downloadByMeta(manifestUrl, meta, target, maxSize) {
  const relPath = String(meta.path || meta.filename || '').trim();
  if (!relPath) throw new Error('manifest 文件条目缺少 path');
  validatePath(relPath);

  const expectedSize = meta.size != null ? Number(meta.size) : null;
  if (expectedSize != null && expectedSize > maxSize) {
    throw new Error(`文件超出大小上限: ${relPath}`);
  }

  const url = resolveUrl(manifestUrl, relPath);
  const buf = await fetchBytes(url, maxSize);

  if (expectedSize != null && buf.length !== expectedSize) {
    throw new Error(`文件大小校验失败: ${relPath} (${buf.length} != ${expectedSize})`);
  }
  const expectedHash = String(meta.sha256 || '').toLowerCase();
  if (expectedHash) {
    if (!SHA256_RE.test(expectedHash)) throw new Error(`sha256 格式非法: ${relPath}`);
    const actual = sha256(buf);
    if (actual !== expectedHash) throw new Error(`sha256 校验失败: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
}

/**
 * 原子激活：把 staging 目录替换到 activeDir（先备份旧目录，失败回滚）。
 */
function activateDir(stagingDir, activeDir, stateFile, statePayload) {
  const previousDir = activeDir + '.previous';
  // 清理残留
  if (fs.existsSync(previousDir)) fs.rmSync(previousDir, { recursive: true, force: true });
  let movedOld = false;
  try {
    if (fs.existsSync(activeDir)) {
      fs.renameSync(activeDir, previousDir);
      movedOld = true;
    }
    fs.renameSync(stagingDir, activeDir);
    fs.writeFileSync(stateFile, JSON.stringify(statePayload, null, 2), 'utf-8');
    if (fs.existsSync(previousDir)) fs.rmSync(previousDir, { recursive: true, force: true });
  } catch (err) {
    // 回滚
    if (fs.existsSync(activeDir) && !fs.existsSync(stagingDir)) {
      // active 已被新目录占用但后续失败，删掉重挂旧的
      fs.rmSync(activeDir, { recursive: true, force: true });
    }
    if (movedOld && fs.existsSync(previousDir) && !fs.existsSync(activeDir)) {
      fs.renameSync(previousDir, activeDir);
    }
    throw err;
  }
}

function readStateVersion(stateFile) {
  try {
    const state = readJSONSync(stateFile);
    return String(state?.resource_version || '');
  } catch {
    return '';
  }
}

function newStagingDir(prefix) {
  const dir = path.join(Path.resourceCache, `.staging_${prefix}_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  return dir;
}

/**
 * 同步基础资源包（pig.json / pig_rules.json / 全部图片）。
 * @param {object} opt { force }
 * @returns {Promise<{updated:boolean, skipped:boolean, version:string, images:number, message:string}>}
 */
export async function syncBaseResource({ force = false } = {}) {
  fs.mkdirSync(Path.resourceCache, { recursive: true });
  const manifest = await fetchJson(BASE_MANIFEST_URL, MANIFEST_MAX_SIZE);
  const version = String(manifest.resource_version || '').trim();
  if (!version) throw new Error('manifest 缺少 resource_version');

  if (!force && version === readStateVersion(Path.resourceStateFile)) {
    return { updated: false, skipped: true, version, images: 0, message: `基础资源已是最新（${version}）` };
  }

  const staging = newStagingDir('base');
  try {
    // pig.json（必需）
    if (typeof manifest.pig_json !== 'object') throw new Error('manifest 缺少 pig_json');
    await downloadByMeta(BASE_MANIFEST_URL, manifest.pig_json, path.join(staging, 'pig.json'), PIG_JSON_MAX_SIZE);

    // pig_rules.json（可选）
    const optional = manifest.optional_files || {};
    if (optional.pig_rules && typeof optional.pig_rules === 'object') {
      await downloadByMeta(BASE_MANIFEST_URL, optional.pig_rules, path.join(staging, 'pig_rules.json'), RULES_JSON_MAX_SIZE);
    }
    // pig_ex_variants.json（可选）
    if (optional.pig_ex_variants && typeof optional.pig_ex_variants === 'object') {
      await downloadByMeta(BASE_MANIFEST_URL, optional.pig_ex_variants, path.join(staging, 'pig_ex_variants.json'), RULES_JSON_MAX_SIZE);
    }

    // 图片
    const images = Array.isArray(manifest.images) ? manifest.images : [];
    if (images.length > MAX_IMAGES) throw new Error(`图片数量超出上限: ${images.length}`);
    let count = 0;
    for (const img of images) {
      if (typeof img !== 'object' || !img) continue;
      const filename = String(img.filename || '');
      if (!filename || path.basename(filename) !== filename) throw new Error(`图片文件名非法: ${filename}`);
      await downloadByMeta(BASE_MANIFEST_URL, img, path.join(staging, 'images', filename), IMAGE_MAX_SIZE);
      count++;
    }

    activateDir(staging, Path.activeResourceDir, Path.resourceStateFile, {
      resource_version: version,
      synced_at: Date.now(),
    });
    return { updated: true, skipped: false, version, images: count, message: `基础资源已更新到 ${version}，共 ${count} 张图` };
  } catch (err) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 同步官方 GIF overlay（只下 images，同 id 覆盖静态图）。
 */
export async function syncGifOverlay({ force = false } = {}) {
  fs.mkdirSync(Path.resourceCache, { recursive: true });
  const manifest = await fetchJson(GIF_MANIFEST_URL, MANIFEST_MAX_SIZE);
  const version = String(manifest.resource_version || '').trim();
  if (!version) throw new Error('GIF manifest 缺少 resource_version');

  if (!force && version === readStateVersion(Path.gifOverlayStateFile)) {
    return { updated: false, skipped: true, version, images: 0, message: `GIF 动图已是最新（${version}）` };
  }

  const staging = newStagingDir('gif');
  try {
    const images = Array.isArray(manifest.images) ? manifest.images : [];
    if (images.length > MAX_IMAGES) throw new Error(`GIF 数量超出上限: ${images.length}`);
    let count = 0;
    for (const img of images) {
      if (typeof img !== 'object' || !img) continue;
      const filename = String(img.filename || '');
      if (!filename || path.basename(filename) !== filename) throw new Error(`GIF 文件名非法: ${filename}`);
      await downloadByMeta(GIF_MANIFEST_URL, img, path.join(staging, 'images', filename), IMAGE_MAX_SIZE);
      count++;
    }
    activateDir(staging, Path.gifOverlayDir, Path.gifOverlayStateFile, {
      resource_version: version,
      synced_at: Date.now(),
    });
    return { updated: true, skipped: false, version, images: count, message: `GIF 动图已更新到 ${version}，共 ${count} 张` };
  } catch (err) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 读取当前已同步版本信息。
 */
export function getSyncState() {
  return {
    base: readStateVersion(Path.resourceStateFile) || '（未同步，使用内置）',
    gif: readStateVersion(Path.gifOverlayStateFile) || '（未同步）',
  };
}
