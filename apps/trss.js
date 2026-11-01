import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Path from '../constants/path.js';
import { getContext, rememberGroup, runSerialized } from '../host/index.js';
import { normalizeTrssEvent } from '../host/trss-event.js';

/** Wrap only command classes, not helpers exported alongside them. */
export async function makeTrssApps(modules, options = {}) {
  const Plugin = options.Plugin ?? (await import(pathToFileURL(path.resolve(Path.root, '../../lib/plugins/plugin.js')).href)).default;
  const apps = {};
  const seen = new Set();
  for (const module of modules) {
    for (const [name, App] of Object.entries(module)) {
      if (typeof App !== 'function' || !/^class\s/.test(Function.prototype.toString.call(App)) || seen.has(App)) continue;
      const domain = new App();
      if (!Array.isArray(domain.rule) || !domain.rule.length) continue;
      seen.add(App);
      const handlers = [...new Set(domain.rule.map(rule => rule.fnc))];
      if (handlers.some(handler => typeof domain[handler] !== 'function')) throw new Error(`${name} 的命令处理器不存在`);
      const Wrapped = class extends Plugin {
        constructor() {
          const instance = new App();
          super({ name: instance.name, dsc: instance.dsc, event: instance.event,
            priority: instance.priority, rule: instance.rule.map(rule => ({ ...rule })) });
          for (const handler of handlers) {
            Object.defineProperty(this, handler, {
              value: e => {
                const host = options.host ?? getContext();
                const event = normalizeTrssEvent(e ?? this.e, host);
                return runSerialized(async () => {
                  await rememberGroup(event);
                  return instance[handler](event);
                }, host.signal);
              },
            });
          }
        }
      };
      Object.defineProperty(Wrapped, 'name', { value: name });
      apps[name] = Wrapped;
    }
  }
  return apps;
}
