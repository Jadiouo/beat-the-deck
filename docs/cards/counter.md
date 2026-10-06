# counter｜計數替身

> 這不是真的撲克牌。它是 `tests/fixtures/counter-game.ts` 的登記項，登記表裡標成 `kind: 'fixture'`，
> 用來讓契約測試、AI 框架與外殼在還沒有任何真牌的時候有東西可以跑。
> 第一張真牌（`C-A`）登記之後，這張替身牌仍然留著，繼續當契約測試自己的對照組。

## 規則

- 兩邊各有一個分數，一開始都是 0。
- 每個 tick，按著 A 的那一邊加 1 分。其他按鍵沒有作用。
- 一局 100 個 tick（`config.params.length` 可以改，但不會超過 `maxTicks`）。
- 時間到，分數高的贏；同分平手（`winner` 是 `null`）。

## 參數

| 參數 | 預設 | 意義 |
|---|---|---|
| `length` | 100 | 這一局的 tick 數，取它與 `config.maxTicks` 的較小值 |

## 資訊限制

沒有。state 就是 `{ seed, tick, length, scores }`，兩邊都看得到全部。

## 動作與評估

- `actions`：兩邊都固定兩個：全放開、只按 A。
- `evaluate`：`gain` 是自己的分數減對方的分數；`danger` 永遠是 0（沒有會死或被扣分的事）。

## 預設性格

沒有指定（`defaultPolicy: null`）。AI 行為測試對沒有預設性格的牌會跳過。

## 畫面

背景加左右兩條分數條，長度與分數成正比；只用色盤裡的顏色，全部畫在 320×240 之內。

## 我做的決定

規格（SPEC、TEST_PLAN）沒有寫替身牌怎麼登記，以下是 T2 補上的決定：

1. **id 是 `counter`，不是 `counter-game`。** 登記表的 id 與 `docs/cards/<id>.md` 同名，所以文件叫 `counter.md`。
   `Game.id` 仍然是 fixture 原本的 `counter-game`；meta 檢查只對真牌（`kind: 'card'`）要求兩者一致。
2. **用 `kind: 'fixture'` 旗標跳過花色與點數的檢查**，而不是靠 id 的樣子猜。替身牌的 `suit`、`rank` 必須是 `null`，
   id 也不能撞到 54 張牌的 id。
3. **標成 `symmetric: true`**，這樣 K12 有一張真的在跑的牌。用隨機控制器時兩邊勝率約一半，通過。
4. **`baseLevel` 是 1、`defaultPolicy` 是 `null`。** 它不在 SPEC 7.2 的等級表裡，隨便給最低的。
5. **名稱與說明是繁體中文，說明限一句話**（不換行、至多 80 字）。80 字是 meta 檢查自己訂的上限，SPEC 沒寫。
