import { it } from 'vitest';
import { levelController } from '../../ai/level';
import { humanModel } from '../../ai/human-model';
import { pathfinder } from '../../ai/policies/pathfinder';
import { h9Game } from './logic';
it('x', () => {
  const agg = { aiCalls: 0, aiCallsRight: 0, huCalls: 0, huCallsRight: 0, rounds: 0 };
  for (let seed = 0; seed < 60; seed++) {
    const ai = levelController(h9Game, pathfinder, 10, seed);
    const hu = humanModel(h9Game, seed + 1000);
    const aiSide = seed % 2 === 0 ? 0 : 1;
    let s = h9Game.init(seed, { maxTicks: 3600, params: {} });
    const cs = aiSide === 0 ? [ai, hu] : [hu, ai];
    let t = 0;
    while (!h9Game.isOver(s)) { s = h9Game.step(s, [cs[0].decide(s, 0, t), cs[1].decide(s, 1, t)] as any); t++; }
    for (const p of s.past) {
      agg.rounds++;
      const callerWon = !p.bidderWon;
      if (p.challenger === aiSide) { agg.aiCalls++; agg.aiCallsRight += callerWon ? 1 : 0; }
      else { agg.huCalls++; agg.huCallsRight += callerWon ? 1 : 0; }
    }
    if (seed < 3) console.log('TRACE', seed, aiSide, JSON.stringify(s.past.map(p => ({d: p.dice, b: p.bids.map(x => x.side+':'+x.S).join(' '), c: p.challenger, bw: p.bidderWon}))));
  }
  console.log('AGG', JSON.stringify(agg));
}, 120000);
