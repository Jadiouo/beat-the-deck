import { describe, expect, it } from 'vitest';

import { PERSONALITIES, SITUATIONS, TAUNTS, pickTaunt, situationOf } from './taunts';

describe('shell/taunts（SPEC 7.4）', () => {
  it('四種性格、四個情境，每一組至少 5 句', () => {
    expect(PERSONALITIES).toHaveLength(4);
    expect(SITUATIONS).toHaveLength(4);
    for (const personality of PERSONALITIES) {
      for (const situation of SITUATIONS) {
        const lines = TAUNTS[personality][situation];
        expect(lines.length, `${personality}/${situation}`).toBeGreaterThanOrEqual(5);
        for (const line of lines) {
          expect(line.trim()).not.toBe('');
        }
      }
    }
  });

  it('同一組裡沒有重複的句子；全部加起來至少 80 句', () => {
    let total = 0;
    for (const personality of PERSONALITIES) {
      for (const situation of SITUATIONS) {
        const lines = TAUNTS[personality][situation];
        expect(new Set(lines).size).toBe(lines.length);
        total += lines.length;
      }
    }
    expect(total).toBeGreaterThanOrEqual(80);
  });

  it('同一個種子挑到同一句（重播時台詞一樣）', () => {
    for (const personality of PERSONALITIES) {
      for (const situation of SITUATIONS) {
        for (const seed of [0, 1, 42, 123456789]) {
          expect(pickTaunt(personality, situation, seed)).toBe(
            pickTaunt(personality, situation, seed),
          );
        }
      }
    }
  });

  it('挑出來的句子一定在那一組裡；不同種子會挑到不同的句子', () => {
    for (const personality of PERSONALITIES) {
      for (const situation of SITUATIONS) {
        const lines = TAUNTS[personality][situation];
        const seen = new Set<string>();
        for (let seed = 0; seed < 200; seed += 1) {
          const line = pickTaunt(personality, situation, seed);
          expect(lines).toContain(line);
          seen.add(line);
        }
        expect(
          seen.size,
          `${personality}/${situation} 只挑到 ${seen.size} 種`,
        ).toBeGreaterThanOrEqual(Math.min(lines.length, 4));
      }
    }
  });

  it('語氣：不嘲笑玩家本人（沒有人身攻擊的字眼）', () => {
    const banned = [
      '好爛',
      '很爛',
      '太爛',
      '廢物',
      '笨',
      '白癡',
      '智障',
      '垃圾',
      '弱爆',
      '菜鳥',
      '去死',
      '可悲',
      '活該',
      '蠢',
    ];
    for (const personality of PERSONALITIES) {
      for (const situation of SITUATIONS) {
        for (const line of TAUNTS[personality][situation]) {
          for (const word of banned) {
            expect(line, `${personality}/${situation}: ${line}`).not.toContain(word);
          }
        }
      }
    }
  });

  it('情境判斷：AI 贏、AI 輸、平手；人連輸三場（含這一場）用「連輸」', () => {
    expect(situationOf(1, 1)).toBe('aiWins');
    expect(situationOf(1, 2)).toBe('aiWins');
    expect(situationOf(1, 3)).toBe('streak');
    expect(situationOf(1, 5)).toBe('streak');
    expect(situationOf(0, 0)).toBe('aiLoses');
    expect(situationOf(null, 0)).toBe('draw');
    // 人贏或平手的時候，連輸次數不會大於 0；就算傳進來也不該變成 streak。
    expect(situationOf(0, 3)).toBe('aiLoses');
    expect(situationOf(null, 3)).toBe('draw');
  });
});
