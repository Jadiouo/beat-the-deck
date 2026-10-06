import { MATCH_CONFIG } from '../ai/evolution';
import { humanModel } from '../ai/human-model';
import { effectiveLevel, levelController, policyByName } from '../ai/level';
import { hashState } from '../core/hash';
import type { Controller, Inputs } from '../core/types';
import { CARD_IDS, findEntry } from '../games/registry';
import type { RegistryEntry } from '../games/types';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './canvas';
import type { ScreenCanvas } from './canvas';
import { cellAt, cellState, moveCursor } from './deck-view';
import type { DeckView } from './deck-view';
import { createEvolutionRun } from './evolve';
import { attachBrowserInput, emptyButtons, newPresses } from './input';
import type { InputSnapshot } from './input';
import type { Launch } from './launch';
import { createLoop } from './loop';
import { createMatchSession, createReplaySession, screenController } from './match-session';
import { COLOR } from './palette';
import { splitId } from './pixel';
import {
  cardLevel,
  currentGlobalLevel,
  loadProgress,
  recordResult,
  revealedCount,
  saveProgress,
  withSettings,
} from './progress';
import type { Outcome, Progress, StorageLike } from './progress';
import {
  RESULT_MENU_Y,
  TITLE_MENU_Y,
  drawBanner,
  drawEvolution,
  drawInfo,
  drawResult,
  drawScanlines,
  drawTable,
  drawTitle,
} from './screens';
import { strings } from './strings';
import { pickTaunt, situationOf } from './taunts';
import type { TauntPersonality } from './taunts';
import { prepareContext } from './text';
import { TOUCH_AREA_HEIGHT, createTouchControls } from './touch';

/**
 * 外殼的組裝：畫面流程（標題 → 牌桌 → 說明頁 → 對局 → 結算）、進度存取、主迴圈。
 * 每個畫面是一個 `Scene`：畫自己、處理這一幀新按下的鍵、每個 tick 做自己的事。
 * 畫布上的文字看不到 DOM，所以另外維護一份看不見的 DOM 鏡像（`#mirror`）：
 * 給讀螢幕的人，也給端到端測試讀（data-screen 是目前的畫面）。
 */

export interface AppOptions {
  readonly screen: ScreenCanvas;
  /** 看不見的 DOM 鏡像的容器。 */
  readonly mirror: HTMLElement;
  /** 虛擬按鍵放在哪裡（畫布的下面）。 */
  readonly touchParent: HTMLElement;
  readonly storage: StorageLike | null;
  /** 開發與測試建置的網址參數（正式建置是 null）。 */
  readonly launch: Launch | null;
}

interface Scene {
  draw(ctx: CanvasRenderingContext2D): void;
  /** 這一幀新按下的鍵。 */
  press?(presses: InputSnapshot): void;
  /** 主迴圈的每個 tick。 */
  tick?(): void;
  /** 點一下畫布（邏輯座標）。 */
  click?(x: number, y: number): void;
  /** 視窗失去焦點。 */
  blur?(): void;
}

const READY_TICKS = 90;
const OVER_HOLD_TICKS = 45;
const REPLAY_END_TICKS = 120;
const EVOLUTION_TICKS_PER_GAME = 12;
const EVOLUTION_MIN_TICKS = 300;

function personalityOf(entry: RegistryEntry): TauntPersonality {
  return entry.meta.defaultPolicy ?? 'pathfinder';
}

function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  testId?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (testId !== undefined) {
    node.dataset['testid'] = testId;
  }
  return node;
}

export function startApp(options: AppOptions): void {
  const { screen, mirror, storage } = options;
  const ctx = screen.ctx;
  prepareContext(ctx);

  let progress: Progress = loadProgress(storage);
  const updateProgress = (next: Progress): void => {
    progress = next;
    saveProgress(storage, progress);
  };

  const input = attachBrowserInput(window);
  const touch = createTouchControls(options.touchParent, (buttons) => input.setTouch(buttons));
  const refit = (): void => {
    const showing = touch.refresh(window.innerWidth);
    screen.refit(showing ? TOUCH_AREA_HEIGHT : 0);
  };
  refit();
  window.addEventListener('resize', refit);

  let snapshot: InputSnapshot = { buttons: emptyButtons(), confirm: false, pause: false };
  let scene: Scene;

  const loop = createLoop({
    onTick: () => scene.tick?.(),
    onRender: () => {
      scene.draw(ctx);
      if (progress.settings.scanlines) {
        drawScanlines(ctx);
      }
    },
  });

  // ---- 看不見的 DOM 鏡像 ----
  const setMirror = (
    attributes: Readonly<Record<string, string>>,
    children: readonly HTMLElement[],
  ): void => {
    for (const key of Object.keys(mirror.dataset)) {
      delete mirror.dataset[key];
    }
    for (const [key, value] of Object.entries(attributes)) {
      mirror.dataset[key] = value;
    }
    mirror.replaceChildren(...children);
  };

  const setScene = (next: Scene): void => {
    scene = next;
  };

  // ---- 標題 ----
  const titleScene = (): Scene => {
    let cursor = 0;
    const sync = (): void => {
      const heading = element('h1', strings.title, 'title');
      const tagline = element('p', strings.tagline);
      const start = element('button', strings.titleScreen.start, 'menu-start');
      const scan = element(
        'button',
        `${strings.titleScreen.scanlines}：${progress.settings.scanlines ? strings.titleScreen.on : strings.titleScreen.off}`,
        'menu-scanlines',
      );
      setMirror({ screen: 'title', cursor: String(cursor) }, [heading, tagline, start, scan]);
    };
    const activate = (): void => {
      if (cursor === 0) {
        setScene(tableScene(0));
      } else {
        updateProgress(withSettings(progress, { scanlines: !progress.settings.scanlines }));
        sync();
      }
    };
    sync();
    return {
      draw: (c) => drawTitle(c, { cursor, scanlines: progress.settings.scanlines }),
      press(p) {
        if (p.buttons.up || p.buttons.down) {
          cursor = cursor === 0 ? 1 : 0;
          sync();
        } else if (p.confirm) {
          activate();
        }
      },
      click(_x, y) {
        const hit = TITLE_MENU_Y.findIndex((top) => y >= top - 4 && y < top + 20);
        if (hit >= 0) {
          cursor = hit;
          activate();
        }
      },
    };
  };

  // ---- 牌桌 ----
  const implemented = (id: string): boolean => findEntry(id) !== undefined;

  const tableScene = (startCursor: number): Scene => {
    let cursor = startCursor;
    const view = (): DeckView => ({ progress, cursor, implemented });

    const describe = (index: number): { line1: string; line2: string } => {
      const id = CARD_IDS[index] as string;
      const entry = findEntry(id);
      const state = cellState(progress, id, entry !== undefined);
      const name = entry === undefined ? id : strings.table.cardLine(id, entry.meta.name);
      let status = '';
      switch (state) {
        case 'revealed':
          status = `${strings.table.revealed}\u3000${strings.table.best(progress.cards[id]?.best ?? 0)}`;
          break;
        case 'playable':
          status = strings.table.playable;
          break;
        case 'unimplemented':
          status = strings.table.unimplemented;
          break;
        case 'locked':
          status =
            id === 'JK-R'
              ? strings.table.lockedJoker(13)
              : id === 'JK-B'
                ? strings.table.lockedJoker(40)
                : strings.table.locked(CARD_IDS[index - 1] as string);
          break;
      }
      return {
        line1: `${name}\u3000${status}`,
        line2: strings.table.progress(
          revealedCount(progress),
          CARD_IDS.length,
          currentGlobalLevel(progress),
        ),
      };
    };

    const sync = (): void => {
      const items = CARD_IDS.map((id, index) => {
        const entry = findEntry(id);
        const state = cellState(progress, id, entry !== undefined);
        const item = element(
          'li',
          strings.mirror.cardLabel(id, entry?.meta.name ?? id, state),
          `card-${id}`,
        );
        item.dataset['state'] = state;
        item.dataset['revealed'] = String(state === 'revealed');
        if (index === cursor) {
          item.setAttribute('aria-current', 'true');
        }
        return item;
      });
      const list = element('ul');
      list.append(...items);
      const summary = element('p', describe(cursor).line1, 'table-selected');
      const progressLine = element('p', describe(cursor).line2, 'table-progress');
      setMirror({ screen: 'table', cursor: CARD_IDS[cursor] as string }, [
        list,
        summary,
        progressLine,
      ]);
    };

    const select = (): void => {
      const id = CARD_IDS[cursor] as string;
      const entry = findEntry(id);
      if (entry === undefined) {
        return;
      }
      const state = cellState(progress, id, true);
      if (state === 'playable' || state === 'revealed') {
        setScene(infoScene(entry));
      }
    };

    sync();
    return {
      draw: (c) => drawTable(c, view(), describe(cursor)),
      press(p) {
        const direction = p.buttons.up
          ? 'up'
          : p.buttons.down
            ? 'down'
            : p.buttons.left
              ? 'left'
              : p.buttons.right
                ? 'right'
                : null;
        if (direction !== null) {
          cursor = moveCursor(cursor, direction);
          sync();
        } else if (p.confirm) {
          select();
        } else if (p.buttons.b) {
          setScene(titleScene());
        }
      },
      click(x, y) {
        const hit = cellAt(x, y);
        if (hit === null) {
          return;
        }
        if (hit === cursor) {
          select();
        } else {
          cursor = hit;
          sync();
        }
      },
    };
  };

  // ---- 說明頁 ----
  const infoScene = (entry: RegistryEntry): Scene => {
    const meta = entry.meta;
    const personality = personalityOf(entry);
    const level = cardLevel(progress, meta.baseLevel);
    const best = progress.cards[entry.id]?.best ?? null;
    const labels = strings.personality[personality];

    const children = [
      element('h2', meta.name, 'info-name'),
      element('p', meta.description, 'info-rules'),
      element('p', meta.controls, 'info-controls'),
      element('p', strings.info.opponentLine(labels.name, level), 'info-opponent'),
    ];
    setMirror({ screen: 'info', card: entry.id }, children);

    const start = (): void => startMatch(entry, newSeed(), false);
    return {
      draw: (c) =>
        drawInfo(c, {
          suit: splitId(entry.id).suit,
          id: entry.id,
          name: meta.name,
          description: meta.description,
          controls: meta.controls,
          personality: labels.name,
          blurb: labels.blurb,
          level,
          best,
        }),
      press(p) {
        if (p.confirm) {
          start();
        } else if (p.buttons.b) {
          setScene(tableScene(CARD_IDS.indexOf(entry.id)));
        }
      },
      click: start,
    };
  };

  // ---- 對局 ----
  interface EvolutionPlan {
    readonly entry: RegistryEntry;
    readonly oldLevel: number;
    readonly newLevel: number;
    readonly seed: number;
  }

  interface FinishedMatch {
    readonly entry: RegistryEntry;
    readonly seed: number;
    readonly inputs: readonly Inputs[];
    readonly finalHash: string;
    readonly scores: readonly [number, number];
    readonly outcome: Outcome;
    readonly taunt: string;
    readonly notes: readonly string[];
    evolution: EvolutionPlan | null;
  }

  const startMatch = (entry: RegistryEntry, seed: number, autoplay: boolean): void => {
    const meta = entry.meta;
    const level = cardLevel(progress, meta.baseLevel);
    const ai: Controller<unknown> = levelController(
      entry.game,
      policyByName(personalityOf(entry)),
      level,
      seed,
    );
    const human: Controller<unknown> = autoplay
      ? humanModel(entry.game, seed)
      : screenController(() => snapshot.buttons);
    const session = createMatchSession(entry.game, seed, MATCH_CONFIG, human, ai);

    let readyTicks = autoplay ? 0 : READY_TICKS;
    let overTicks = 0;
    let paused = false;
    let finished = false;

    const phase = (): string =>
      session.isOver() ? 'over' : paused ? 'paused' : readyTicks > 0 ? 'ready' : 'playing';
    const syncMirror = (): void =>
      setMirror({ screen: 'match', card: entry.id, phase: phase() }, []);
    syncMirror();

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (autoplay) {
        loop.setSpeed(1);
      }
      const state = session.state();
      const scores = entry.game.score(state);
      const winner = entry.game.winner(state);
      const isJoker = entry.id.startsWith('JK');
      const outcome: Outcome = isJoker
        ? 'win'
        : winner === 0
          ? 'win'
          : winner === 1
            ? 'loss'
            : 'draw';
      const before = progress;
      const previous = before.cards[entry.id];
      const levelBefore = currentGlobalLevel(before);
      updateProgress(recordResult(before, entry.id, scores[0], outcome));
      const levelAfter = currentGlobalLevel(progress);

      const notes: string[] = [];
      if (outcome === 'win' && previous?.won !== true) {
        notes.push(strings.result.revealed);
      }
      if (previous !== undefined && scores[0] > previous.best) {
        notes.push(strings.result.newBest);
      }

      const situation = situationOf(winner, progress.lossStreak);
      const result: FinishedMatch = {
        entry,
        seed,
        inputs: session.inputs(),
        finalHash: hashState(state),
        scores,
        outcome,
        taunt: pickTaunt(personalityOf(entry), situation, seed),
        notes,
        evolution:
          levelAfter > levelBefore
            ? {
                entry,
                oldLevel: effectiveLevel(levelBefore, meta.baseLevel),
                newLevel: effectiveLevel(levelAfter, meta.baseLevel),
                seed,
              }
            : null,
      };
      setScene(resultScene(result));
    };

    setScene({
      draw(c) {
        c.save();
        entry.render(c, session.state());
        c.restore();
        if (paused) {
          drawBanner(c, strings.match.paused, strings.match.pausedHint);
        } else if (readyTicks > 0) {
          drawBanner(c, strings.match.ready, String(Math.ceil(readyTicks / 30)));
        }
      },
      tick() {
        if (paused || finished) {
          return;
        }
        if (readyTicks > 0) {
          readyTicks -= 1;
          if (readyTicks === 0) {
            syncMirror();
          }
          return;
        }
        if (session.isOver()) {
          overTicks += 1;
          if (overTicks >= (autoplay ? 1 : OVER_HOLD_TICKS)) {
            finish();
          }
          return;
        }
        session.advance();
        if (session.isOver()) {
          syncMirror();
        }
      },
      press(p) {
        if (p.pause && !session.isOver()) {
          paused = !paused;
          if (paused) {
            loop.pause();
          } else {
            loop.resume();
          }
          syncMirror();
        } else if (paused && p.buttons.b) {
          paused = false;
          loop.resume();
          setScene(tableScene(CARD_IDS.indexOf(entry.id)));
        } else if (session.isOver() && p.confirm) {
          finish();
        }
      },
      blur() {
        if (!paused && !session.isOver() && readyTicks === 0) {
          paused = true;
          loop.pause();
          syncMirror();
        }
      },
    });
  };

  // ---- 結算 ----
  /** 離開結算頁：如果這場讓全域等級升級了，先看一次「AI 進化」。 */
  const leaveResult = (result: FinishedMatch, destination: () => void): void => {
    const plan = result.evolution;
    if (plan === null) {
      destination();
      return;
    }
    result.evolution = null;
    setScene(evolutionScene(plan, destination));
  };

  const resultScene = (result: FinishedMatch): Scene => {
    let cursor = 0;
    const meta = result.entry.meta;
    const headline =
      result.outcome === 'win'
        ? strings.result.youWin
        : result.outcome === 'loss'
          ? strings.result.aiWins
          : strings.result.draw;
    const headlineColor =
      result.outcome === 'win'
        ? COLOR.clubs
        : result.outcome === 'loss'
          ? COLOR.hearts
          : COLOR.light;
    const personalityName = strings.personality[personalityOf(result.entry)].name;

    setMirror(
      {
        screen: 'result',
        card: result.entry.id,
        outcome: result.outcome,
        seed: String(result.seed),
      },
      [
        element('h2', headline, 'result-headline'),
        element('p', String(result.scores[0]), 'result-score-0'),
        element('p', String(result.scores[1]), 'result-score-1'),
        element('p', result.taunt, 'result-taunt'),
        element('p', meta.name),
      ],
    );

    const activate = (): void => {
      if (cursor === 0) {
        setScene(replayScene(result, resultScene(result)));
      } else if (cursor === 1) {
        leaveResult(result, () => startMatch(result.entry, newSeed(), false));
      } else {
        leaveResult(result, () => setScene(tableScene(CARD_IDS.indexOf(result.entry.id))));
      }
    };

    return {
      draw: (c) =>
        drawResult(c, {
          headline,
          headlineColor,
          scores: result.scores,
          seed: result.seed,
          taunt: result.taunt,
          personality: personalityName,
          notes: result.notes,
          cursor,
        }),
      press(p) {
        if (p.buttons.up) {
          cursor = (cursor + 2) % 3;
        } else if (p.buttons.down) {
          cursor = (cursor + 1) % 3;
        } else if (p.confirm) {
          activate();
        } else if (p.buttons.b) {
          cursor = 2;
          activate();
        }
      },
      click(_x, y) {
        const hit = RESULT_MENU_Y.findIndex((top) => y >= top - 4 && y < top + 16);
        if (hit >= 0) {
          cursor = hit;
          activate();
        }
      },
    };
  };

  // ---- 重播 ----
  const replayScene = (result: FinishedMatch, back: Scene): Scene => {
    const entry = result.entry;
    const session = createReplaySession(entry.game, result.seed, MATCH_CONFIG, result.inputs);
    let endedTicks = 0;
    setMirror({ screen: 'replay', card: entry.id }, []);
    return {
      draw(c) {
        c.save();
        entry.render(c, session.state());
        c.restore();
        if (session.isOver()) {
          drawBanner(
            c,
            strings.replay.label,
            session.hash() === result.finalHash
              ? strings.replay.consistent
              : strings.replay.inconsistent,
          );
        } else {
          c.fillStyle = COLOR.bg;
          c.fillRect(0, 0, 90, 14);
          c.fillStyle = COLOR.accent;
          c.font = '10px sans-serif';
          c.textBaseline = 'top';
          c.textAlign = 'left';
          c.fillText(`${strings.replay.label}\u3000${strings.replay.hint}`, 4, 2);
        }
      },
      tick() {
        if (session.isOver()) {
          endedTicks += 1;
          if (endedTicks >= REPLAY_END_TICKS) {
            setScene(back);
            syncResultMirror(result);
          }
          return;
        }
        session.advance();
      },
      press(p) {
        if (p.buttons.b || (session.isOver() && p.confirm)) {
          setScene(back);
          syncResultMirror(result);
        }
      },
    };
  };

  /** 從重播回到結算頁時，鏡像要換回結算頁。 */
  const syncResultMirror = (result: FinishedMatch): void => {
    setMirror(
      {
        screen: 'result',
        card: result.entry.id,
        outcome: result.outcome,
        seed: String(result.seed),
      },
      [
        element('h2', undefined, 'result-headline'),
        element('p', String(result.scores[0]), 'result-score-0'),
        element('p', String(result.scores[1]), 'result-score-1'),
        element('p', result.taunt, 'result-taunt'),
      ],
    );
  };

  // ---- AI 進化 ----
  const evolutionScene = (plan: EvolutionPlan, destination: () => void): Scene => {
    // 20 場分散在多個 frame：每隔 EVOLUTION_TICKS_PER_GAME 個 tick 才打一場（見 strings.evolution 的說明）。
    const run = createEvolutionRun(
      plan.entry.game,
      policyByName(personalityOf(plan.entry)),
      plan.oldLevel,
      plan.newLevel,
      plan.seed,
    );
    let ticks = 0;
    const canContinue = (): boolean => run.done() && ticks >= EVOLUTION_MIN_TICKS;
    const sync = (): void => {
      setMirror({ screen: 'evolution', done: String(run.done()), played: String(run.played()) }, [
        element('h2', strings.evolution.heading),
        element('p', String(Math.round(run.rate() * 100)), 'evolution-rate'),
        element('p', String(run.played()), 'evolution-played'),
      ]);
    };
    sync();
    return {
      draw: (c) =>
        drawEvolution(c, {
          name: plan.entry.meta.name,
          from: plan.oldLevel,
          to: plan.newLevel,
          total: run.total,
          played: run.played(),
          rate: run.rate(),
          done: run.done(),
          canContinue: canContinue(),
        }),
      tick() {
        ticks += 1;
        if (ticks % EVOLUTION_TICKS_PER_GAME === 0 && !run.done()) {
          run.runNext();
          sync();
        }
      },
      press(p) {
        if (p.confirm && canContinue()) {
          destination();
        }
      },
      click() {
        if (canContinue()) {
          destination();
        }
      },
    };
  };

  // ---- 啟動 ----
  const launch = options.launch;
  const launchEntry = launch === null ? undefined : findEntry(launch.card);
  if (launch !== null && launchEntry !== undefined) {
    loop.setSpeed(launch.speed);
    setScene(titleScene());
    startMatch(launchEntry, launch.seed, launch.autoplay !== null);
  } else {
    setScene(titleScene());
  }

  screen.canvas.addEventListener('pointerdown', (event) => {
    const point = screen.toLogical(event.clientX, event.clientY);
    if (point.x >= 0 && point.x < LOGICAL_WIDTH && point.y >= 0 && point.y < LOGICAL_HEIGHT) {
      scene.click?.(point.x, point.y);
    }
  });
  window.addEventListener('blur', () => scene.blur?.());

  const frame = (now: number): void => {
    const current = input.read();
    const presses = newPresses(snapshot, current);
    snapshot = current;
    scene.press?.(presses);
    loop.frame(now);
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}
