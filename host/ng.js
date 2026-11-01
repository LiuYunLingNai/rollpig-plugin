import { seg, toSegments } from '@yunzai-ng/core';

// NG 能力全部由 ctx 提供；不加载旧宿主模块，也不注入全局对象。
export function createNgHost(ctx) {
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'kind') return 'ng';
      if (key === 'segment') return seg;
      if (key === 'toSegments') return toSegments;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
