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
const DEFAULT_UI_LOCALE: UiLocale = 'ja';

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
    modeFastDesc: 'TOC検索で章を取得してすぐ回答（回答生成は No reasoning）',
    stop: '停止',
    stopTitle: '生成を停止',
    creatingAnswer: '回答を作成しています…',
    answerModel: '回答生成',
    chatError: 'リクエストの処理中にエラーが発生しました。',
    answerStart: '回答開始',
    answerComplete: '回答完了',
    modelTtft: 'Model TTFT',
    holdDelay: 'Hold',
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
    noReasoning: 'No reasoning',
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
    modeFastDesc: 'TOC search then answer immediately (answer GPT: No reasoning)',
    stop: 'Stop',
    stopTitle: 'Stop generation',
    creatingAnswer: 'Creating answer…',
    answerModel: 'Answer generation',
    chatError: 'Sorry, an error occurred while processing your request.',
    answerStart: 'Answer start',
    answerComplete: 'Answer complete',
    modelTtft: 'Model TTFT',
    holdDelay: 'Hold',
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
    noReasoning: 'No reasoning',
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
  'Generating Search Queries + Initial TOC': '検索クエリ生成 + 初期TOC',
  'Selecting Relevant Paths': '関連パス選択',
  'Searching by Exact Path Filter': 'パスフィルタ検索',
  'Judging Answerability': '回答可能性判定',
  'Extracting Elements + Multi-error': '要素抽出 + 複数エラー',
  'Detecting Multiple Error Codes': '複数エラーコード検出',
  'Additional Search': '追加検索',
  'Chapter Classification': '章分類',
  'Classifying Answer Pattern(s)': '回答パターン分類',
  'Preparing Context': 'コンテキスト準備',
  'Selecting TOC Paths': 'TOCパス選択',
  'Retrieving Chapter Text': '章テキスト取得',
  'Fast prep finished': 'Fast準備完了',
  'Thinking finished': '思考完了',
  'Calling answer model': '回答モデル呼び出し',
};

export function translateStepTitle(title: string, locale: UiLocale): string {
  const normalized = (title || '').replace(/^Step\s*\d+[a-z]?:\s*/i, '');
  if (locale === 'en') return normalized;
  return STEP_TITLE_JA[normalized] || normalized;
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
