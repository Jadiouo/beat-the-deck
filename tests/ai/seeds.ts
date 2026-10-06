import { seedList } from './harness';

/**
 * A1–A4（TEST_PLAN 5.1）用的種子數。種子清單固定為 `0..N-1`（TEST_PLAN 第 2 節）。
 *
 * 依 TEST_PLAN 第 8 節的授權從 200 降為 100：「`npm run check` 超過 5 分鐘時，把 5.1 節的種子數
 * 從 200 降到 100，並在 PR 說明裡寫明」。實測（4 核）9 張牌的 `npm run check` 約 330 秒，
 * 其中 A1–A5 每張牌約 66 CPU 秒、種子數減半約省一半；54 張牌外推遠超 300 秒。
 * 統計檢查：各牌 A1 的最低實測勝率約 87.75%（梅花），100 場的標準誤約 3.3 個百分點，
 * 對 75% 門檻仍有約 3.9 個標準誤的餘裕。
 *
 * **改回 200 只要改下面這一行**（門檻、K12 的 200 個種子 `SYMMETRY_SEEDS` 都沒動）。
 */
export const AI_SEED_COUNT = 100;

export const AI_SEEDS: readonly number[] = seedList(AI_SEED_COUNT);
