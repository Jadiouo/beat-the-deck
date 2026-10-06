import {
  describeSharedSnakeAi,
  describeSharedSnakeRules,
} from '../_clubs/shared-rules.test-helpers';
import { cAGame, makeState } from './logic';

/**
 * C-A 貪食蛇對決的規則測試（TEST_PLAN 第 6 節 C-A 的 11 條，外加邊界情況與種子）。
 * 測試本體在 `_clubs/shared-rules.test-helpers.ts`（C-2 旋轉的房間共用同一組），
 * 全部用 `makeState` 直接構造局面，不靠跑很多 tick 碰運氣。
 */

const suite = { label: 'C-A 貪食蛇對決', game: cAGame, makeState };

describeSharedSnakeRules(suite);
describeSharedSnakeAi(suite);
