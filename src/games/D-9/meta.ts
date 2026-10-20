import type { CardMeta } from '../types';

/** D-9 擺放的 meta（SPEC 第 9 節；小規格 `docs/cards/D-9.md`）。 */
export const d9Meta: CardMeta = {
  id: 'D-9',
  name: '擺放',
  description:
    '每一輪你和 AI 同時各挑一個礦脈擺一個採集器，擺完跑 4 秒；每個礦脈存量有限、最多容納 2 個採集器，兩個一起採會把它對半分；最後抽到的單位多的贏。',
  controls:
    '左／上：游標跳到上一個礦脈；右／下：跳到下一個（按一下跳一格，要放開再按）。按 A（Z）：把採集器擺在游標指的礦脈並鎖定，鎖定了就不能改；按 B（X）：這一輪不擺。超過時間自動不擺。畫面上看得到每個礦脈的剩餘存量、已擺的採集器（綠是你、青是 AI）和過去每一輪雙方各挑了什麼；這一輪對方挑哪個，揭曉前只看得到「已鎖定」。',
  suit: 'D',
  rank: '9',
  defaultPolicy: 'precise',
  baseLevel: 3,
  symmetric: true,
};
