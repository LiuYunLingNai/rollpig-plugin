import { getContext } from '../../host/index.js';

// 配置统一由 NG schema、面板与 config/rollpig.yaml 管理。
const configControl = {
  get: () => getContext().config.get(),
  set: (key, value) => getContext().config.patch({ [key]: value }),
  setMultiple: patch => getContext().config.patch(patch),
  reload: () => getContext().config.get(),
};

export default configControl;
