/**
 * 網址參數（TEST_PLAN 第 7 節）：`?card=C-A&seed=1&autoplay=human-model`
 * 直接開一局，人那一邊交給人類模型代打（端到端測試用）。
 * 只在開發與測試建置有效；正式建置一律忽略，所以玩家不能用網址參數作弊。
 */

export interface Launch {
  readonly card: string;
  readonly seed: number;
  /** `human-model`：人那一邊由 `humanModel` 代打；null：人自己打。 */
  readonly autoplay: 'human-model' | null;
  /** 加速倍數。自動遊玩預設 30（一局不用等一分鐘），人自己打是 1。 */
  readonly speed: number;
}

const DEFAULT_SEED = 1;
const DEFAULT_AUTOPLAY_SPEED = 30;

export function parseLaunch(search: string, devBuild: boolean): Launch | null {
  if (!devBuild) {
    return null;
  }
  const params = new URLSearchParams(search);
  const card = params.get('card');
  if (card === null || card === '') {
    return null;
  }
  const rawSeed = params.get('seed');
  const seed = rawSeed !== null && /^-?\d+$/.test(rawSeed) ? Number(rawSeed) : DEFAULT_SEED;
  const autoplay = params.get('autoplay') === 'human-model' ? 'human-model' : null;
  const defaultSpeed = autoplay === null ? 1 : DEFAULT_AUTOPLAY_SPEED;
  const rawSpeed = params.get('speed');
  const speed =
    autoplay !== null && rawSpeed !== null && /^\d+$/.test(rawSpeed) && Number(rawSpeed) >= 1
      ? Number(rawSpeed)
      : defaultSpeed;
  return { card, seed: Number.isSafeInteger(seed) ? seed : DEFAULT_SEED, autoplay, speed };
}
