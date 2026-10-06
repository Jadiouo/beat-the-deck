# Beat the Deck｜任務清單

每個任務是一個雲端 session 的量。「指令」那段可以直接貼給 Claude Code。

## 順序

```
T0 → T1 → T2 → T3 → T4 ─┬→ 第一批十二張牌（可以同時開四個 session，一個花色一個）
                        ├→ JK-R 一起亂畫
                        └→ T5 部署
之後：每個花色的 4–10、J–K，仍然一個花色一個 session
```

T0 到 T4 **一定要照順序、一次一個**，因為它們在定義共用的介面。每一個合併進 `main` 之後再開下一個。
之後的牌任務互不相干，可以同時開。

---

## T0｜專案骨架

**做完的樣子**：`npm run check` 可以跑而且是綠的（只有一個示範測試）；GitHub Actions 的 check 步驟會跑。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 3、4 節與 `docs/TEST_PLAN.md` 第 1、8 節。建立專案骨架：Vite＋TypeScript（strict）＋Vitest＋ESLint＋Prettier，照 SPEC 第 4 節建立空的目錄結構，設定 `npm run check`、`npm run dev`、`npm run build`、`npm run e2e` 四個指令，並加上 GitHub Actions 的流程檔（先只有 check 步驟）。寫 TEST_PLAN 3.8 節的純度檢查測試與對應的 ESLint 規則。不要實作任何遊戲或核心邏輯。完成後開 PR。

---

## T1｜核心

**做完的樣子**：TEST_PLAN 3.1、3.2、3.3 的測試全部存在而且通過。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 2、5、6 節與 `docs/TEST_PLAN.md` 第 3.1 到 3.3 節。照測試先行的順序實作 `src/core/`：`types.ts`（照 SPEC 第 5 節，一字不改）、`rng.ts`、`hash.ts`、`match.ts`、`replay.ts`，以及測試用的 `tests/fixtures/counter-game.ts`。先把 3.1 到 3.3 列的每一條寫成測試並確認是紅的，再實作。如果你認為 SPEC 第 5 節的介面需要改，停下來在 PR 說明裡提出，不要直接改。完成後開 PR。

---

## T2｜契約測試與登記表

**做完的樣子**：`tests/contract/all-games.test.ts` 存在，對登記表跑 TEST_PLAN 第 4 節的 K1 到 K12、R1 到 R3 與 meta 檢查；登記表裡目前只有 counter-game，全部通過。另有一個故意違反契約的假遊戲，用來證明這組測試真的抓得到問題。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 5 節與 `docs/TEST_PLAN.md` 第 4 節。建立 `src/games/registry.ts` 與 `tests/contract/all-games.test.ts`，用 `describe.each` 對登記表裡每一張牌跑 K1 到 K12、R1 到 R3 與 meta 檢查。建立假的 2D context（記錄所有繪圖呼叫）與深度凍結的輔助函式。另外在 `tests/contract/bad-games/` 放幾個各自違反一條契約的假遊戲（用了 `Math.random` 的、`step` 會改 state 的、永遠不結束的、state 裡有 NaN 的），並寫測試確認契約檢查會對它們失敗。色盤還沒定義，R2 先讀 `src/shell/palette.ts`，這個檔案由你建立並放一套 16 色的色盤。完成後開 PR。

---

## T3｜AI

**做完的樣子**：TEST_PLAN 3.7 與 5.3 的測試通過；`tests/ai/harness.ts` 可用；四種性格加 `random` 與 `human-model` 都能在 counter-game 上跑。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 7 節與 `docs/TEST_PLAN.md` 第 3.7、5 節。照測試先行實作 `src/ai/`：四種性格（`pathfinder`、`precise`、`greedy`、`gambler`）、`random`、`human-model`、`level.ts`，以及 `tests/ai/harness.ts` 的 `winRate` 與 `evolutionReport`。性格只能透過 `Game` 介面的 `actions`、`step`、`evaluate` 工作，不可以知道自己在玩哪一張牌。把 TEST_PLAN 5.1 的 A1 到 A5 接進契約測試的迴圈（對 `meta` 沒有標示預設性格的牌跳過）。5.2 節的 P1 到 P5 要用到還不存在的牌，先寫成 `it.todo`。完成後開 PR。

---

## T4｜外殼

**做完的樣子**：`npm run dev` 打開看得到標題與 54 張牌的牌桌；選 counter-game 的替身牌可以玩完一局並看到結算；TEST_PLAN 3.4 到 3.6 與第 7 節的端到端測試通過（第 2、3 條先用替身牌）。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 8、7.4、7.5 節與 `docs/TEST_PLAN.md` 第 3.4 到 3.6、第 7 節。照測試先行實作 `src/shell/`：主迴圈、輸入（鍵盤、手把、觸控）、牌桌畫面、說明頁、對局畫面、結算頁（含重播）、進度存取、AI 台詞、「AI 進化」畫面、文字表。邏輯解析度 320×240，整數倍放大。54 張牌的格子都要畫出來，還沒實作的牌顯示成「尚未開放」。寫 Playwright 的四條端到端測試，並在 CI 加上 e2e 步驟。AI 台詞每種性格四個情境各至少 5 句，語氣是冷面的機器，不嘲笑玩家本人。完成後開 PR，PR 說明裡附一張牌桌的截圖。

---

## 第一批牌｜一個花色一個 session，可以同時開

四個指令只差花色。每個 session 做三張：A、2、3。

**做完的樣子**：三張牌各自的規則測試（TEST_PLAN 第 6 節列的每一條）、契約測試、AI 行為測試全部通過；在瀏覽器裡玩得起來。

**指令（梅花）**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 5、7、9、10 節與 `docs/TEST_PLAN.md` 第 4、5、6、9 節。實作梅花的 A、2、3 三張牌（`C-A`、`C-2`、`C-3`）。一張一張做，每張的順序：寫 `docs/cards/<id>.md` 小規格 → 把 TEST_PLAN 第 6 節那張牌的每一條寫成測試並確認是紅的 → 實作 `logic.ts` → 實作 `render.ts` 與 `meta.ts` → 登記 → 跑 `npm run check`。三張牌共用的邏輯放 `src/games/_clubs/`。只動 `src/games/C-*`、`src/games/_clubs/`、`docs/cards/C-*` 與登記表裡自己的那幾行。AI 行為測試過不了時，回報實際數字並調整這張牌的參數或 `evaluate`，不要改門檻。三張都做完後把 TEST_PLAN 5.2 節裡用到梅花的 `it.todo` 補成真的測試。完成後開 PR。

黑桃：把上面的「梅花」換成「黑桃」、id 換成 `S-A`、`S-2`、`S-3`、共用資料夾換成 `_spades`。
方塊：`D-A`、`D-2`、`D-3`、`_diamonds`。
紅心：`H-A`、`H-2`、`H-3`、`_hearts`。

---

## JK-R｜一起亂畫

可以跟第一批牌同時開。

**指令**：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 5、11 節與 `docs/TEST_PLAN.md` 第 4、9 節。實作鬼牌 `JK-R`。先寫 `docs/cards/JK-R.md`，把三支 AI 筆的行為寫成可以測試的規則（例如：跟隨者在第 t 個 tick 的位置是人在第 t−60 個 tick 的位置對畫布中心的鏡射）。規則測試至少包含：同一個種子與輸入畫出同一張圖（比對畫布雜湊）；人不下筆時畫布上沒有人的顏色；人停筆超過 180 tick 後三支 AI 筆的速度降到 0；跟隨者的鏡射關係；填充者不會走出畫布；唱反調的與人的距離平均大於畫布對角線的四分之一；`score` 固定是 `[0, 0]`。結束畫面加上存成 PNG 的功能。這張牌不跑 AI 行為測試。完成後開 PR，附三張不同種子的成品圖。

---

## T5｜部署

**指令**：

> 在 GitHub Actions 的流程檔加上 deploy 步驟：只在 `main` 分支，`npm run build` 後發布到 GitHub Pages。設定 Vite 的 `base` 讓網站在 `/<repo 名稱>/` 底下能正常運作。更新 README 的「狀態」一節並加上網址。完成後開 PR，並在說明裡寫清楚 repo 設定裡需要手動開啟的項目（Pages 的來源要選 GitHub Actions）。

---

## 之後的牌

每個花色的 4 到 10、J、Q、K，一個 session 做 2 到 3 張。指令的樣子：

> 讀 `CLAUDE.md`、`docs/SPEC.md` 第 5、7、9 節、`docs/TEST_PLAN.md` 第 4、5、9 節，以及 `docs/cards/` 裡這個花色已經完成的小規格。實作 `<id>`、`<id>`。每張牌先寫小規格：SPEC 第 9 節只給了一行方向，其餘的規則由你提出，寫在「我做的決定」一節。小規格寫完先停下來，把它貼在 PR 說明裡等我確認，再開始寫測試與實作。

先停下來確認小規格這一步不要省：那是你決定這張牌好不好玩的地方。
