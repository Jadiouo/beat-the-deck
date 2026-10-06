# 給 Claude Code 的工作規則

這個 repo 用「規格先行、測試先行」的方式開發。動手前先讀 `docs/SPEC.md` 與 `docs/TEST_PLAN.md`，再讀 `docs/TASKS.md` 裡你被指派的那個任務。

## 一定要遵守

1. **測試先寫。** 每個任務的順序固定：寫測試 → 跑一次確認是紅的 → 實作 → 跑到綠 → 重構。不要先寫實作再補測試。提交訊息裡分開：`test:` 一個 commit，`feat:` 一個 commit。
2. **模擬層是純的。** `src/core/`、`src/games/*/logic.ts`、`src/ai/` 裡面不可以出現 `Math.random`、`Date.now`、`performance.now`、`window`、`document`、`setTimeout`。亂數只能用傳進來的 `Rng`。時間只有 tick 數。有一條 lint 規則與一個測試在擋這件事，不要繞過它。
3. **`step` 不可以改動傳進來的 state。** 回傳新的 state。
4. **一個任務只碰自己的檔案。** 做某張牌時只動 `src/games/<card-id>/` 與 `docs/cards/<card-id>.md`，以及在 `src/games/registry.ts` 加一行。要改 `src/core/` 或 `src/ai/` 的介面時停下來，在 PR 說明裡寫清楚為什麼，不要順手改。這條是為了讓好幾個 session 可以同時做不同的牌而不衝突。
5. **不加執行期依賴。** 遊戲本體不用任何框架或遊戲引擎。開發依賴只有 SPEC 第 3 節列的那些；要加新的先在 PR 說明裡提出。
6. **規格沒寫的，不要自己發明規則然後當成已定案。** 做牌的任務第一步是寫那張牌的小規格（`docs/cards/<card-id>.md`），把你補上的決定列在「我做的決定」一節，讓人看得到。
7. **跑完整的檢查再說完成。** `npm run check` 要全綠（型別、lint、單元測試、契約測試）。沒跑過不要說做完了；有哪一項沒跑或沒過，在 PR 說明裡照實寫。
8. **不要為了讓測試過而放寬測試。** AI 行為測試的門檻在 TEST_PLAN 裡；過不了就回報數字，不要改門檻。

## 語言

- 文件、PR 說明、遊戲畫面上的文字：繁體中文。
- 程式碼、識別字、commit 訊息前綴：英文。
- 畫面文字集中放 `src/shell/strings.ts`，不要散在各處。

## PR 說明要有

- 做了什麼（對應 TASKS 的哪一項）
- 新增了哪些測試、現在總共幾個、全部通過與否
- 你做的、規格裡沒有的決定
- 沒做完或不確定的地方
