/**
 * 畫面上所有的文字都放這裡（CLAUDE.md 的語言規則）。
 * 例外：AI 的台詞本身就是文字表，放在 `taunts.ts`；每張牌的名稱、規則、操作說明放各牌的 `meta.ts`。
 */
export const strings = {
  title: 'Beat the Deck',
  tagline: '一副 54 張牌的 AI 對戰街機',

  titleScreen: {
    start: '開始',
    scanlines: '掃描線',
    sound: '音效',
    on: '開',
    off: '關',
    hint: '上下：選擇\u3000Z／Enter：確認',
  },

  table: {
    hint: '方向鍵：移動\u3000Z／Enter：選擇\u3000X：回標題',
    playable: '可以挑戰',
    revealed: '已翻開',
    unimplemented: '尚未開放',
    locked: (previousId: string): string => `未解鎖：先贏 ${previousId}`,
    lockedJoker: (needed: number): string => `未解鎖：先翻開 ${needed} 張牌`,
    best: (score: number): string => `最佳 ${score}`,
    progress: (revealed: number, total: number, level: number): string =>
      `已翻開 ${revealed} / ${total}\u3000AI 等級 ${level}`,
    cardLine: (id: string, name: string): string => `${id}\u3000${name}`,
  },

  info: {
    rules: '規則',
    controls: '操作',
    opponent: '對手',
    opponentLine: (personality: string, level: number): string =>
      `${personality}\u3000等級 ${level}`,
    bestScore: (score: number): string => `你的最佳分數：${score}`,
    noBestScore: '還沒打過',
    hint: 'Z／Enter：開始\u3000X：返回',
  },

  /** 四種性格的名字與一句說明（SPEC 7.1）。 */
  personality: {
    pathfinder: { name: '搜尋型', blurb: '往前模擬幾步，挑終點最好的第一步' },
    precise: { name: '精準型', blurb: '每個 tick 重新決定，先排除危險的動作' },
    greedy: { name: '貪心型', blurb: '只看下一步，拿眼前最大的' },
    gambler: { name: '賭徒型', blurb: '偏好風險，落後時加大賭注' },
  },

  match: {
    ready: '準備',
    go: '開始',
    paused: '暫停',
    pausedHint: 'Esc：繼續\u3000X：放棄回牌桌',
    you: '你',
    ai: 'AI',
  },

  result: {
    youWin: '你贏了',
    aiWins: 'AI 贏了',
    draw: '平手',
    scoreYou: '你',
    scoreAi: 'AI',
    seed: (seed: number): string => `種子 ${seed}`,
    newBest: '新的最佳分數',
    revealed: '這張牌翻開了',
    menuReplay: '看重播',
    menuAgain: '再一次',
    menuBack: '回牌桌',
    hint: '上下：選擇\u3000Z／Enter：確認',
  },

  replay: {
    label: '重播中',
    hint: 'X：離開',
    consistent: '重播結束：結果與原本一模一樣',
    inconsistent: '重播結束：結果與原本不一致',
  },

  evolution: {
    heading: 'AI 進化',
    subtitle: (name: string, from: number, to: number): string =>
      `${name}\u3000等級 ${from} → ${to}`,
    explain: (games: number): string => `新舊兩個等級在這張牌上對打 ${games} 場`,
    played: (played: number, total: number): string => `已打 ${played} / ${total} 場`,
    winRate: (percent: number): string => `新版勝率 ${percent}%`,
    running: '正在實際對打……',
    hint: 'Z／Enter：繼續',
    /**
     * 設計說明：20 場對打是真的在瀏覽器裡跑 `playMatch`，不是動畫。
     * 搜尋型的牌在高等級很慢（C-A：8→9 級約 1.5 秒、9→10 級約 2.6 秒），一個 frame 跑完 20 場
     * 會讓畫面凍住，所以分散到多個 frame，每次只跑一場，畫面逐場累加。
     */
  },

  touch: { up: '上', down: '下', left: '左', right: '右', a: 'A', b: 'B' },

  /** 看不見的 DOM 鏡像（給讀螢幕的人與端到端測試）。 */
  mirror: {
    cardLabel: (id: string, name: string, state: string): string => `${id} ${name}：${state}`,
  },

  startupFailed: '無法啟動：這個瀏覽器不支援 Canvas。',
} as const;
