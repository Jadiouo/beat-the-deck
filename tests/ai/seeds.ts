import { seedList } from './harness';

/**
 * A1–A4（TEST_PLAN 5.1）用的種子數。種子清單固定為 `0..N-1`（TEST_PLAN 第 2 節）。
 *
 * 目前是 TEST_PLAN 5.1 寫的 200。TEST_PLAN 第 8 節授權：54 張牌跑完 `npm run check` 超過
 * 5 分鐘時，可以把這個數字降為 100，並在 PR 說明裡寫明；要降就改這一行，不要動門檻，
 * 也不要動 K12 的 200 個種子（那是 `SYMMETRY_SEEDS`）。
 */
export const AI_SEED_COUNT = 200;

export const AI_SEEDS: readonly number[] = seedList(AI_SEED_COUNT);
