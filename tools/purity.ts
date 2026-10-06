import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 純度檢查（TEST_PLAN 3.8、CLAUDE.md 第 2 條）。
 *
 * 模擬層必須是純的：不讀時鐘、不讀瀏覽器、不自己生亂數。這個檔案是
 * 掃描器；禁止清單與掃描範圍放在 `purity.config.json`，ESLint 的規則
 * 也從同一份設定長出來，兩邊不會各說各話。
 *
 * 這個檔案本身是開發工具，不在掃描範圍內，所以可以讀檔。
 */

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** repo 的根目錄。 */
export const REPO_ROOT = resolve(TOOLS_DIR, '..');

const CONFIG_PATH = join(TOOLS_DIR, 'purity.config.json');

/** 走訪原始碼時整個跳過的資料夾。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results']);

interface PurityConfig {
  readonly pureGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly forbidden: readonly string[];
}

function readStringArray(raw: Record<string, unknown>, key: string): readonly string[] {
  const value = raw[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`purity.config.json 的 ${key} 必須是字串陣列`);
  }
  return Object.freeze([...(value as string[])]);
}

function loadConfig(): PurityConfig {
  const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('purity.config.json 不是物件');
  }
  const record = raw as Record<string, unknown>;
  return {
    pureGlobs: readStringArray(record, 'pureGlobs'),
    excludeGlobs: readStringArray(record, 'excludeGlobs'),
    forbidden: readStringArray(record, 'forbidden'),
  };
}

const config = loadConfig();

/** 要掃的範圍（相對於 repo 根目錄）。 */
export const PURE_GLOBS: readonly string[] = config.pureGlobs;

/** 範圍內但不掃的（測試檔）。 */
export const EXCLUDE_GLOBS: readonly string[] = config.excludeGlobs;

/** 禁止出現的東西。 */
export const FORBIDDEN_PATTERNS: readonly string[] = config.forbidden;

/** 掃到的一處不純。 */
export interface Impurity {
  /** 相對於 repo 根目錄的路徑，一律用 `/`。 */
  readonly file: string;
  /** 從 1 開始。 */
  readonly line: number;
  /** 從 1 開始。 */
  readonly column: number;
  /** 禁止清單裡的哪一個。 */
  readonly pattern: string;
  /** 原始碼裡實際的那一段字。 */
  readonly text: string;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 glob 轉成正規表示式。支援 `*`（不跨 `/`）與 `**`（跨 `/`）。 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let i = 0;

  while (i < glob.length) {
    if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
      continue;
    }

    source += escapeForRegExp(glob[i]);
    i += 1;
  }

  return new RegExp(`^${source}$`);
}

const PURE_MATCHERS = PURE_GLOBS.map(globToRegExp);
const EXCLUDE_MATCHERS = EXCLUDE_GLOBS.map(globToRegExp);

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 這個檔案是不是模擬層的一部分（所以要是純的）。 */
export function isPureFile(relativePath: string): boolean {
  const path = toPosix(relativePath);
  if (EXCLUDE_MATCHERS.some((matcher) => matcher.test(path))) {
    return false;
  }
  return PURE_MATCHERS.some((matcher) => matcher.test(path));
}

/**
 * 禁止清單裡的每一項對應一條正規表示式。
 * 帶點的（`Math.random`）比對「物件．屬性」，中間可以有空白；
 * 不帶點的（`window`）比對整個識別字，所以 `windowSize` 不算。
 */
const PATTERN_MATCHERS: readonly { readonly pattern: string; readonly regexp: RegExp }[] =
  FORBIDDEN_PATTERNS.map((pattern) => {
    const dot = pattern.indexOf('.');
    const source =
      dot === -1
        ? `\\b${escapeForRegExp(pattern)}\\b`
        : `\\b${escapeForRegExp(pattern.slice(0, dot))}\\s*\\.\\s*${escapeForRegExp(
            pattern.slice(dot + 1),
          )}\\b`;
    return { pattern, regexp: new RegExp(source, 'g') };
  });

/** 掃一個檔案的內容。純函式：給一樣的輸入得到一樣的結果。 */
export function findImpurities(file: string, source: string): Impurity[] {
  const found: Impurity[] = [];
  const lines = source.split('\n');

  lines.forEach((lineText, index) => {
    const onThisLine: Impurity[] = [];

    for (const { pattern, regexp } of PATTERN_MATCHERS) {
      regexp.lastIndex = 0;
      let match = regexp.exec(lineText);
      while (match !== null) {
        onThisLine.push({
          file: toPosix(file),
          line: index + 1,
          column: match.index + 1,
          pattern,
          text: match[0],
        });
        match = regexp.exec(lineText);
      }
    }

    onThisLine.sort((a, b) => a.column - b.column);
    found.push(...onThisLine);
  });

  return found;
}

/** 列出 repo 裡所有要掃的檔案（相對路徑，排序過）。 */
export function listPureFiles(root: string = REPO_ROOT): string[] {
  const files: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(join(dir, entry.name), prefix === '' ? entry.name : `${prefix}/${entry.name}`);
        continue;
      }
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isPureFile(relativePath)) {
        files.push(relativePath);
      }
    }
  };

  walk(root, '');
  files.sort();
  return files;
}

/** 掃整個 repo 的模擬層。 */
export function scanPureSources(root: string = REPO_ROOT): Impurity[] {
  return listPureFiles(root).flatMap((relativePath) =>
    findImpurities(relativePath, readFileSync(join(root, relativePath), 'utf8')),
  );
}

/** 把結果變成人看得懂的訊息。沒有問題時回傳空字串。 */
export function formatImpurities(impurities: readonly Impurity[]): string {
  if (impurities.length === 0) {
    return '';
  }

  const lines = impurities.map(
    ({ file, line, column, pattern }) => `  ${file}:${line}:${column}  用了 ${pattern}`,
  );

  return [
    `模擬層必須是純的，但找到 ${impurities.length} 處不純（CLAUDE.md 第 2 條、TEST_PLAN 3.8）：`,
    ...lines,
    '亂數只能用傳進來的 Rng，時間只有 tick 數。',
  ].join('\n');
}
