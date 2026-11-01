// 用于组织玩法命令，不继承旧宿主插件基类。由 NG 入口登记每个原生命令。
export class CommandGroup {
  constructor(options) {
    Object.assign(this, options);
  }
}
