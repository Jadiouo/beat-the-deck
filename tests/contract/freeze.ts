/**
 * 深度凍結：把一個值連同它底下所有的物件與陣列都 `Object.freeze`。
 *
 * 契約測試 K4 與 R1 用它來證明 `step`／`render` 沒有改動傳進來的 state：
 * 測試檔是 ES module，所以嚴格模式下對凍結物件的寫入會直接丟 TypeError。
 * 就地凍結並回傳同一個參考（不複製），所以測到的是遊戲真正拿到的那個物件。
 */
export function deepFreeze<T>(value: T): T {
  freezeInto(value, new WeakSet<object>());
  return value;
}

function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeInto((value as Record<PropertyKey, unknown>)[key], seen);
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
