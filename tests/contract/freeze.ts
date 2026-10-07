/**
 * 我們自己深度凍結過的物件。
 *
 * K4 與 R1 每個 tick 都對整個 state 呼叫一次 `deepFreeze`，而不可變更新會讓沒改到的
 * 子物件在相鄰的 tick 之間是同一個參考 —— D-7 有四個 768 格的陣列、一局 3600 個 tick，
 * 原本的寫法每個 tick 都把它們整個走一遍，於是 K4 要 76 秒（上限 60 秒）。
 * 記下走過的物件之後，同一個參考第二次就是 O(1)。
 *
 * **為什麼不用 `Object.isFrozen` 當判斷**：那樣不安全。牌可以自己做淺層凍結
 * （例如 `src/games/C-8/logic.ts` 的 `return Object.freeze({ ... })`），
 * 一個「自己凍了、小孩沒凍」的物件會被誤判成整棵都凍好了，K4 就測不到那些小孩被改動 ——
 * `bad-games.test.ts` 裡 `isDeepFrozen(Object.freeze({ a: { b: 1 } }))` 是 `false` 正是在講這件事。
 * 所以只跳過**我們自己**深度凍結過的物件，不拿「凍結」當「深度凍結」的代理。
 *
 * 用 `WeakSet` 所以不會阻止回收。
 */
const deepFrozen = new WeakSet<object>();

/**
 * 深度凍結：把一個值連同它底下所有的物件與陣列都 `Object.freeze`。
 *
 * 契約測試 K4 與 R1 用它來證明 `step`／`render` 沒有改動傳進來的 state：
 * 測試檔是 ES module，所以嚴格模式下對凍結物件的寫入會直接丟 TypeError。
 * 就地凍結並回傳同一個參考（不複製），所以測到的是遊戲真正拿到的那個物件。
 */
export function deepFreeze<T>(value: T): T {
  freezeInto(value);
  return value;
}

function freezeInto(value: unknown): void {
  if (typeof value !== 'object' || value === null || deepFrozen.has(value)) {
    return;
  }
  // 先記再遞迴：循環參照不會無限下去（與原本的 `seen` 同樣的作用）。
  deepFrozen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeInto((value as Record<PropertyKey, unknown>)[key]);
  }
  Object.freeze(value);
}

/** 是不是連最深的一層都凍結了。給輔助工具自己的測試用。 */
export function isDeepFrozen(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return true;
  }
  seen.add(value);
  if (!Object.isFrozen(value)) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) =>
    isDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen),
  );
}
