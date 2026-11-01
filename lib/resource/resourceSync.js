import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getContext, hostFetch } from '../../host/index.js';
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
 * 校验清单提供的 sha256 / size，原子激活（先下到 staging，成功后整目录替换）。
 * 只下载 JSON 与图片文件，不接受或解包归档，不运行下载内容或外部命令。
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
function assertActive() {
  getContext().signal.throwIfAborted();
}

async function fetchBytes(url, maxSize) {
  assertActive();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let resp;
  let reader;
  try {
    resp = await hostFetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
    const contentLength = Number(resp.headers.get('content-length'));
    if (contentLength > maxSize) throw new Error(`文件超出大小上限: ${url}`);
    const chunks = [];
    let size = 0;
    reader = resp.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        assertActive();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxSize) throw new Error(`文件超出大小上限: ${url}`);
        chunks.push(Buffer.from(value));
      }
    }
    assertActive();
    controller.signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } catch (err) {
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
    else if (resp?.body) await resp.body.cancel().catch(() => {});
    throw err;
  } finally {
    reader?.releaseLock();
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
  // 同时遵守 POSIX/Windows 规则；拒绝 URL 转义、ADS、设备名和会被规范化的路径。
  if (typeof p !== 'string' || !p || /[\\\x00-\x1f\x7f<>:"|?*#%]/.test(p)) {
    throw new Error(`manifest 路径非法: ${p}`);
  }
  const parts = p.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || /^ |[. ]$/.test(x)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x))) {
    throw new Error(`manifest 路径非法: ${p}`);
  }
}

export function validateAssetFilename(filename) {
  validatePath(filename);
  if (filename.includes('/') || !/\.(?:gif|png|jpe?g|webp|avif|bmp)$/i.test(filename)) {
    throw new Error(`图片文件名非法: ${filename}`);
  }
  return filename;
}

/**
 * 把 manifest 里的相对 path 拼成完整下载 URL（相对 manifest URL）。
 */
function resolveUrl(manifestUrl, relPath) {
  validatePath(relPath);
  const base = new URL(manifestUrl);
  const url = new URL(relPath, base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error(`manifest 下载 URL 非法: ${relPath}`);
  }
  return url.href;
}

function validateMeta(meta, maxSize) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('manifest 文件条目非法');
  }
  const relPath = meta.path || meta.filename;
  validatePath(relPath);
  const expectedSize = meta.size != null ? Number(meta.size) : null;
  if (expectedSize != null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxSize)) {
    throw new Error(`文件大小非法或超出上限: ${relPath}`);
  }
  const expectedHash = String(meta.sha256 || '').toLowerCase();
  if (expectedHash && !SHA256_RE.test(expectedHash)) throw new Error(`sha256 格式非法: ${relPath}`);
  return { relPath, expectedSize, expectedHash };
}

function validateEntries(entries) {
  const seen = new Set();
  for (const { relPath, meta, maxSize } of entries) {
    validatePath(relPath);
    validateMeta(meta, maxSize);
    // Windows 默认不区分大小写，避免复用文件被另一个条目覆盖。
    const key = relPath.toLowerCase();
    if (seen.has(key)) throw new Error(`manifest 文件重复: ${relPath}`);
    seen.add(key);
  }
}

/**
 * 按 meta（path/size/sha256）下载并校验，写入 target。
 */
async function downloadByMeta(manifestUrl, meta, target, maxSize) {
  const { relPath, expectedSize, expectedHash } = validateMeta(meta, maxSize);
  const url = resolveUrl(manifestUrl, relPath);
  const buf = await fetchBytes(url, maxSize);
  assertActive();

  if (expectedSize != null && buf.length !== expectedSize) {
    throw new Error(`文件大小校验失败: ${relPath} (${buf.length} != ${expectedSize})`);
  }
  if (expectedHash) {
    const actual = sha256(buf);
    if (actual !== expectedHash) throw new Error(`sha256 校验失败: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf, { flag: 'wx' });
}

/**
 * 原子激活：把 staging 目录替换到 activeDir（先备份旧目录，失败回滚）。
 */
function activateDir(stagingDir, activeDir, stateFile, statePayload) {
  assertActive();
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
  assertActive();
  // mkdtemp 保证目录新建且为空，不复用任何下载/解包残留。
  const dir = fs.mkdtempSync(path.join(Path.resourceCache, `.staging_${prefix}_`));
  fs.mkdirSync(path.join(dir, 'images'));
  return dir;
}

/**
 * 核对本地已有文件是否与清单 meta 完全一致（大小 + SHA256）。
 *
 * 和原版 resource_manager.py 的 _local_file_matches_meta 对应：只认内容，
 * 不拿版本号或修改时间顶替，这样同版本但清单变化、或本地文件被删改的情况
 * 也能被识别出来重新下载。
 *
 * @param {string} filePath
 * @param {object} meta manifest 条目（size / sha256）
 * @returns {boolean}
 */
function localFileMatchesMeta(filePath, meta, maxSize) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > maxSize) return false;

  const expectedSize = meta.size != null ? Number(meta.size) : null;
  if (expectedSize != null && stat.size !== expectedSize) return false;

  const expectedHash = String(meta.sha256 || '').toLowerCase();
  if (!expectedHash) return true;
  if (!SHA256_RE.test(expectedHash)) return false;

  try {
    return sha256(fs.readFileSync(filePath)) === expectedHash;
  } catch {
    return false;
  }
}

/**
 * 扫描清单中的文件，挑出可直接从 active 目录硬链接复用的条目。
 *
 * @param {string} activeDir 当前生效目录
 * @param {Array<{relPath:string, meta:object}>} entries
 * @returns {Set<string>} 可复用的相对路径集合
 */
function collectReusable(activeDir, entries) {
  const reusable = new Set();
  if (!fs.existsSync(activeDir)) return reusable;
  if (!fs.lstatSync(activeDir).isDirectory()) return reusable;
  for (const { relPath, meta, maxSize } of entries) {
    validatePath(relPath);
    // 不跟随旧缓存中的目录链接（包括 Windows junction）。
    const parts = relPath.split('/');
    let parent = activeDir;
    let safe = true;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      try {
        if (!fs.lstatSync(parent).isDirectory()) safe = false;
      } catch {
        safe = false;
      }
    }
    if (safe && localFileMatchesMeta(path.join(activeDir, relPath), meta, maxSize)) reusable.add(relPath);
  }
  return reusable;
}

/**
 * 把可复用文件从旧目录硬链接到新 staging，失败时回退为复制。
 *
 * 增量同步只下载变化的文件，其余直接链接过来，省流量也省时间。
 *
 * @returns {Set<string>} 成功复用的相对路径
 */
function linkReusable(activeDir, stagingDir, relPaths) {
  const linked = new Set();
  for (const relPath of relPaths) {
    const from = path.join(activeDir, relPath);
    const to = path.join(stagingDir, relPath);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.linkSync(from, to);
      linked.add(relPath);
    } catch {
      try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        linked.add(relPath);
      } catch {
        // 单个文件复用失败不影响整体，后续会重新下载
      }
    }
  }
  return linked;
}

/**
 * 同步基础资源包（pig.json / pig_rules.json / 全部图片）。
 *
 * 按文件增量同步：清单里大小与 SHA256 都吻合的本地文件直接复用，
 * 只下载新增、变化或缺失的文件。即使版本号没变，只要清单变了
 * 或本地文件损坏也会重新核对，不再整体跳过。
 *
 * @param {object} opt { force }
 * @returns {Promise<{updated:boolean, skipped:boolean, version:string, images:number, message:string}>}
 */
export async function syncBaseResource({ force = false } = {}) {
  assertActive();
  fs.mkdirSync(Path.resourceCache, { recursive: true });
  const manifest = await fetchJson(BASE_MANIFEST_URL, MANIFEST_MAX_SIZE);
  const version = String(manifest.resource_version || '').trim();
  if (!version) throw new Error('manifest 缺少 resource_version');

  const sameVersion = version === readStateVersion(Path.resourceStateFile);

  // 先按清单算出全部文件，供复用核对与后续下载共用
  if (!manifest.pig_json || typeof manifest.pig_json !== 'object' || Array.isArray(manifest.pig_json)) {
    throw new Error('manifest 缺少 pig_json');
  }
  const optional = manifest.optional_files || {};
  const entries = [
    { relPath: 'pig.json', meta: manifest.pig_json, maxSize: PIG_JSON_MAX_SIZE },
    { relPath: 'pig_rules.json', meta: optional.pig_rules, maxSize: RULES_JSON_MAX_SIZE },
    { relPath: 'pig_ex_variants.json', meta: optional.pig_ex_variants, maxSize: RULES_JSON_MAX_SIZE },
  ].filter((item) => item.meta != null);

  const images = Array.isArray(manifest.images) ? manifest.images : [];
  if (images.length > MAX_IMAGES) throw new Error(`图片数量超出上限: ${images.length}`);
  for (const img of images) {
    if (typeof img !== 'object' || !img || Array.isArray(img)) throw new Error('manifest 图片条目非法');
    const filename = validateAssetFilename(img.filename);
    entries.push({ relPath: path.posix.join('images', filename), meta: img, maxSize: IMAGE_MAX_SIZE });
  }

  validateEntries(entries);
  // 同版本且所有文件都在且校验通过 → 真正没必要动
  const reusable = collectReusable(Path.activeResourceDir, entries);
  if (!force && sameVersion && reusable.size === entries.length) {
    return { updated: false, skipped: true, version, images: 0, message: `基础资源已是最新（${version}）` };
  }

  const staging = newStagingDir('base');
  try {
    const reused = linkReusable(Path.activeResourceDir, staging, reusable);

    let downloaded = 0;
    for (const { relPath, meta, maxSize } of entries) {
      if (reused.has(relPath)) continue;
      await downloadByMeta(BASE_MANIFEST_URL, meta, path.join(staging, relPath), maxSize);
      downloaded++;
    }

    activateDir(staging, Path.activeResourceDir, Path.resourceStateFile, {
      resource_version: version,
      synced_at: Date.now(),
    });

    const count = images.length;
    const detail = reused.size > 0
      ? `，复用 ${reused.size} 个，下载 ${downloaded} 个`
      : `，下载 ${downloaded} 个`;
    return { updated: true, skipped: false, version, images: count, message: `基础资源已更新到 ${version}，共 ${count} 张图${detail}` };
  } catch (err) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * 同步官方 GIF overlay（只下 images，同 id 覆盖静态图）。
 *
 * 与基础资源一样按文件增量：本地大小与 SHA256 都一致的 GIF 直接复用。
 */
export async function syncGifOverlay({ force = false } = {}) {
  assertActive();
  fs.mkdirSync(Path.resourceCache, { recursive: true });
  const manifest = await fetchJson(GIF_MANIFEST_URL, MANIFEST_MAX_SIZE);
  const version = String(manifest.resource_version || '').trim();
  if (!version) throw new Error('GIF manifest 缺少 resource_version');

  const sameVersion = version === readStateVersion(Path.gifOverlayStateFile);

  const images = Array.isArray(manifest.images) ? manifest.images : [];
  if (images.length > MAX_IMAGES) throw new Error(`GIF 数量超出上限: ${images.length}`);
  const entries = [];
  for (const img of images) {
    if (typeof img !== 'object' || !img || Array.isArray(img)) throw new Error('GIF manifest 图片条目非法');
    const filename = validateAssetFilename(img.filename);
    entries.push({ relPath: path.posix.join('images', filename), meta: img, maxSize: IMAGE_MAX_SIZE });
  }
  validateEntries(entries);

  const reusable = collectReusable(Path.gifOverlayDir, entries);
  if (!force && sameVersion && reusable.size === entries.length) {
    return { updated: false, skipped: true, version, images: 0, message: `GIF 动图已是最新（${version}）` };
  }

  const staging = newStagingDir('gif');
  try {
    const reused = linkReusable(Path.gifOverlayDir, staging, reusable);

    let downloaded = 0;
    for (const { relPath, meta, maxSize } of entries) {
      if (reused.has(relPath)) continue;
      await downloadByMeta(GIF_MANIFEST_URL, meta, path.join(staging, relPath), maxSize);
      downloaded++;
    }

    activateDir(staging, Path.gifOverlayDir, Path.gifOverlayStateFile, {
      resource_version: version,
      synced_at: Date.now(),
    });
    const count = entries.length;
    const detail = reused.size > 0
      ? `，复用 ${reused.size} 个，下载 ${downloaded} 个`
      : `，下载 ${downloaded} 个`;
    return { updated: true, skipped: false, version, images: count, message: `GIF 动图已更新到 ${version}，共 ${count} 张${detail}` };
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
