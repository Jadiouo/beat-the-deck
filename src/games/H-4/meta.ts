import type { CardMeta } from '../types';

/** H-4 比大小的 meta（SPEC 第 9 節；小規格 `docs/cards/H-4.md`）。 */
export const h4Meta: CardMeta = {
  id: 'H-4',
  name: '比大小',
  description:
    '兩人輪流從同一副 26 張的牌堆猜「下一張比桌上那張大還是小」，連對越多分越高，隨時可以收手存分；收手時桌上那張牌蓋著留給對方，對方要對著看不見的牌猜。',
  controls:
    '↑ 猜大、↓ 猜小、b（X）收手（連對至少 1 次才有效，存下連對的分）；猜錯扣 2 分、連對作廢。下方兩排小點是剩餘牌表：實心是還沒公開的牌、空心是已經丟掉的，亮色的實心是你自己看過的牌。你的蓋牌只有你看得到；AI 的收手是一條線索，它會用你過去收手時的牌判斷「收手是不是真的代表中間牌」。先存到 15 分的贏。',
  suit: 'H',
  rank: '4',
  defaultPolicy: 'pathfinder',
  baseLevel: 2,
  symmetric: true,
  luckHeavy: true,
};
