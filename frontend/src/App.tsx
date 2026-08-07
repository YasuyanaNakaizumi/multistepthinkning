import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from './components/ui/button';
import { ScrollArea } from './components/ui/scroll-area';
import { ChatMessage } from './components/ChatMessage';
import { ThinkingProcess } from './components/ThinkingProcess';
import { fetchAzureAdUser, signOutAzureAd } from './lib/azureAd';
import {
  Send,
  Loader2,
  FileText,
  PanelLeft,
  PanelRight,
  Plus,
  Square,
  X,
  Check,
  ExternalLink,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Search,
  Settings2,
} from 'lucide-react';
import { ChatMessage as ChatMessageType, ThinkingStep } from './types';
import type { Document } from './types';

const LANGUAGES = [
  { value: 'English', label: 'English' },
  { value: 'Japanese', label: '日本語' },
];

type DocumentSearchResults = {
  shop_manual: Document[];
  operation_and_maintenance_manual: Document[];
};

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
  const [selectedPdf, setSelectedPdf] = useState<{ url: string; title?: string } | null>(null);
  const [showDocs, setShowDocs] = useState(true);
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [language, setLanguage] = useState('English');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; alt?: string } | null>(null);
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
      // PDF panel is on the right; width is distance from cursor to right edge
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
    // Preserve any existing hash by replacing it with our viewer preferences.
    return url.split('#')[0] + '#' + hash;
  };

  const resetChat = () => {
    setMessages([]);
    setStreamedContent('');
    setCurrentThinkingSteps([]);
    setSelectedPdf(null);
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
    setDocuments({ shop_manual: [], operation_and_maintenance_manual: [] });
    setSelectedShopManual(null);
    setSelectedOperationManual(null);
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
            // AbortController abort() may surface here depending on browser.
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
      {showDocs && (
        <aside className="w-80 shrink-0 border-r border-neutral-200 bg-white flex flex-col">
          <div className="h-14 px-4 border-b border-neutral-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Settings2 className="h-4 w-4 text-neutral-500" />
              Document Setup
            </div>
            <Button variant="ghost" size="icon" onClick={() => setShowDocs(false)} title="Hide">
              <PanelLeft className="h-4 w-4" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Model</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="e.g. PC200-10M0"
                    className="w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:border-neutral-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Serial</label>
                  <input
                    type="text"
                    value={serial}
                    onChange={(e) => setSerial(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:border-neutral-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:border-neutral-500 bg-white"
                  >
                    {LANGUAGES.map((lang) => (
                      <option key={lang.value} value={lang.value}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={searchDocuments}
                  disabled={!model.trim() || isSearching}
                  className="w-full gap-1.5"
                  size="sm"
                >
                  {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search Documents
                </Button>
              </div>

              {searchError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md p-2">
                  {searchError}
                </div>
              )}

              {(documents.shop_manual.length > 0 || documents.operation_and_maintenance_manual.length > 0) && (
                <div className="border-t border-neutral-200 pt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-neutral-600 uppercase tracking-wide">Documents</div>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2 h-4 w-4 text-neutral-400" />
                    <input
                      type="text"
                      placeholder="Filter results..."
                      value={docSearchQuery}
                      onChange={(e) => setDocSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 text-sm border border-neutral-300 rounded-md focus:outline-none focus:border-neutral-500"
                    />
                  </div>
                  <div className="space-y-3">
                    <DocumentSection
                      title="Shop Manual"
                      count={sortedShopDocs.length}
                      documents={sortedShopDocs}
                      selectedDocument={selectedShopManual}
                      onSelect={selectShopManual}
                    />
                    <DocumentSection
                      title="Operation & Maintenance Manual"
                      count={sortedOperationDocs.length}
                      documents={sortedOperationDocs}
                      selectedDocument={selectedOperationManual}
                      onSelect={selectOperationManual}
                    />
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </aside>
      )}

      <main className="flex-1 flex flex-col min-w-0">
        <header className="h-14 px-4 border-b border-neutral-200 bg-white flex items-center">
          <div className="flex items-center gap-2 w-[220px]">
            {!showDocs && (
              <Button variant="ghost" size="icon" onClick={() => setShowDocs(true)} title="Documents">
                <PanelLeft className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="flex-1 min-w-0 text-center px-4">
            <div className="text-sm font-semibold truncate">
              {selectedDocuments.length > 0 ? selectedDocuments.map((doc) => doc.documentNumber).join(' + ') : 'Multi-Stage Thinking Chat'}
            </div>
            <div className="text-xs text-neutral-500 truncate">
              {selectedDocuments.length > 0
                ? selectedDocuments.map((doc) => doc.documentTitle).join(' + ')
                : 'Technical documentation assistant'}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 w-[220px]">
            {isAzureAdEnabled &&
              (azureAdUserName ? (
                <div className="flex items-center gap-2">
                  <div className="text-[11px] text-neutral-500 max-w-[120px] truncate" title={azureAdEmail}>
                    {azureAdUserName || 'Signed in'}
                  </div>
                  <Button variant="ghost" size="sm" onClick={handleAzureAdSignOut} className="gap-1.5">
                    <X className="h-4 w-4" />
                    Sign out
                  </Button>
                </div>
              ) : (
                <div className="text-[11px] text-red-600">Not authenticated</div>
              ))}



            {isLoading && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => abortRef.current?.abort()}
                className="gap-1.5"
                title="Stop generating"
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}

            <Button variant="default" size="sm" disabled={isLoading} onClick={resetChat} className="gap-1.5" title="Start a new chat">
              <Plus className="h-4 w-4" />
              New Chat
            </Button>

            {!selectedPdf && (
              <Button variant="ghost" size="icon" onClick={() => setSelectedPdf({ url: '', title: '' })} title="PDF panel" disabled>
                <PanelRight className="h-4 w-4 opacity-40" />
              </Button>
            )}
          </div>
        </header>

        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-6">
            {messages.length === 0 && !isLoading && <EmptyState />}

            {messages.map((message, index) => (
              <ChatMessage
                key={index}
                message={message}
                onOpenPdf={(url, title) => setSelectedPdf({ url, title })}
                onOpenImage={(url, alt) => {
                  setLightbox({ url, alt });
                  setZoom(1);
                }}
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
                    onOpenPdf={(url, title) => setSelectedPdf({ url, title })}
                    onOpenImage={(url, alt) => {
                      setLightbox({ url, alt });
                      setZoom(1);
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2 text-neutral-500 text-sm pl-1">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Working on your answer…</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-neutral-200 bg-white">
          <div className="max-w-3xl mx-auto w-full p-4">
            <div className="flex items-end gap-2 border border-neutral-300 rounded-2xl px-3 py-2 bg-white focus-within:border-neutral-500 transition-colors">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  selectedDocuments.length > 0
                    ? 'Ask about procedures, error codes, connectors…'
                    : 'Select a shop manual or operation manual on the left to start chatting'
                }
                disabled={isLoading || selectedDocuments.length === 0}
                rows={1}
                className="flex-1 resize-none outline-none text-sm leading-6 max-h-40 bg-transparent py-1"
              />
              <Button
                onClick={handleSend}
                disabled={isLoading || !input.trim() || selectedDocuments.length === 0}
                size="icon"
                className="h-8 w-8 rounded-full"
              >
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="mt-2 text-[11px] text-neutral-400 text-center">Enter to send · Shift+Enter for newline</div>
          </div>
        </div>
      </main>

      {selectedPdf && selectedPdf.url && (
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
            <div className="h-14 px-3 border-b border-neutral-200 flex items-center gap-2">
              <FileText className="h-4 w-4 text-neutral-500" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{selectedPdf.title || 'PDF Viewer'}</div>
                <div className="text-[11px] text-neutral-500 truncate">Right panel viewer</div>
              </div>
              <a
                href={selectedPdf.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-neutral-100"
                title="Open in new tab"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <Button variant="ghost" size="icon" onClick={() => setSelectedPdf(null)} title="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <iframe title="pdf" src={buildPdfViewerUrl(selectedPdf.url)} className="flex-1 w-full h-full" />
          </aside>
        </>
      )}

      {lightbox && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <div
            className="bg-white rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] w-[1100px] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-12 px-3 border-b border-neutral-200 flex items-center gap-2">
              <div className="flex-1 min-w-0 text-sm font-medium truncate">{lightbox.alt || 'Image'}</div>
              <Button variant="ghost" size="icon" onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <div className="text-xs text-neutral-500 w-14 text-center tabular-nums">{Math.round(zoom * 100)}%</div>
              <Button variant="ghost" size="icon" onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setZoom(1)} title="Reset">
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => setLightbox(null)} title="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 bg-neutral-900 overflow-auto">
              <div className="min-h-full min-w-full flex items-center justify-center p-6">
                <img
                  src={lightbox.url}
                  alt={lightbox.alt || 'Image'}
                  style={{ transform: `scale(${zoom})` }}
                  className="origin-center select-none max-w-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DocRow({
  label,
  sub,
  meta,
  downloadUrl,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
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
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${active ? 'bg-neutral-700 text-neutral-200' : 'bg-neutral-100 text-neutral-500'}`}>
                {meta}
              </span>
            )}
          </span>
          {sub && (
            <span
              className={`block text-[11px] ${active ? 'text-neutral-300' : 'text-neutral-500'}`}
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {sub}
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
  onSelect,
}: {
  title: string;
  count: number;
  documents: Document[];
  selectedDocument: Document | null;
  onSelect: (doc: Document) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-700">{title}</div>
        <div className="text-[11px] text-neutral-500">{count} results</div>
      </div>
      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-500">No matching documents.</div>
      ) : (
        <div className="space-y-1">
          {documents.map((doc) => (
            <DocRow
              key={`${title}-${doc.documentNumber}`}
              label={doc.documentNumber}
              sub={doc.documentTitle}
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
function EmptyState() {
  return (
    <div className="py-16 text-center">
      <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-neutral-900 text-white mb-4">
        <FileText className="h-6 w-6" />
      </div>
      <div className="text-lg font-semibold">Ask about the manual</div>
      <div className="text-sm text-neutral-500 mt-1">
        Search for a model and select a manual on the left, then ask a question.
      </div>
    </div>
  );
}

export default App;
