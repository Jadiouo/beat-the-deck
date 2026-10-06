/**
 * 主迴圈（SPEC 第 6 節、TEST_PLAN 3.4）。
 *
 * 做的事和 `playMatch` 一樣：每個 tick 推進一次模擬；只是 tick 之間插入畫面，
 * 並把「真實經過的時間」累積成固定長度的 tick（累加器做法）。
 * 真實時間是參數（`frame(nowMs)`），這個檔案本身不碰時鐘，所以測試可以用假的時鐘。
 */

export const TICKS_PER_SECOND = 60;
/** 一幀最多補幾個 tick；多的丟掉，避免分頁切回來時爆衝。 */
export const MAX_TICKS_PER_FRAME = 5;

const MS_PER_SECOND = 1000;

export interface LoopOptions {
  /** 推進模擬一個 tick。 */
  readonly onTick: () => void;
  /** 畫一幀（每一幀一次，在這一幀的 tick 之後；暫停中也會畫）。 */
  readonly onRender: () => void;
}

export interface Loop {
  /** 瀏覽器每一幀呼叫一次，傳入單調遞增的毫秒時間。回傳這一幀推進了幾個 tick。 */
  frame(nowMs: number): number;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** 加速（自動遊玩用）：真實時間乘上倍數，每幀上限也跟著放大。預設 1。 */
  setSpeed(multiplier: number): void;
}

export function createLoop(options: LoopOptions): Loop {
  // 累加器的單位是「毫秒 × 60」：累計滿 1000 單位就是 1 個 tick。
  // 這樣 1000 毫秒剛好是 60000 單位＝ 60 個 tick，不用除以 16.666…（浮點誤差會少一個）。
  let accumulator = 0;
  let lastNow: number | null = null;
  let paused = false;
  let speed = 1;

  return {
    frame(nowMs: number): number {
      let elapsed = lastNow === null ? 0 : nowMs - lastNow;
      if (!Number.isFinite(elapsed) || elapsed < 0) {
        elapsed = 0;
      }
      if (Number.isFinite(nowMs)) {
        lastNow = nowMs;
      }

      let ticks = 0;
      if (!paused) {
        accumulator += elapsed * speed * TICKS_PER_SECOND;
        const due = Math.floor(accumulator / MS_PER_SECOND);
        const cap = MAX_TICKS_PER_FRAME * speed;
        if (due > cap) {
          ticks = cap;
          accumulator = 0; // 多的丟掉，連餘數一起。
        } else {
          ticks = due;
          accumulator -= due * MS_PER_SECOND;
        }
      }
      for (let i = 0; i < ticks; i += 1) {
        options.onTick();
      }
      options.onRender();
      return ticks;
    },
    pause(): void {
      paused = true;
    },
    resume(): void {
      paused = false;
      // 暫停的時間不算：丟掉暫停前的餘數，lastNow 在暫停中仍然每幀更新，所以不會爆衝。
      accumulator = 0;
    },
    isPaused(): boolean {
      return paused;
    },
    setSpeed(multiplier: number): void {
      speed = Number.isFinite(multiplier) && multiplier >= 1 ? Math.floor(multiplier) : 1;
    },
  };
}
