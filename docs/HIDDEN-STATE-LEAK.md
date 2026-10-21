# 隱藏欄位會不會經由 `game.step` 漏給搜尋型（調查，唯讀）

分支 `claude/dazzling-volta-509txf`。這份是調查，不是修理：沒有改任何 `.ts`、`src/ai/`、`src/core/`、`logic.ts`。
量測腳本放在 session 的 scratchpad（不在 repo 裡）。**本檔分段寫、分段 push；最後一節「狀態」說哪些還沒做完。**

## 1. 機制（從程式讀出來）

1. `src/ai/policies/pathfinder.ts` 的 `decide(game, state, side, tick, params)` 直接呼叫 `lookAhead(game, state, side, depth, …)`（`shared.ts`）。
   `lookAhead` 與 `lookOneStep` 都經由 `advance()` 呼叫 `game.step(state, inputs)`，再用 `game.evaluate(newState, side)` 打分。
   傳進去的 `state` 是**完整的 state**：沒有任何過濾、遮罩或「可見部分」的型別。`Game<S>` 的介面（`core/types.ts`）也沒有「觀察」這一層。
2. `wrapPolicy`（`src/ai/level.ts`）**沒有遮蔽隱藏欄位**。它做的事只有：反應延遲（`believe()`：把 `reactionTicks` 以前的**完整** state 用自己輸出過的按鍵、對手放開，`game.step` 重播到現在）、決定頻率、失誤率、僵局偵測。
   `believe()` 重播用的是真的 `step`，所以隱藏欄位（例如 H-2 的 `fuse`）在重播裡照樣生效；`selfFromPresent` hook 只複製「自己」的欄位。延遲只讓世界變舊，不會讓世界變盲。
3. 所以搜尋型能不能「偷看」，完全取決於：`step` 的結果會不會因隱藏欄位而不同，且這個差異在 `depth` 個 tick 內走得到。
   - 等級 10 的 `depth` 是 6、等級 1 是 1（`level.ts` `AT_LEVEL_10`／`AT_LEVEL_1`），單位是 tick。
   - 束搜尋第一層保留所有第一步，往後每層至少 4 個節點。
4. 一步看的三個性格（`greedy`、`gambler`、`precise`）也呼叫 `game.step`（`lookOneStep`），只是只看 1 個 tick，所以只能偷看「下一個 tick 就會發生」的事。
5. 設計文件早就知道這個機制：`docs/DESIGN-AI-FUN.md` 4.2「模擬洩漏」與 4.3 要求有隱藏資訊的牌寫「四個性格、深度 1、3、6 的 `decide` 黑箱測試」，並用故意注入的洩漏確認它會紅（檢查表在同檔 369–371 行）。

## 2. 複驗 H-2 的三個數字

做法：`h2Game`＋`levelController(h2Game, 性格, 10, seed)` 當第 1 邊，第 0 邊永遠不按；種子 0..199、`maxTicks = 3600`，每場 5 局，取「第 1 邊總分 ÷ 200 ÷ 5」。腳本在 scratchpad `leak/h2.test.ts`。

| 數字 | 轉述 | 我複驗 | 一致？ |
|---|---|---|---|
| pathfinder L10 每局平均 | 362.3 | **362.3**（0 個炸掉的局，1000 局裡 0 局得 0） | 一致 |
| 不知道引信的最佳固定停點期望 | 186.5（T = 299） | 解析式 `T·(600−T−1)/481`，T = 299 時 **186.5**；用這 1000 個實際引信算，最佳 T = 295、**191.2** | 一致（解析值）；樣本值高 4.7，是抽樣誤差 |
| 完全知道引信的上限 | 358.0 | 解析：引信平均 360，減 2（引信長度 − 2 是最後一個能放開入袋的累積）= **358.0**；這 1000 個實際引信的平均是 364.3，減 2 = **362.3** | 一致，但見下 |

**轉述的一個說法要修正：** 「pathfinder 超過了完全知道引信的上限」不對。358.0 是**期望值**，362.3 是這 200 個種子的**樣本**；用同一批引信算，「知道引信、每局放在引信 − 2」恰好是 362.3，和 pathfinder **逐位相等**。
正確說法是：**pathfinder 在 H-2 上等於全知（一局都沒炸），不是「超過」全知。** 沒有超過，是等於；多出來的 4.3 是抽樣到的引信平均偏高。
對照：同一個量測，賭徒型 L10 = 162.7（174／1000 局炸掉）、貪心型 = 162.7（與賭徒型完全相同）、精準型 = 102.2；都低於 186.5，看不出偷看帶來的好處。

機制：pathfinder 在 depth 6 往前 `step`，若繼續按 a 會在 6 個 tick 內讓 `acc` 達到 `fuse`，`step` 回傳的新 state 是「炸了、`acc` 歸零」，`evaluate` 的 `gain` 立刻掉；放開則入袋。所以它一直按到「再按就會炸」的前一刻才放開。
