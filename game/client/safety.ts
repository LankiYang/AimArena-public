// safety.ts — 玩家输入内容检测（B站 Toy checkInputSafety）
//
// 规则（来自 Toy SDK 文档）：
//   · 只在玩家“提交”时调用，不要逐键调用；有配额，限流会抛 code 307044。
//   · 返回 { passed, status }，status 只有 ok / rejected / unavailable。
//   · unavailable 表示检测没跑成，**不等于通过**；本 helper 只在 passed === true 时放行。
//   · 非 Toy 环境（普通网页 / 本地开发）没有 SDK，不做拦截。
import { getToyApi, isToyEnvironment, type CheckInputSafetyResp } from './toy.ts';

export interface InputSafetyResult {
  ok: boolean;
  message?: string;
}

const TIMEOUT_MS = 8000;
const MAX_BYTES = 16384;

/** 纯判定：只有明确 passed 才通过；rejected / unavailable 都拦截 */
export function safetyVerdict(res: CheckInputSafetyResp | null | undefined): InputSafetyResult {
  if (res?.passed === true) return { ok: true };
  if (res?.status === 'rejected') return { ok: false, message: '这个内容不能用，换一个试试' };
  return { ok: false, message: '暂时没法验证这个内容，稍后再试' };
}

export async function checkInputSafety(text: string, scene: string): Promise<InputSafetyResult> {
  const value = text.trim();
  if (!value) return { ok: false, message: '内容不能为空' };
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(value).length : value.length;
  if (bytes > MAX_BYTES) return { ok: false, message: '内容太长，请缩短后重试' };
  // 普通网页 / 本地开发没有 Toy SDK；不阻断正常网页玩法
  if (!isToyEnvironment()) return { ok: true };
  const api = getToyApi();
  if (!api?.checkInputSafety) return { ok: false, message: '暂时无法完成内容检测，请稍后再试' };

  let timer = 0;
  try {
    const res = await Promise.race([
      api.checkInputSafety({ text: value, scene }),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
      }),
    ]);
    return safetyVerdict(res);
  } catch (e) {
    const code = (e as { code?: number } | null)?.code;
    if (code === 307044) return { ok: false, message: '检测太频繁，请稍后再试' };
    if (e instanceof Error && e.message === 'timeout') return { ok: false, message: '内容检测超时，请稍后再试' };
    return { ok: false, message: '内容检测失败，请稍后再试' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}