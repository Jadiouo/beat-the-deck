import { humanModel } from '../ai/human-model';
import { levelController, policyByName } from '../ai/level';
import { hashState } from '../core/hash';
import type { Controller, Inputs } from '../core/types';
import { CARD_IDS, findEntry } from '../games/registry';
import type { JkrState } from '../games/JK-R/logic';
import type { RegistryEntry } from '../games/types';
import { createBrowserAudio } from './audio';
import type { SoundName } from './audio';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './canvas';
import type { ScreenCanvas } from './canvas';
import { cellAt, cellState, moveCursor } from './deck-view';
import type { DeckView } from './deck-view';
import { createEvolutionRun, planEvolution } from './evolve';
import type { EvolutionPlan } from './evolve';
import { attachBrowserInput, emptyButtons, framePresses } from './input';
import type { InputSnapshot } from './input';
import type { Launch } from './launch';
import { createLoop } from './loop';
import {
  createMatchSession,
  createReplaySession,
  matchConfigFor,
  screenController,
} from './match-session';
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
  TITLE_MENU_Y,
  drawBanner,
  drawEvolution,
  drawInfo,
  drawResult,
  drawScanlines,
  drawTable,
  drawTitle,
  resultMenuHit,
  resultTaunt,
} from './screens';
import { strings } from './strings';
import type { TauntPersonality } from './taunts';
import { createBrowserPngDeps, jkrPngExport, savePng } from './save-image';
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

/** 一場對局的結果（從人這一邊看）。鬼牌沒有勝負，玩完就算贏（SPEC 第 11 節：玩過一次就算翻開）。 */
function outcomeOf(entry: RegistryEntry, state: unknown): Outcome {
  if (entry.id.startsWith('JK')) {
    return 'win';
  }
  const winner = entry.game.winner(state);
  return winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw';
}

const END_SOUND: Readonly<Record<Outcome, SoundName>> = {
  win: 'win',
  loss: 'lose',
  draw: 'draw',
};

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

  // 音效（SPEC 8.4）：第一次按鍵、點擊或觸控之前不建立任何節點（瀏覽器的規定）；那之後音效預設是開的，玩家可以在標題選單關掉。
  const audio = createBrowserAudio();
  audio.setEnabled(progress.settings.sound);
  const unlockAudio = (): void => audio.unlock();
  for (const type of ['keydown', 'pointerdown', 'touchstart'] as const) {
    window.addEventListener(type, unlockAudio, { capture: true, passive: true });
  }

  const input = attachBrowserInput(window);
  const touch = createTouchControls(options.touchParent, (buttons) => input.setTouch(buttons));
  const refit = (): void => {
    const showing = touch.refresh(window.innerWidth);
    screen.refit(showing ? TOUCH_AREA_HEIGHT : 0);
  };
  refit();
  window.addEventListener('resize', refit);

  let snapshot: InputSnapshot = { buttons: emptyButtons(), confirm: false, pause: false };
  let heldSnapshot: InputSnapshot = snapshot;
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
      const sound = element(
        'button',
        `${strings.titleScreen.sound}：${progress.settings.sound ? strings.titleScreen.on : strings.titleScreen.off}`,
        'menu-sound',
      );
      setMirror({ screen: 'title', cursor: String(cursor) }, [
        heading,
        tagline,
        start,
        scan,
        sound,
      ]);
    };
    const activate = (): void => {
      if (cursor === 0) {
        audio.play('menuConfirm');
        setScene(tableScene(0));
      } else if (cursor === 1) {
        audio.play('menuConfirm');
        updateProgress(withSettings(progress, { scanlines: !progress.settings.scanlines }));
        sync();
      } else {
        // 先改開關再播：打開的那一下會聽到確認音，關掉就安靜。
        updateProgress(withSettings(progress, { sound: !progress.settings.sound }));
        audio.setEnabled(progress.settings.sound);
        audio.play('menuConfirm');
        sync();
      }
    };
    sync();
    return {
      draw: (c) =>
        drawTitle(c, {
          cursor,
          scanlines: progress.settings.scanlines,
          sound: progress.settings.sound,
        }),
      press(p) {
        if (p.buttons.up || p.buttons.down) {
          cursor = (cursor + (p.buttons.up ? TITLE_MENU_Y.length - 1 : 1)) % TITLE_MENU_Y.length;
          audio.play('menuMove');
          sync();
        } else if (p.confirm) {
          activate();
        }
      },
      click(_x, y) {
        const hit = TITLE_MENU_Y.findIndex((top) => y >= top - 4 && y < top + 16);
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
        audio.play('menuConfirm');
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
          audio.play('menuMove');
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
          audio.play('menuMove');
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

    const start = (): void => {
      audio.play('menuConfirm');
      startMatch(entry, newSeed(), false);
    };
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
  interface FinishedMatch {
    readonly entry: RegistryEntry;
    readonly seed: number;
    readonly inputs: readonly Inputs[];
    readonly finalHash: string;
    readonly scores: readonly [number, number];
    readonly outcome: Outcome;
    /** 沒有 AI 性格的牌（鬼牌）沒有台詞。 */
    readonly taunt: string | null;
    readonly notes: readonly string[];
    /** 結束時的 state（JK-R 存成圖片用）。 */
    readonly finalState: unknown;
    /** 存成圖片的結果：成功是檔名；失敗記下來給畫面顯示。 */
    savedAs: string | null;
    saveFailed: boolean;
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
    const session = createMatchSession(entry.game, seed, matchConfigFor(meta), human, ai);

    // 自動遊玩是加速跑的（測試用），不出聲。
    const sfx = (name: SoundName): void => {
      if (!autoplay) {
        audio.play(name);
      }
    };
    let lastScores = entry.game.score(session.state());
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
      const outcome = outcomeOf(entry, state);
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

      const result: FinishedMatch = {
        entry,
        seed,
        inputs: session.inputs(),
        finalHash: hashState(state),
        scores,
        outcome,
        taunt: resultTaunt(meta.defaultPolicy, winner, progress.lossStreak, seed),
        notes,
        finalState: state,
        savedAs: null,
        saveFailed: false,
        evolution: planEvolution(entry, levelBefore, levelAfter, seed),
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
            sfx('matchStart');
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
        // 得分、被扣分：看人這一邊的分數變化（AI 得分不出聲，免得吵）。
        const scores = entry.game.score(session.state());
        if (scores[0] > lastScores[0]) {
          sfx('score');
        } else if (scores[0] < lastScores[0]) {
          sfx('hit');
        }
        lastScores = scores;
        if (session.isOver()) {
          sfx(END_SOUND[outcomeOf(entry, session.state())]);
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

  const resultHeadline = (result: FinishedMatch): string =>
    result.entry.id.startsWith('JK')
      ? strings.result.jokerDone
      : result.outcome === 'win'
        ? strings.result.youWin
        : result.outcome === 'loss'
          ? strings.result.aiWins
          : strings.result.draw;

  const pngDeps = createBrowserPngDeps();

  const resultScene = (result: FinishedMatch): Scene => {
    let cursor = 0;
    const isJoker = result.entry.id.startsWith('JK');
    const headline = resultHeadline(result);
    const headlineColor = isJoker
      ? COLOR.accent
      : result.outcome === 'win'
        ? COLOR.clubs
        : result.outcome === 'loss'
          ? COLOR.hearts
          : COLOR.light;
    const personalityName = strings.personality[personalityOf(result.entry)].name;
    // JK-R 沒有勝負，結算頁多一項「存成圖片」（SPEC 第 11 節）。
    const canSave = result.entry.id === 'JK-R';
    const menu = canSave
      ? [
          strings.result.menuReplay,
          strings.result.menuSave,
          strings.result.menuAgain,
          strings.result.menuBack,
        ]
      : [strings.result.menuReplay, strings.result.menuAgain, strings.result.menuBack];
    const actionOf = (index: number): 'replay' | 'save' | 'again' | 'back' =>
      (canSave
        ? (['replay', 'save', 'again', 'back'] as const)
        : (['replay', 'again', 'back'] as const))[index] ?? 'back';

    syncResultMirror(result);

    const saveImage = (): void => {
      savePng(jkrPngExport(result.finalState as JkrState), pngDeps).then(
        (name) => {
          result.savedAs = name;
          result.saveFailed = false;
          if (scene === self) {
            syncResultMirror(result);
          }
        },
        () => {
          result.savedAs = null;
          result.saveFailed = true;
          if (scene === self) {
            syncResultMirror(result);
          }
        },
      );
    };

    const activate = (): void => {
      audio.play('menuConfirm');
      switch (actionOf(cursor)) {
        case 'replay':
          setScene(replayScene(result, resultScene(result)));
          break;
        case 'save':
          saveImage();
          break;
        case 'again':
          leaveResult(result, () => startMatch(result.entry, newSeed(), false));
          break;
        case 'back':
          leaveResult(result, () => setScene(tableScene(CARD_IDS.indexOf(result.entry.id))));
          break;
      }
    };

    const self: Scene = {
      draw: (c) =>
        drawResult(c, {
          headline,
          headlineColor,
          scores: result.scores,
          showScores: !isJoker,
          seed: result.seed,
          taunt: result.taunt,
          personality: personalityName,
          notes: [
            ...result.notes,
            ...(result.savedAs !== null ? [strings.result.saved(result.savedAs)] : []),
            ...(result.saveFailed ? [strings.result.saveFailed] : []),
          ],
          menu,
          cursor,
        }),
      press(p) {
        if (p.buttons.up) {
          cursor = (cursor + menu.length - 1) % menu.length;
          audio.play('menuMove');
        } else if (p.buttons.down) {
          cursor = (cursor + 1) % menu.length;
          audio.play('menuMove');
        } else if (p.confirm) {
          activate();
        } else if (p.buttons.b) {
          cursor = menu.length - 1;
          activate();
        }
      },
      click(_x, y) {
        const hit = resultMenuHit(menu.length, y);
        if (hit >= 0) {
          cursor = hit;
          activate();
        }
      },
    };
    return self;
  };

  // ---- 重播 ----
  const replayScene = (result: FinishedMatch, back: Scene): Scene => {
    const entry = result.entry;
    const session = createReplaySession(
      entry.game,
      result.seed,
      matchConfigFor(entry.meta),
      result.inputs,
    );
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

  /** 結算頁的鏡像（剛進來、從重播回來、存圖有結果時都用它重建）。 */
  const syncResultMirror = (result: FinishedMatch): void => {
    const children = [
      element('h2', resultHeadline(result), 'result-headline'),
      element('p', String(result.scores[0]), 'result-score-0'),
      element('p', String(result.scores[1]), 'result-score-1'),
      element('p', result.entry.meta.name),
    ];
    if (result.taunt !== null) {
      children.splice(3, 0, element('p', result.taunt, 'result-taunt'));
    }
    if (result.savedAs !== null) {
      children.push(element('p', result.savedAs, 'result-saved'));
    }
    if (result.saveFailed) {
      children.push(element('p', strings.result.saveFailed, 'result-save-failed'));
    }
    setMirror(
      {
        screen: 'result',
        card: result.entry.id,
        outcome: result.outcome,
        seed: String(result.seed),
      },
      children,
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
      plan.config,
    );
    let ticks = 0;
    audio.play('evolve');
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
          audio.play('menuConfirm');
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
    const { current, held, taps } = input.read();
    const presses = framePresses(heldSnapshot, held, taps);
    heldSnapshot = held;
    snapshot = current;
    if (presses.confirm || presses.pause || Object.values(presses.buttons).some(Boolean)) {
      audio.unlock(); // 手把按鍵不一定算「使用者互動」事件，這裡再補一次。
    }
    scene.press?.(presses);
    loop.frame(now);
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}
