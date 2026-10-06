# Beat the Deck

> Beat the machine 54 times, or become part of its training data.

一副 54 張牌的 AI 對戰街機。每張牌是一個小遊戲，你和 AI 在同一套規則下比分數。四個花色是四種遊戲機制，各自從 A 進化到 K；四個花色的 AI 各有一種性格。兩張鬼牌不比輸贏。

在瀏覽器裡玩，不需要安裝，不需要顯示卡。

## 狀態

還沒開始實作。這個 repo 目前只有規格文件，照文件由 Claude Code 的雲端 session 逐步做出來。

## 文件

| 檔案 | 內容 |
|---|---|
| `docs/SPEC.md` | 規格：這個東西是什麼、架構、遊戲契約、AI、54 張牌的表 |
| `docs/TEST_PLAN.md` | 測試計畫：先寫哪些測試、每一層測什麼、通過標準 |
| `docs/TASKS.md` | 任務清單：每一個任務是一個雲端 session 的量，附可以直接貼的指令 |
| `CLAUDE.md` | 給 Claude Code 的工作規則 |

## 怎麼開始

把 `docs/TASKS.md` 的 T0 那段指令貼給 Claude Code。T0 到 T4 要照順序做；之後每張牌的任務可以同時開好幾個 session。
