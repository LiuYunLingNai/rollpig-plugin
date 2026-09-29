import configControl from '../model/config.js';
import { pick } from '../model/texts.js';

// 烤猪文案生成器，对应原 roast_manager.py 的简化版。
// 默认使用内置模板；配置开启 AI 后调用 OpenAI 兼容接口生成更丰富的文案，失败时回退模板。

const DEFAULT_TEMPLATES = [
  '{origin}被送进烤炉，滋滋作响，最后成了一份{food}。',
  '经过一番烤制，{origin}散发出诱人的焦香，摇身变成了{food}。',
  '火候正好，{origin}被烤得外焦里嫩，端上桌就是一盘{food}。',
  '{origin}在炭火上翻了个身，油光锃亮，成了热气腾腾的{food}。',
  '孜然与辣椒面纷纷落下，{origin}最终化作一份令人垂涎的{food}。',
];

const PVP_TEMPLATES = [
  '{killer}手起夹落，把{origin}稳稳送上烤架，{victim}还没反应过来就成了{food}。',
  '{killer}掌勺，{origin}被烤得恰到好处，最后端出来的是一份{food}。',
  '在{killer}的火候把控下，{origin}逐渐变色，成了香喷喷的{food}。',
];

/**
 * 生成烤猪分析文案。
 * @param {object} originPig 原始小猪
 * @param {object} targetFood 目标熟食
 * @param {object} opts { operatorName, targetName }
 */
async function getRoastText(originPig, targetFood, opts = {}) {
  const cfg = configControl.get();
  const origin = originPig?.name || '小猪';
  const food = targetFood?.name || '烤猪';
  const { operatorName, targetName } = opts;

  if (cfg.ai_enabled && cfg.ai_api_key) {
    try {
      const aiText = await callAi(originPig, targetFood, cfg, opts);
      if (aiText) return aiText;
    } catch (err) {
      logger?.warn?.(`[今日小猪] AI 烤猪文案生成失败，回退模板: ${err}`);
    }
  }

  if (operatorName && targetName) {
    return formatTemplate(pick(PVP_TEMPLATES), { origin, food, killer: operatorName, victim: targetName });
  }
  return formatTemplate(pick(DEFAULT_TEMPLATES), { origin, food });
}

function formatTemplate(tpl, values) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (values[k] != null ? String(values[k]) : m));
}

async function callAi(originPig, targetFood, cfg, opts) {
  const origin = originPig?.name || '小猪';
  const originDesc = originPig?.description || '';
  const food = targetFood?.name || '烤猪';
  const isPvp = opts.operatorName && opts.targetName;
  const prompt = isPvp
    ? `用一句幽默的中文描述“${opts.operatorName}”把“${opts.targetName}”（形态：${origin}，${originDesc}）烤成了“${food}”的场景。不超过60字，不要换行，不要引号。`
    : `用一句幽默的中文描述把“${origin}”（${originDesc}）烤成了“${food}”的场景。不超过60字，不要换行，不要引号。`;

  const base = String(cfg.ai_base_url || 'https://api.deepseek.com').replace(/\/$/, '');
  const url = `${base}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(cfg.ai_timeout) || 20) * 1000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.ai_api_key}`,
      },
      body: JSON.stringify({
        model: cfg.ai_model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: Math.max(64, Number(cfg.ai_max_tokens) || 512),
        temperature: 1.1,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return text.replace(/\r?\n/g, ' ').slice(0, 240);
  } finally {
    clearTimeout(timer);
  }
}

const roastManager = { getRoastText };
export default roastManager;
export { getRoastText };
