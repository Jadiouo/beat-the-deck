/**
 * state 的雜湊，用來比對重播（SPEC 第 4 節）。
 *
 * 做法：先把值轉成一個「正規字串」（物件的鍵排序、型別有標記、
 * 字串用 JSON 跳脫），再用兩條獨立的 32 位元雜湊跑過整個字串，
 * 合成 16 個十六進位字元。這不是密碼學雜湊，只用來比對。
 *
 * 遇到 JSON 存不下的東西就丟錯，並指出欄位路徑，例如
 * `state.bullets[3].x`：NaN、Infinity、undefined、函式、符號、bigint、
 * 類別實例（Map、Date 等）與循環參照。
 */

type Path = string;

/**
 * 路徑的一段：數字是陣列索引、字串是物件的鍵。
 *
 * 路徑只有在丟錯的時候才會被讀到，所以不在每一層組字串，而是把走過的路徑堆在
 * `steps` 裡，等真的要丟錯了才組起來（`pathOf`）。
 * 原本的寫法在每一個陣列元素上都做一次 `${path}[${i}]` 的字串串接 ——
 * 一個 768 格的陣列就是 768 次字串配置，而 D-7 有四個這種陣列、每個 tick 都要雜湊一次，
 * 於是契約檢查 K4 有九成多的時間花在組永遠不會被人看到的錯誤訊息上（76 秒，上限 60 秒）。
 * 這個改法不動行為也不動介面：錯誤訊息與路徑格式完全一樣（`src/core/hash.test.ts` 在釘它）。
 */
type Step = string | number;

/** 把堆起來的路徑組成 `state.bullets[3].x` 這種字串。只在丟錯時呼叫。 */
function pathOf(root: string, steps: readonly Step[]): Path {
  let out = root;
  for (const step of steps) {
    out += typeof step === 'number' ? `[${step}]` : `.${step}`;
  }
  return out;
}

function fail(path: Path, what: string): never {
  throw new Error(`無法計算雜湊：${path} ${what}`);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 轉成正規字串。`ancestors` 用來偵測循環參照，`steps` 是目前的路徑（只在丟錯時才組成字串）。 */
function canonical(
  value: unknown,
  root: string,
  steps: Step[],
  ancestors: object[],
  out: string[],
): void {
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        fail(pathOf(root, steps), `是 ${String(value)}（state 不可以有 NaN 或 Infinity）`);
      }
      // String(-0) 是 "0"，與 JSON 來回之後的結果一致。
      out.push('n', String(value), ';');
      return;
    case 'string':
      out.push('s', JSON.stringify(value), ';');
      return;
    case 'boolean':
      out.push(value ? 'T;' : 'F;');
      return;
    case 'undefined':
      return fail(pathOf(root, steps), '是 undefined（state 必須是可 JSON 序列化的純資料）');
    case 'function':
      return fail(pathOf(root, steps), '是函式（state 不可以有函式）');
    case 'symbol':
      return fail(pathOf(root, steps), '是 symbol');
    case 'bigint':
      return fail(pathOf(root, steps), '是 bigint');
    case 'object':
      break;
  }

  if (value === null) {
    out.push('N;');
    return;
  }

  const obj = value as object;
  if (ancestors.includes(obj)) {
    fail(pathOf(root, steps), '有循環參照');
  }
  ancestors.push(obj);

  if (Array.isArray(obj)) {
    out.push('[', String(obj.length), ':');
    for (let i = 0; i < obj.length; i += 1) {
      steps.push(i);
      canonical(obj[i], root, steps, ancestors, out);
      steps.pop();
    }
    out.push(']');
  } else if (isPlainObject(obj)) {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.push('{', String(keys.length), ':');
    for (const key of keys) {
      out.push(JSON.stringify(key), '=');
      steps.push(key);
      canonical(record[key], root, steps, ancestors, out);
      steps.pop();
    }
    out.push('}');
  } else {
    const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? '未知';
    fail(pathOf(root, steps), `是類別實例（${name}），state 只能是純物件、陣列與基本型別`);
  }

  ancestors.pop();
}

/** 兩條 32 位元雜湊（FNV-1a 與 murmur 風格的乘法），合成 16 個十六進位字元。 */
function digest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 = Math.imul(h2 ^ text.length, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

/**
 * 計算值的雜湊。鍵的順序不影響結果；任何一個值不同結果就不同。
 *
 * @param value 要雜湊的東西，通常是遊戲的 state。
 * @param rootName 錯誤訊息裡的根名稱，預設 `state`。
 */
export function hashState(value: unknown, rootName = 'state'): string {
  const out: string[] = [];
  canonical(value, rootName, [], [], out);
  return digest(out.join(''));
}
