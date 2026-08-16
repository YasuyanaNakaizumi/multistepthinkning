import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from './components/ui/button';
import { ChatMessage } from './components/ChatMessage';
import { ThinkingProcess } from './components/ThinkingProcess';
import { fetchAzureAdUser, signOutAzureAd } from './lib/azureAd';
import {
  Send,
  Loader2,
  FileText,
  Plus,
  Square,
  X,
  Check,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Search,
  Settings2,
  BookOpen,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
} from 'lucide-react';
import { ChatMessage as ChatMessageType, ThinkingStep } from './types';
import type { Document } from './types';

const LANGUAGES = [
  { value: 'Japanese', label: '日本語' },
  { value: 'English', label: 'English' },
];

type DocumentSearchResults = {
  shop_manual: Document[];
  operation_and_maintenance_manual: Document[];
};

type PreviewPanel = { kind: 'pdf' | 'image'; url: string; title?: string };

function normalizeSourceKey(value: string | undefined): string {
  return (value || '').toLowerCase().replace(/[\s_-]/g, '');
}

function getSourceKeyFromDocument(doc: Document): string {
  const normalized = normalizeSourceKey(doc.sourceDocumentType);
  return normalized.includes('operationandmaintenancemanual') ? 'operation_and_maintenance_manual' : 'shop_manual';
}

function getSourceLabel(key: string): string {
  return key === 'operation_and_maintenance_manual' ? 'Operation & Maintenance Manual' : 'Shop Manual';
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function formatSelectedDocument(label: string, doc: Document, maxTitleLength = 22): string {
  const title = truncateText(doc.documentTitle || doc.documentNumber, maxTitleLength);
  return `${label}: ${title} (${doc.documentNumber})`;
}

function formatModelSerial(doc: Document, fallbackModel?: string, fallbackSerial?: string): string | undefined {
  const associations = doc.modelSerialAssociation || [];
  if (associations.length > 0) {
    const parts = associations.slice(0, 2).map((item) => {
      const serialRange = item.serial_start
        ? `${item.serial_start}${item.serial_end ? `-${item.serial_end}` : ''}`
        : item.serial;
      return serialRange ? `${item.model}  S/N ${serialRange}` : item.model;
    });
    if (associations.length > 2) {
      parts.push(`ほか${associations.length - 2}件`);
    }
    return parts.filter(Boolean).join(' / ');
  }

  const model = fallbackModel?.trim();
  const serial = fallbackSerial?.trim();
  if (!model && !serial) return undefined;
  if (model && serial) return `${model}  S/N ${serial}`;
  return model || `S/N ${serial}`;
}

function App() {
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [documents, setDocuments] = useState<DocumentSearchResults>({ shop_manual: [], operation_and_maintenance_manual: [] });
  const [selectedShopManual, setSelectedShopManual] = useState<Document | null>(null);
  const [selectedOperationManual, setSelectedOperationManual] = useState<Document | null>(null);
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [currentThinkingSteps, setCurrentThinkingSteps] = useState<ThinkingStep[]>([]);
  const [preview, setPreview] = useState<PreviewPanel | null>(null);
  const [showDocSetup, setShowDocSetup] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [language, setLanguage] = useState('Japanese');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pdfPanelWidth, setPdfPanelWidth] = useState(576);
  const [isResizingPdf, setIsResizingPdf] = useState(false);
  const [chatSessionId, setChatSessionId] = useState(() => crypto.randomUUID());
  const [azureAdEmail, setAzureAdEmail] = useState('');
  const [azureAdUserName, setAzureAdUserName] = useState('');
  const [isAzureAdReady, setIsAzureAdReady] = useState(false);
  const [isAzureAdEnabled, setIsAzureAdEnabled] = useState(false);
  const [activeThinkingSourceKey, setActiveThinkingSourceKey] = useState('shop_manual');
  const selectedDocuments = [selectedShopManual, selectedOperationManual].filter(Boolean) as Document[];
  const resizePointerIdRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const configRes = await fetch('/api/config');
        const azureAdConfig = configRes.ok ? await configRes.json().catch(() => ({})) : {};
        if (!isMounted) return;

        setIsAzureAdEnabled(Boolean(azureAdConfig.azureAdClientId));

        if (!azureAdConfig.azureAdClientId) {
          console.info('[AzureAD] Azure AD config is incomplete; login gate is disabled.');
          setIsAzureAdReady(true);
          return;
        }

        console.info('[AzureAD] Initializing Azure AD session check...');
        const user = await fetchAzureAdUser();
        if (!isMounted) return;

        if (user) {
          setAzureAdEmail(user.email);
          setAzureAdUserName(user.name);
          console.info('[AzureAD] Session restored. Showing app for:', user.name || '(unknown user)');
          setIsAzureAdReady(true);
          return;
        }

        const params = new URLSearchParams(window.location.search);
        if (params.has('error')) {
          console.info('[AzureAD] No session found and URL contains an error parameter; staying on page.');
          setIsAzureAdReady(true);
          return;
        }

        console.info('[AzureAD] No session found. Redirecting to Azure AD sign-in...');
        window.location.href = '/api/auth/login';
      } catch (error) {
        console.warn('[AzureAD] Failed during startup auth flow:', error);
        if (isMounted) {
          setIsAzureAdReady(true);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamedContent]);

  useEffect(() => {
    if (!showDocSetup) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDocSetup(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showDocSetup]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const threshold = 50;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    shouldAutoScrollRef.current = isNearBottom;
  }, []);

  useEffect(() => {
    if (!isResizingPdf) return;

    const onMove = (e: PointerEvent) => {
      const next = Math.round(window.innerWidth - e.clientX);
      setPdfPanelWidth(Math.min(1100, Math.max(360, next)));
    };
    const endResize = () => {
      resizePointerIdRef.current = null;
      setIsResizingPdf(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
    window.addEventListener('blur', endResize);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      window.removeEventListener('blur', endResize);
    };
  }, [isResizingPdf]);

  const buildPdfViewerUrl = (url: string) => {
    if (!url) return url;
    const hash = 'navpanes=0&pagemode=none&view=FitH&zoom=80';
    return url.split('#')[0] + '#' + hash;
  };

  const openPreview = (kind: 'pdf' | 'image', url: string, title?: string) => {
    setPreview({ kind, url, title });
    if (kind === 'image') setZoom(1);
  };

  const openPreviewInNewWindow = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const resetChat = () => {
    setMessages([]);
    setStreamedContent('');
    setCurrentThinkingSteps([]);
    setPreview(null);
    setInput('');
    setChatSessionId(crypto.randomUUID());
  };

  const handleAzureAdSignOut = useCallback(() => {
    signOutAzureAd();
    setAzureAdEmail('');
    setAzureAdUserName('');
    setMessages([]);
    setStreamedContent('');
    setCurrentThinkingSteps([]);
    setInput('');
  }, []);

  const searchDocuments = async () => {
    if (!model.trim() || !language || isSearching) return;

    setIsSearching(true);
    setSearchError(null);
    setHasSearched(false);
    setDocuments({ shop_manual: [], operation_and_maintenance_manual: [] });
    setSelectedShopManual(null);
    setSelectedOperationManual(null);
    setDocSearchQuery('');
    resetChat();

    try {
      const response = await fetch('/api/documents/search', {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model: model.trim(),
          serial: serial.trim(),
          language,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `Search failed: ${response.status}`);
      }

      const data = (await response.json()) as DocumentSearchResults;
      setDocuments({
        shop_manual: Array.isArray(data.shop_manual) ? data.shop_manual : [],
        operation_and_maintenance_manual: Array.isArray(data.operation_and_maintenance_manual)
          ? data.operation_and_maintenance_manual
          : [],
      });
      setHasSearched(true);
    } catch (error) {
      console.error('Error searching documents:', error);
      setSearchError((error as Error).message);
    } finally {
      setIsSearching(false);
    }
  };

  const selectShopManual = (doc: Document) => {
    if (selectedShopManual?.documentNumber === doc.documentNumber) return;
    setSelectedShopManual(doc);
    setActiveThinkingSourceKey('shop_manual');
    resetChat();
  };

  const selectOperationManual = (doc: Document) => {
    if (selectedOperationManual?.documentNumber === doc.documentNumber) return;
    setSelectedOperationManual(doc);
    setActiveThinkingSourceKey('operation_and_maintenance_manual');
    resetChat();
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || selectedDocuments.length === 0) return;

    const queryText = input;
    const docsForSend = selectedDocuments;
    const userMessage: ChatMessageType = { role: 'user', content: queryText };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setStreamedContent('');
    setCurrentThinkingSteps([]);

    let fullText = '';

    try {
      const controller = new AbortController();
      abortRef.current = controller;
      const streamResponse = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        signal: controller.signal,
        body: JSON.stringify({
          query: queryText,
          selectedDocuments: docsForSend,
          chatHistory: messages,
          chatSessionId,
          userEmail: azureAdEmail,
        }),
      });

      if (!streamResponse.ok) {
        throw new Error('Failed to stream response');
      }

      const reader = streamResponse.body?.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      let meta: any = null;

      if (reader) {
        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await reader.read();
          } catch (e: any) {
            if (e?.name === 'AbortError') {
              break;
            }
            throw e;
          }

          const { done, value } = readResult;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split(/\n/).map((l) => l.trim()).filter(Boolean);
            const eventLine = lines.find((l) => l.startsWith('event:'));
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (!dataLine) continue;

            const eventName = eventLine ? eventLine.replace('event:', '').trim() : 'message';
            const dataText = dataLine.replace('data:', '').trim();
            let payload: any;
            try {
              payload = JSON.parse(dataText);
            } catch {
              payload = null;
            }

            if (eventName === 'steps' && payload?.steps) {
              setCurrentThinkingSteps(payload.steps);
            }
            if (eventName === 'meta' && payload) {
              meta = payload;
              if (payload.thinkingSteps) {
                setCurrentThinkingSteps(payload.thinkingSteps);
              }
            }
            if (eventName === 'chunk' && payload?.text) {
              fullText += payload.text;
              setStreamedContent(fullText);
            }
            if (eventName === 'final' && typeof payload?.text === 'string') {
              fullText = payload.text;
              setStreamedContent(fullText);
            }
          }
        }
      }

      const assistantMessage: ChatMessageType = {
        role: 'assistant',
        content: fullText,
        thinkingSteps: meta?.thinkingSteps || currentThinkingSteps,
        thinkingStepsBySource: thinkingSources.reduce<Record<string, ThinkingStep[]>>((acc, source) => {
          acc[source.key] = meta?.thinkingSteps || currentThinkingSteps;
          return acc;
        }, {}),
        thinkingQuery: queryText,
        thinkingDocuments: docsForSend,
        thinkingSources: selectedDocuments.map((doc) => ({
          key: doc.sourceDocumentType?.includes('operationandmaintenancemanual')
            ? 'operation_and_maintenance_manual'
            : 'shop_manual',
          label: doc.documentType || doc.documentTitle,
        })),
        activeThinkingSourceKey,
        imageUrls: meta?.imageUrls,
        pdfUrls: meta?.pdfUrls,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setStreamedContent('');
    } catch (error: any) {
      const isAbort = error?.name === 'AbortError';
      if (isAbort) {
        if (fullText) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: fullText,
              thinkingSteps: currentThinkingSteps,
              thinkingStepsBySource: thinkingSources.reduce<Record<string, ThinkingStep[]>>((acc, source) => {
                acc[source.key] = currentThinkingSteps;
                return acc;
              }, {}),
              thinkingQuery: queryText,
              thinkingDocuments: docsForSend,
              thinkingSources,
              activeThinkingSourceKey: activeThinkingSource,
            },
          ]);
          setStreamedContent('');
        }
      } else {
        console.error('Error sending message:', error);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Sorry, an error occurred while processing your request.' },
        ]);
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const filteredDocs = (docSearchQuery
    ? {
        shop_manual: documents.shop_manual.filter(
          (doc) =>
            doc.documentNumber.toLowerCase().includes(docSearchQuery.toLowerCase()) ||
            doc.documentTitle.toLowerCase().includes(docSearchQuery.toLowerCase())
        ),
        operation_and_maintenance_manual: documents.operation_and_maintenance_manual.filter(
          (doc) =>
            doc.documentNumber.toLowerCase().includes(docSearchQuery.toLowerCase()) ||
            doc.documentTitle.toLowerCase().includes(docSearchQuery.toLowerCase())
        ),
      }
    : documents
  );

  const sortedShopDocs = filteredDocs.shop_manual.slice().sort((a, b) => a.documentNumber.localeCompare(b.documentNumber));
  const sortedOperationDocs = filteredDocs.operation_and_maintenance_manual
    .slice()
    .sort((a, b) => a.documentNumber.localeCompare(b.documentNumber));

  const thinkingSources = selectedDocuments.reduce<{ key: string; label: string }[]>((acc, doc) => {
    const key = getSourceKeyFromDocument(doc);
    if (acc.some((s) => s.key === key)) return acc;
    acc.push({ key, label: getSourceLabel(key) });
    return acc;
  }, []);
  const activeThinkingSource = thinkingSources.find((source) => source.key === activeThinkingSourceKey)?.key
    || thinkingSources[0]?.key
    || 'shop_manual';

  const canChat = selectedDocuments.length > 0;
  const isLanding = messages.length === 0 && !isLoading;
  const selectedDocumentParts = [
    model.trim() && `機種型式 ${model.trim()}`,
    serial.trim() && `機番 ${serial.trim()}`,
    selectedShopManual && formatSelectedDocument('ショップ', selectedShopManual),
    selectedOperationManual && formatSelectedDocument('取説', selectedOperationManual),
  ].filter((part): part is string => Boolean(part));
  const selectedDocumentsTitle = [
    model.trim() && `機種型式: ${model.trim()}`,
    serial.trim() && `機番: ${serial.trim()}`,
    selectedShopManual && `ショップ: ${selectedShopManual.documentTitle} (${selectedShopManual.documentNumber})`,
    selectedOperationManual && `取説: ${selectedOperationManual.documentTitle} (${selectedOperationManual.documentNumber})`,
  ].filter(Boolean).join('\n');

  const composer = canChat ? (
    <ChatComposer
      textareaRef={textareaRef}
      value={input}
      onChange={setInput}
      onKeyDown={handleKeyDown}
      onSend={handleSend}
      isLoading={isLoading}
      placeholder="手順、エラーコード、コネクタについて質問できます…"
      documentParts={selectedDocumentParts}
      documentTitle={selectedDocumentsTitle}
      onChangeDocuments={() => setShowDocSetup(true)}
    />
  ) : null;

  if (!isAzureAdReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 px-4 text-neutral-500">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Azure AD認証画面へ移動しています…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900">
      <aside className="w-[220px] shrink-0 border-r border-neutral-200 bg-white flex flex-col">
        <div className="p-2">
          <button
            type="button"
            onClick={resetChat}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 transition hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50"
            title="新規チャット"
          >
            <Plus className="h-4 w-4" />
            新規チャット
          </button>
        </div>
        {isAzureAdEnabled && (
          <div className="mt-auto p-2 border-t border-neutral-100">
            {azureAdUserName ? (
              <div className="px-1">
                <div className="text-[11px] text-neutral-500 truncate" title={azureAdEmail}>
                  {azureAdUserName || 'Signed in'}
                </div>
                <button
                  type="button"
                  onClick={handleAzureAdSignOut}
                  className="mt-1 text-xs text-neutral-500 hover:text-neutral-800"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="px-1 text-[11px] text-red-600">Not authenticated</div>
            )}
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative">
        {isLanding ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <div className="w-full max-w-2xl flex flex-col items-center">
              <div className="text-center mb-8">
                <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
                  改善版AI bot試作版
                </h1>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  対象機種のマニュアルを選んで、手順・故障・エラーコードを質問できます
                </p>
              </div>

              {!canChat && (
                <button
                  type="button"
                  onClick={() => setShowDocSetup(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-neutral-800 hover:shadow-lg active:scale-[0.98]"
                >
                  <Settings2 className="h-4 w-4" />
                  ドキュメント設定
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}

              {composer && (
                <div className="mt-8 w-full">
                  {composer}
                  {isLoading && (
                    <div className="mt-2 flex justify-center">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => abortRef.current?.abort()}
                        className="h-7 px-2 text-xs gap-1"
                        title="生成を停止"
                      >
                        <Square className="h-3.5 w-3.5" />
                        停止
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto w-full px-4 pt-4 pb-36 space-y-4">
                {messages.map((message, index) => (
                  <ChatMessage
                    key={index}
                    message={message}
                    onOpenPdf={(url, title) => openPreview('pdf', url, title)}
                    onOpenImage={(url, alt) => openPreview('image', url, alt)}
                  />
                ))}

                {isLoading && (
                  <div className="space-y-3">
                    <ThinkingProcess steps={currentThinkingSteps} live />
                    {streamedContent ? (
                      <ChatMessage
                        message={{
                          role: 'assistant',
                          content: streamedContent,
                          thinkingSteps: [],
                          thinkingSources,
                          activeThinkingSourceKey: activeThinkingSource,
                        }}
                        onOpenPdf={(url, title) => openPreview('pdf', url, title)}
                        onOpenImage={(url, alt) => openPreview('image', url, alt)}
                      />
                    ) : (
                      <div className="flex items-center gap-2 text-neutral-500 text-sm pl-1">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>回答を作成しています…</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-neutral-50 via-neutral-50/95 to-transparent pt-10 pb-4 px-4">
              <div className="pointer-events-auto max-w-3xl mx-auto">
                {isLoading && (
                  <div className="mb-2 flex justify-center">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => abortRef.current?.abort()}
                      className="h-7 px-2 text-xs gap-1"
                      title="生成を停止"
                    >
                      <Square className="h-3.5 w-3.5" />
                      停止
                    </Button>
                  </div>
                )}
                {composer}
              </div>
            </div>
          </>
        )}
      </main>

      {preview && preview.url && (
        <>
          <div
            className="w-1.5 cursor-col-resize bg-transparent hover:bg-neutral-200/70 active:bg-neutral-300/70"
            onPointerDown={(e) => {
              e.preventDefault();
              try {
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                resizePointerIdRef.current = e.pointerId;
              } catch {
                // ignore
              }
              setIsResizingPdf(true);
            }}
            title="Drag to resize"
          />
          <aside className="shrink-0 border-l border-neutral-200 bg-white flex flex-col" style={{ width: pdfPanelWidth }}>
            <div className="h-10 px-3 border-b border-neutral-200 flex items-center gap-1.5">
              {preview.kind === 'pdf' ? (
                <FileText className="h-4 w-4 text-neutral-500 shrink-0" />
              ) : (
                <ImageIcon className="h-4 w-4 text-neutral-500 shrink-0" />
              )}
              <div className="flex-1 min-w-0 text-sm font-semibold truncate">
                {preview.title || (preview.kind === 'pdf' ? 'PDF Viewer' : 'Image')}
              </div>
              {preview.kind === 'image' && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}
                    title="縮小"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <div className="text-[11px] text-neutral-500 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}
                    title="拡大"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(1)} title="リセット">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <button
                type="button"
                onClick={() => openPreviewInNewWindow(preview.url)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-neutral-100"
                title="別ウィンドウで開く"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
              <Button variant="ghost" size="icon" onClick={() => setPreview(null)} title="Close" className="h-7 w-7">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {preview.kind === 'pdf' ? (
              <iframe title="pdf" src={buildPdfViewerUrl(preview.url)} className="flex-1 w-full h-full" />
            ) : (
              <div className="flex-1 bg-neutral-900 overflow-auto">
                <div className="min-h-full min-w-full flex items-center justify-center p-4">
                  <img
                    src={preview.url}
                    alt={preview.title || 'Image'}
                    style={{ transform: `scale(${zoom})` }}
                    className="origin-center select-none max-w-none"
                  />
                </div>
              </div>
            )}
          </aside>
        </>
      )}

      {showDocSetup && (
        <DocumentSetupModal
          model={model}
          serial={serial}
          language={language}
          isSearching={isSearching}
          searchError={searchError}
          hasSearched={hasSearched}
          docSearchQuery={docSearchQuery}
          sortedShopDocs={sortedShopDocs}
          sortedOperationDocs={sortedOperationDocs}
          selectedShopManual={selectedShopManual}
          selectedOperationManual={selectedOperationManual}
          selectedCount={selectedDocuments.length}
          onModelChange={setModel}
          onSerialChange={setSerial}
          onLanguageChange={setLanguage}
          onDocSearchQueryChange={setDocSearchQuery}
          onSearch={searchDocuments}
          onSelectShopManual={selectShopManual}
          onSelectOperationManual={selectOperationManual}
          onClose={() => setShowDocSetup(false)}
        />
      )}
    </div>
  );
}

function SelectedDocumentsLine({
  parts,
  title,
  disabled,
  onChange,
}: {
  parts: string[];
  title: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] text-neutral-500" title={title}>
        <BookOpen className="h-3 w-3 shrink-0 text-neutral-400" />
        {parts.map((part, index) => (
          <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && <span className="shrink-0 text-neutral-300">·</span>}
            <span className="truncate">{part}</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50"
      >
        <Settings2 className="h-3 w-3" />
        変更
      </button>
    </div>
  );
}

function ChatComposer({
  textareaRef,
  value,
  onChange,
  onKeyDown,
  onSend,
  isLoading,
  placeholder,
  documentParts,
  documentTitle,
  onChangeDocuments,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  isLoading: boolean;
  placeholder: string;
  documentParts: string[];
  documentTitle: string;
  onChangeDocuments: () => void;
}) {
  return (
    <div className="border border-neutral-300 rounded-2xl bg-white shadow-sm px-3 pt-2.5 pb-2 transition-colors focus-within:border-neutral-500 focus-within:shadow-md">
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          title="Enterで送信 · Shift+Enterで改行"
          disabled={isLoading}
          rows={2}
          className="flex-1 resize-none outline-none text-sm leading-6 min-h-[52px] max-h-40 bg-transparent py-0.5 disabled:text-neutral-400 disabled:cursor-not-allowed"
        />
        <Button
          onClick={onSend}
          disabled={isLoading || !value.trim()}
          size="icon"
          className="h-8 w-8 rounded-full shrink-0 mt-0.5"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <div className="mt-2 pt-1.5 border-t border-neutral-100">
        <SelectedDocumentsLine
          parts={documentParts}
          title={documentTitle}
          disabled={isLoading}
          onChange={onChangeDocuments}
        />
      </div>
    </div>
  );
}

function DocumentSetupModal({
  model,
  serial,
  language,
  isSearching,
  searchError,
  hasSearched,
  docSearchQuery,
  sortedShopDocs,
  sortedOperationDocs,
  selectedShopManual,
  selectedOperationManual,
  selectedCount,
  onModelChange,
  onSerialChange,
  onLanguageChange,
  onDocSearchQueryChange,
  onSearch,
  onSelectShopManual,
  onSelectOperationManual,
  onClose,
}: {
  model: string;
  serial: string;
  language: string;
  isSearching: boolean;
  searchError: string | null;
  hasSearched: boolean;
  docSearchQuery: string;
  sortedShopDocs: Document[];
  sortedOperationDocs: Document[];
  selectedShopManual: Document | null;
  selectedOperationManual: Document | null;
  selectedCount: number;
  onModelChange: (value: string) => void;
  onSerialChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onDocSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onSelectShopManual: (doc: Document) => void;
  onSelectOperationManual: (doc: Document) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative w-full max-w-3xl max-h-[88vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="doc-setup-title"
      >
        <div className="px-6 py-4 border-b border-neutral-200 flex items-start justify-between gap-3">
          <div>
            <h2 id="doc-setup-title" className="text-lg font-semibold tracking-tight">
              ドキュメント設定
            </h2>
            <p className="text-sm text-neutral-500 mt-0.5">
              機種型式・機番・言語を指定して検索し、各マニュアルから1冊ずつ選択します。
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title="閉じる">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-6 py-5 border-b border-neutral-100">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-[1.4]">
              <label className="block text-xs font-medium text-neutral-600 mb-1">
                機種型式 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                placeholder="例: PC200-10M0"
                className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
              />
            </div>
            <div className="min-w-0 flex-1">
              <label className="block text-xs font-medium text-neutral-600 mb-1">機番</label>
              <input
                type="text"
                value={serial}
                onChange={(e) => onSerialChange(e.target.value)}
                placeholder="任意"
                className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
              />
            </div>
            <div className="w-[148px] shrink-0">
              <label className="block text-xs font-medium text-neutral-600 mb-1">ドキュメント言語</label>
              <select
                value={language}
                onChange={(e) => onLanguageChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500 bg-white"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={onSearch}
              disabled={!model.trim() || isSearching}
              className="shrink-0 gap-1.5"
            >
              {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              検索
            </Button>
          </div>
          {searchError && (
            <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
              {searchError}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 min-h-[220px]">
          {!hasSearched ? (
            <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center text-neutral-500">
              <Search className="h-8 w-8 text-neutral-300 mb-3" />
              <div className="text-sm font-medium text-neutral-600">検索すると、ここにドキュメント一覧が表示されます</div>
              <div className="text-xs mt-1">Shop Manual と Operation & Maintenance Manual からそれぞれ1冊選択できます</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">ドキュメント一覧</div>
                <div className="relative w-56">
                  <Search className="absolute left-2.5 top-2 h-4 w-4 text-neutral-400" />
                  <input
                    type="text"
                    placeholder="結果を絞り込み…"
                    value={docSearchQuery}
                    onChange={(e) => onDocSearchQueryChange(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-neutral-200">
                <div className="md:pr-5">
                  <DocumentSection
                    title="Shop Manual"
                    count={sortedShopDocs.length}
                    documents={sortedShopDocs}
                    selectedDocument={selectedShopManual}
                    fallbackModel={model}
                    fallbackSerial={serial}
                    onSelect={onSelectShopManual}
                  />
                </div>
                <div className="md:pl-5">
                  <DocumentSection
                    title="Operation & Maintenance Manual"
                    count={sortedOperationDocs.length}
                    documents={sortedOperationDocs}
                    selectedDocument={selectedOperationManual}
                    fallbackModel={model}
                    fallbackSerial={serial}
                    onSelect={onSelectOperationManual}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {selectedCount > 0 ? `${selectedCount}冊を選択中` : '各カテゴリから1冊ずつ選択できます'}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            <Button onClick={onClose} disabled={selectedCount === 0}>
              完了
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocRow({
  label,
  sub,
  detail,
  meta,
  downloadUrl,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  detail?: string;
  meta?: string;
  downloadUrl?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`w-full rounded-lg text-sm flex items-stretch transition-colors ${active ? 'bg-neutral-900 text-white' : 'hover:bg-neutral-100'}`}>
      <button type="button" onClick={onClick} className="flex-1 text-left px-3 py-2 flex items-start gap-2 min-w-0">
        <span
          className={`mt-1 h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
            active ? 'bg-white border-white text-neutral-900' : 'border-neutral-400 text-transparent'
          }`}
        >
          <Check className="h-3 w-3" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block font-medium truncate">{label}</span>
            {meta && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${active ? 'bg-neutral-700 text-neutral-200' : 'bg-neutral-100 text-neutral-500'}`}>
                {meta}
              </span>
            )}
          </span>
          {sub && (
            <span className={`block text-[11px] truncate ${active ? 'text-neutral-300' : 'text-neutral-500'}`}>
              {sub}
            </span>
          )}
          {detail && (
            <span className={`block text-[11px] truncate ${active ? 'text-neutral-400' : 'text-neutral-400'}`}>
              {detail}
            </span>
          )}
        </span>
      </button>
      {downloadUrl && (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open document"
          className={`shrink-0 self-center rounded-md p-1.5 mx-1 transition-colors ${
            active ? 'text-white hover:bg-neutral-700' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900'
          }`}
        >
          <Download className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

function DocumentSection({
  title,
  count,
  documents,
  selectedDocument,
  fallbackModel,
  fallbackSerial,
  onSelect,
}: {
  title: string;
  count: number;
  documents: Document[];
  selectedDocument: Document | null;
  fallbackModel?: string;
  fallbackSerial?: string;
  onSelect: (doc: Document) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-700">{title}</div>
        <div className="text-[11px] text-neutral-500">{count}件</div>
      </div>
      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-500">
          該当するドキュメントはありません。
        </div>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => (
            <DocRow
              key={`${title}-${doc.documentNumber}`}
              label={doc.documentTitle}
              sub={doc.documentNumber}
              detail={formatModelSerial(doc, fallbackModel, fallbackSerial)}
              meta={doc.language}
              downloadUrl={doc.documentUrl}
              active={selectedDocument?.documentNumber === doc.documentNumber}
              onClick={() => onSelect(doc)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
