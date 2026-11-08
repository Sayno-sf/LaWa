// 只扩大已核验的模型声明；未知兼容模型不能仅凭名称相似就声称拥有1M窗口。
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const MAX_FULL_SOURCE_TOKENS = 1_000_000;
export const MAX_SOURCE_READ_TOKENS = 32_000;
export const MAX_SOURCE_READ_CHARS = 128_000;
export const MAX_TURN_SOURCE_TOKENS = 128_000;

const millionTokenModels = new Set([
  "qwen3.8-flash", "qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-max-2026-09-02",
  "deepseek-v4.1-flash",
]);

export function modelContextWindow(model: string, fallback = FALLBACK_CONTEXT_WINDOW): number {
  if (millionTokenModels.has(model.toLowerCase())) return 1_000_000;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : FALLBACK_CONTEXT_WINDOW;
}

export function contextReserve(window: number): number {
  return Math.max(4096, Math.ceil(window * .1));
}
