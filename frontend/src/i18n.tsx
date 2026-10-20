import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type UiLocale = 'ja' | 'en';

const STORAGE_KEY = 'satori.uiLocale';
const DEFAULT_UI_LOCALE: UiLocale = 'en';

const messages = {
  ja: {
    appTitle: '改善版AI bot試作版',
    appSubtitle: '対象機種のマニュアルを選んで、手順・故障・エラーコードを質問できます',
    newChat: '新規チャット',
    newChatShort: '新規',
    close: '閉じる',
    menu: 'メニュー',
    signOut: 'サインアウト',
    signedIn: 'サインイン済み',
    notAuthenticated: '未認証',
    azureAdRedirect: 'Azure AD認証画面へ移動しています…',
    documentSetup: 'ドキュメント設定',
    documentSetupHint: '機種型式・機番・言語を指定して検索し、各マニュアルから1冊ずつ選択します。',
    modelLabel: '機種型式',
    serialLabel: '機番',
    documentLanguage: 'ドキュメント言語',
    modelPlaceholder: '例: PC200-10M0',
    serialPlaceholder: '任意',
    search: '検索',
    searchEmptyTitle: '検索すると、ここにドキュメント一覧が表示されます',
    searchEmptyHint: 'Shop Manual と Operation & Maintenance Manual からそれぞれ1冊選択できます',
    documentList: 'ドキュメント一覧',
    filterResults: '結果を絞り込み…',
    selectedCount: '{count}冊を選択中',
    selectOneEach: '各カテゴリから1冊ずつ選択できます',
    cancel: 'キャンセル',
    done: '完了',
    countItems: '{count}件',
    noDocuments: '該当するドキュメントはありません。',
    change: '変更',
    chatPlaceholder: '手順、エラーコード、コネクタについて質問できます…',
    sendHint: 'Enterで送信 · Shift+Enterで改行',
    modeSelect: '回答モードを選択',
    modeThinking: 'Thinking',
    modeThinkingDesc: '多段思考で検索・分類してから回答',
    modeFast: 'Fast',
    modeFastDesc: 'TOC検索で章を取得してすぐ回答（reasoning: low）',
    stop: '停止',
    stopTitle: '生成を停止',
    creatingAnswer: '回答を作成しています…',
    answerModel: '回答生成',
    chatError: 'リクエストの処理中にエラーが発生しました。',
    answerStart: '回答開始',
    answerComplete: '回答完了',
    modelTtft: 'Model TTFT',
    holdDelay: 'Hold',
    tokenInput: 'Input',
    tokenOutput: 'Output',
    tokenCachedInput: 'Cached input',
    tokenTotal: 'Total',
    generatingCursor: '生成中',
    assetLinkPreparing: 'リンク準備中…',
    modelType: '機種型式',
    serialNumber: '機番',
    shopShort: 'ショップ',
    ommShort: '取説',
    shopManual: 'Shop Manual',
    ommManual: 'Operation & Maintenance Manual',
    thinkingProcess: '思考プロセス',
    thinking: '思考中…',
    thinkingDone: '思考完了。回答を作成しています…',
    finishedWithErrors: 'エラーで終了',
    reasoningEffort: 'Reasoning effort',
    reasoningSummary: '推論サマリ',
    reasoningEncryptedOnly: 'サマリテキストなし（encrypted output のみ）',
    noReasoning: 'No reasoning',
    thinkingStages: '{n}段',
    thinkingSubsteps: '{n}手順',
    uiLanguage: '画面言語',
    zoomOut: '縮小',
    zoomIn: '拡大',
    resetZoom: 'リセット',
    openInNewWindow: '別ウィンドウで開く',
    dragToResize: 'ドラッグでリサイズ',
    required: '*',
  },
  en: {
    appTitle: 'Improved AI Bot (Prototype)',
    appSubtitle: 'Select manuals for your model, then ask about procedures, faults, and error codes',
    newChat: 'New chat',
    newChatShort: 'New',
    close: 'Close',
    menu: 'Menu',
    signOut: 'Sign out',
    signedIn: 'Signed in',
    notAuthenticated: 'Not authenticated',
    azureAdRedirect: 'Redirecting to Azure AD sign-in…',
    documentSetup: 'Document setup',
    documentSetupHint: 'Search by model, serial, and language, then pick one manual from each category.',
    modelLabel: 'Model',
    serialLabel: 'Serial',
    documentLanguage: 'Document language',
    modelPlaceholder: 'e.g. PC200-10M0',
    serialPlaceholder: 'Optional',
    search: 'Search',
    searchEmptyTitle: 'Search to list matching documents here',
    searchEmptyHint: 'Select one Shop Manual and one Operation & Maintenance Manual',
    documentList: 'Documents',
    filterResults: 'Filter results…',
    selectedCount: '{count} selected',
    selectOneEach: 'Select one document from each category',
    cancel: 'Cancel',
    done: 'Done',
    countItems: '{count}',
    noDocuments: 'No matching documents.',
    change: 'Change',
    chatPlaceholder: 'Ask about procedures, error codes, connectors…',
    sendHint: 'Enter to send · Shift+Enter for newline',
    modeSelect: 'Select answer mode',
    modeThinking: 'Thinking',
    modeThinkingDesc: 'Multi-step search and classification before answering',
    modeFast: 'Fast',
    modeFastDesc: 'TOC search then answer immediately (reasoning: low)',
    stop: 'Stop',
    stopTitle: 'Stop generation',
    creatingAnswer: 'Creating answer…',
    answerModel: 'Answer generation',
    chatError: 'Sorry, an error occurred while processing your request.',
    answerStart: 'Answer start',
    answerComplete: 'Answer complete',
    modelTtft: 'Model TTFT',
    holdDelay: 'Hold',
    tokenInput: 'Input',
    tokenOutput: 'Output',
    tokenCachedInput: 'Cached input',
    tokenTotal: 'Total',
    generatingCursor: 'Generating',
    assetLinkPreparing: 'Preparing link…',
    modelType: 'Model',
    serialNumber: 'Serial',
    shopShort: 'Shop',
    ommShort: 'O&M',
    shopManual: 'Shop Manual',
    ommManual: 'Operation & Maintenance Manual',
    thinkingProcess: 'Thinking Process',
    thinking: 'Thinking…',
    thinkingDone: 'Thinking done. Creating answer…',
    finishedWithErrors: 'Finished with errors',
    reasoningEffort: 'Reasoning effort',
    reasoningSummary: 'Reasoning',
    reasoningEncryptedOnly: 'No summary text (encrypted output only)',
    noReasoning: 'No reasoning',
    thinkingStages: '{n} stages',
    thinkingSubsteps: '{n} steps',
    uiLanguage: 'UI language',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    resetZoom: 'Reset zoom',
    openInNewWindow: 'Open in new window',
    dragToResize: 'Drag to resize',
    required: '*',
  },
} as const;

export type MessageKey = keyof typeof messages.ja;

type MessageParams = Record<string, string | number>;

type LocaleContextValue = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{${key}}`
  );
}

const STEP_TITLE_JA: Record<string, string> = {
  'Agent thinking': 'エージェント思考',
  'Agent answering': 'エージェント回答',
  'Generating answer': '回答生成',
  'Tool: select_toc_bookmarks': 'ツール: しおり選定',
  'Tool: get_toc_bookmarks': 'ツール: しおり一覧取得',
  'Tool: fetch_chapters_by_paths': 'ツール: 章テキスト取得',
  // Compat for older session step titles still in chat history
  'Tool: retrieve_manual_chapters': 'ツール: マニュアル章取得',
  'Loading TOC': 'しおり読込',
  'Selecting TOC bookmarks (GPT · initial)': 'しおり選定 (GPT · 初期)',
  'Selecting TOC bookmarks (GPT · follow-up)': 'しおり選定 (GPT · 追加)',
  'Fetching chapter text': '章テキスト取得',
  'Selecting TOC bookmarks (GPT · legacy initial TOC · user query)': 'しおり選定 (GPT · 初期)',
  'Selecting TOC bookmarks (GPT · legacy selectTOCChapters follow-up)': 'しおり選定 (GPT · 追加)',
  'Selecting TOC bookmarks (GPT · legacy selectTOCChapters)': 'しおり選定 (GPT · 追加)',
  'Selecting TOC bookmarks (GPT · legacy initial TOC)': 'しおり選定 (GPT · 初期)',
};

export function translateStepTitle(title: string, locale: UiLocale): string {
  const normalized = (title || '').replace(/^Step\s*\d+[a-z]?:\s*/i, '');
  if (locale === 'en') return normalized;
  if (STEP_TITLE_JA[normalized]) return STEP_TITLE_JA[normalized];
  // Dynamic tool titles: "Tool: foo_bar"
  const toolMatch = normalized.match(/^Tool:\s*(.+)$/i);
  if (toolMatch) {
    const key = `Tool: ${toolMatch[1]}`;
    if (STEP_TITLE_JA[key]) return STEP_TITLE_JA[key];
    return `ツール: ${toolMatch[1]}`;
  }
  return normalized;
}

/** Map English step descriptions (from backend) to Japanese when UI locale is ja. */
export function translateStepDescription(description: string, locale: UiLocale): string {
  const text = description || '';
  if (locale === 'en' || !text) return text;

  const rules: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
    [/^Retrieved TOC list \((\d+) entries\)$/i, (m) => `TOC一覧を取得しました（${m[1]}件）`],
    [/^TOC retrieval failed:\s*(.*)$/i, (m) => `TOC取得失敗: ${m[1]}`],
    [/^Passed full TOC to main agent \((\d+) entries\)$/i, (m) => `TOC全体をメインエージェントに渡しました（${m[1]}件）`],
    [/^Selected (\d+) bookmark\(s\)(.*)$/i, (m) => `${m[1]}件のしおりを選定しました${m[2]}`],
    [/^Could not select bookmarks(.*)$/i, (m) => `しおりを選定できませんでした${m[1]}`],
    [/^Fetched (\d+) chapter\(s\)(.*)$/i, (m) => `${m[1]}章を取得しました${m[2].replace(' · follow-up', ' · 追加取得').replace(' · truncated', ' · 件数上限で打切り')}`],
    [/^Could not fetch chapters(.*)$/i, (m) => `章は取得できませんでした${m[1].replace(' · follow-up', ' · 追加取得')}`],
    [/^Retrieving TOC list…$/i, 'TOC一覧を取得しています…'],
    [/^Selecting bookmarks…$/i, 'しおりを選定しています…'],
    [/^Fetching chapter text…$/i, '章テキストを取得しています…'],
    [/^Running…$/i, '実行中…'],
    [/^Failed$/i, '失敗'],
    [/^Done$/i, '完了'],
    [/^Continuing conversation \(Conversation (.+)\)$/i, (m) => `会話を継続中（Conversation ${m[1]}）`],
    [/^Continuing conversation \(previous_response_id\)$/i, '会話を継続中（previous_response_id）'],
    [
      /^Conversation created \((.+)\)\. Tool turns are stored on the Conversation\.$/i,
      (m) => `Conversation 作成済み（${m[1]}）。ツール往復も Conversation に記録。`,
    ],
    [
      /^Conversations API unavailable — continuing with previous_response_id\.$/i,
      'Conversations API 未対応のため previous_response_id で継続。',
    ],
    [/^Preparing answer in Fast mode$/i, 'Fast モードで回答準備中'],
    [/^Preparing answer in Thinking mode$/i, 'Thinking モードで回答準備中'],
    [/^Final answer generated \(phase: final_answer\)$/i, '最終回答を生成しました（phase: final_answer）'],
    [/^Turn completed without tools$/i, 'ツールなしでターン完了'],
    [/^Calling tool:\s*(.+)$/i, (m) => `ツールを呼び出します: ${m[1]}`],
    [/^Calling (\d+) tools$/i, (m) => `ツールを ${m[1]} 件呼び出します`],
    [
      /^Fetched (\d+) chapter\(s\)\. If body text has cross-refs or missing connectors, call fetch_chapters_by_paths again first$/i,
      (m) =>
        `取得済み ${m[1]} 章。本文の「〜を参照」や未取得コネクタがあれば、先に fetch_chapters_by_paths を再実行してください`,
    ],
    [/^Reviewing tool results…$/i, 'ツール結果を確認中…'],
    [/^User stopped generation$/i, 'ユーザーが生成を停止しました'],
    [/^Answer ready$/i, '回答準備完了'],
    [/^Starting Fast agent…$/i, 'Fast エージェントを開始…'],
    [/^Starting Thinking agent…$/i, 'Thinking エージェントを開始…'],
  ];

  for (const [re, repl] of rules) {
    const m = text.match(re);
    if (!m) continue;
    return typeof repl === 'function' ? repl(m) : repl;
  }
  return text;
}

export function formatReasoningEffortLabel(
  effort: string,
  t: (key: MessageKey) => string
): string {
  const base = `${t('reasoningEffort')}: ${effort}`;
  if (effort === 'none') {
    return `${base} (${t('noReasoning')})`;
  }
  return base;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(DEFAULT_UI_LOCALE);

  const setLocale = useCallback((next: UiLocale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'ja' ? 'ja' : 'en';
  }, [locale]);

  const t = useCallback(
    (key: MessageKey, params?: MessageParams) => formatMessage(messages[locale][key], params),
    [locale]
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocale must be used within LocaleProvider');
  }
  return ctx;
}
