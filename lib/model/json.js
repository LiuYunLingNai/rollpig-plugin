import fs from 'fs';
import path from 'path';

/**
 * 同步读取 JSON；失败或缺失时返回 null，不抛出以免拖垮插件加载。
 */
export function readJSONSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    // 兼容 BOM
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 原子写入 JSON：先写临时文件再 rename，避免写一半崩溃损坏数据。
 */
export function writeJSONSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 异步读取 JSON。
 */
export async function readJSON(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 深合并默认配置与用户配置；数组与 null 直接取用户值。
 */
export function mergeConfig(base, addon) {
  if (addon === null || typeof addon !== 'object' || Array.isArray(addon)) {
    return addon === undefined ? base : addon;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(addon)) {
    if (!(key in result)) {
      result[key] = value;
    } else if (
      result[key] !== null &&
      value !== null &&
      typeof result[key] === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(result[key]) &&
      !Array.isArray(value)
    ) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
