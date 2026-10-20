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
    /**
     * 鬼牌的解鎖條件，連同目前進度。`capped` 是門檻被「已開放的牌數」壓低了
     * （牌還沒做完，湊不到 SPEC 的 13／40 張），要講明白為什麼不是 13。
     */
    lockedJoker: (needed: number, have: number, capped: boolean): string =>
      capped
        ? `未解鎖：先翻開全部 ${needed} 張已開放的牌（目前 ${have}）`
        : `未解鎖：先翻開 ${needed} 張牌（目前 ${have}）`,
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
    /** 鬼牌沒有勝負（JK-R 玩完就算翻開）。 */
    jokerDone: '畫完了',
    menuReplay: '看重播',
    menuSave: '存成圖片',
    menuAgain: '再一次',
    menuBack: '回牌桌',
    saved: (fileName: string): string => `已存成 ${fileName}`,
    saveFailed: '存圖失敗',
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

  /** D-6 市場：貨名與狀態文字（畫面上的文字集中在這裡）。 */
  market: {
    goods: ['穀', '布', '鐵'],
    locked: '已鎖定',
    pass: '不動',
    buy: '買',
    sell: '賣',
    round: (round: number, total: number): string => `第 ${round} / ${total} 回合`,
  },

  /** D-9 擺放：狀態文字。 */
  deposit: {
    locked: '已鎖定',
    choosing: '選擇中',
    passed: '不擺',
    confidence: 'AI 的把握',
    round: (round: number, total: number): string => `第 ${round} / ${total} 輪`,
  },

  /** D-K 方塊馬拉松：三段的名稱與倒數（畫面文字集中在這裡）。 */
  diamondsMarathon: {
    stages: ['過場', '圈地', '寶石', '存與偷'],
    upNext: (name: string): string => `接下來：${name}`,
    clock: (seconds: number): string => `${seconds}`,
  },

  /** S-K 黑桃馬拉松：挑牌與結算的畫面文字（被包的牌的名稱來自它們自己的 meta）。 */
  spadesMarathon: {
    segment: (n: number, total: number): string => `第 ${n} / ${total} 段`,
    finalName: '決勝',
    finalDouble: '分數加倍',
    youPick: '輪到你挑牌',
    aiPick: '對手挑牌中',
    /** 對手挑牌時的標記：前兩次沒有資料，是性格；之後才是看你的成績。 */
    styleTag: '風格',
    targetTag: '針對你',
    sigma: { stable: '穩', mid: '中', risky: '險' },
    keys: ['↑', '↓', '←', '→'],
    youWin: '你贏這段',
    aiWin: '對手贏這段',
    drawSegment: '這段平手',
    total: '總分',
    you: '你',
    ai: 'AI',
    wrapperNote: '互動來自被包的牌',
  },

  /** JK-B 規則壞掉了：規則名稱、預告與畫面上的短字（畫面文字集中在這裡）。 */
  brokenRules: {
    rules: {
      normal: '正常',
      poison: '毒藥',
      gift: '送禮',
      rain: '金幣雨',
      gravity: '重力反轉',
      rob: '搶劫',
      exchange: '分數互換',
    },
    /** 一句話說明，預告時顯示在規則名稱下面。 */
    blurbs: {
      normal: '撿金幣 +1',
      poison: '撿金幣 −1',
      gift: '撿的人 0 分，對手 +1',
      rain: '標記格周圍多 8 顆金幣',
      gravity: '所有人被往箭頭方向飄',
      rob: '金幣沒分，推到人偷 1 分',
      exchange: '撿完先 +1，再互換總分',
    },
    now: '現在',
    next: (name: string, seconds: number): string => `${seconds} 秒後：${name}`,
    you: '你',
    ai: 'AI',
  },

  touch: { up: '上', down: '下', left: '左', right: '右', a: 'A', b: 'B' },

  /** 看不見的 DOM 鏡像（給讀螢幕的人與端到端測試）。 */
  mirror: {
    cardLabel: (id: string, name: string, state: string): string => `${id} ${name}：${state}`,
  },

  startupFailed: '無法啟動：這個瀏覽器不支援 Canvas。',
} as const;
