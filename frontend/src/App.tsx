import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
  Menu,
  ChevronDown,
} from 'lucide-react';
import { ChatMessage as ChatMessageType, ThinkingStep } from './types';
import type { Document } from './types';
import { useLocale, formatReasoningEffortLabel } from './i18n';

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

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function formatSelectedDocument(label: string, doc: Document, maxTitleLength = 22): string {
  const title = truncateText(doc.documentTitle || doc.documentNumber, maxTitleLength);
  return `${label}: ${title} (${doc.documentNumber})`;
}

function TruncatedWithTooltip({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const pressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setTruncated(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [text, measure]);

  const show = () => {
    if (!truncated) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - 16;
    setPos({
      top: rect.bottom + 6,
      left: Math.min(rect.left, Math.max(8, maxLeft - Math.min(rect.width, window.innerWidth * 0.9))),
    });
    setOpen(true);
  };

  const hide = () => setOpen(false);

  const clearTimers = () => {
    if (pressTimer.current) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  return (
    <>
      <span
        ref={ref}
        className={className}
        title={truncated ? text : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onTouchStart={() => {
          if (!truncated) return;
          clearTimers();
          pressTimer.current = window.setTimeout(show, 350);
        }}
        onTouchEnd={() => {
          clearTimers();
          hideTimer.current = window.setTimeout(hide, 1600);
        }}
        onTouchCancel={clearTimers}
      >
        {text}
      </span>
      {open && truncated &&
        createPortal(
          <span
            className="pointer-events-none fixed z-[80] max-w-[min(90vw,28rem)] rounded-md bg-neutral-900 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg"
            style={{ top: pos.top, left: pos.left }}
            role="tooltip"
          >
            {text}
          </span>,
          document.body
        )}
    </>
  );
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
  const { locale, setLocale, t } = useLocale();
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [documents, setDocuments] = useState<DocumentSearchResults>({ shop_manual: [], operation_and_maintenance_manual: [] });
  const [selectedShopManual, setSelectedShopManual] = useState<Document | null>(null);
  const [selectedOperationManual, setSelectedOperationManual] = useState<Document | null>(null);
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const [streamedContent, setStreamedContent] = useState('');
  const [streamImageUrls, setStreamImageUrls] = useState<string[]>([]);
  const [streamAnswerTiming, setStreamAnswerTiming] = useState<{
    firstTokenMs: number;
    completeMs?: number;
    modelFirstTokenMs?: number;
    holdDelayMs?: number;
  } | null>(null);
  const [streamAnswerReasoningEffort, setStreamAnswerReasoningEffort] = useState<string | null>(null);
  const [streamHolding, setStreamHolding] = useState(false);
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
  const [chatMode, setChatMode] = useState<'thinking' | 'fast'>('thinking');
  const [showMobileNav, setShowMobileNav] = useState(false);
  const [composerPad, setComposerPad] = useState(180);
  const selectedDocuments = [selectedShopManual, selectedOperationManual].filter(Boolean) as Document[];
  const resizePointerIdRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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
    const root = document.documentElement;
    const apply = () => {
      const vv = window.visualViewport;
      root.style.setProperty('--app-height', `${vv?.height ?? window.innerHeight}px`);
      root.style.setProperty('--app-offset-top', `${vv?.offsetTop ?? 0}px`);
    };
    apply();
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, []);

  useEffect(() => {
    if (preview) {
      shouldAutoScrollRef.current = false;
      return;
    }
    if (shouldAutoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamedContent, preview]);

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
    shouldAutoScrollRef.current = false;
    setPreview({ kind, url, title });
    if (kind === 'image') setZoom(1);
  };

  const openPreviewInNewWindow = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const resetChat = () => {
    setMessages([]);
    setStreamedContent('');
    setStreamImageUrls([]);
    setStreamAnswerTiming(null);
    setStreamAnswerReasoningEffort(null);
    setStreamHolding(false);
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
    setStreamImageUrls([]);
    setStreamAnswerTiming(null);
    setStreamAnswerReasoningEffort(chatMode === 'fast' ? 'none' : 'low');
    setStreamHolding(false);
    setCurrentThinkingSteps([]);

    let fullText = '';
    let meta: any = null;
    let latestThinkingSteps: ThinkingStep[] = [];
    let answerReasoningEffort: string | undefined =
      chatMode === 'fast' ? 'none' : 'low';
    const requestStartedAt = performance.now();
    let firstTokenMs: number | null = null;
    let modelFirstTokenMs: number | undefined;
    let modelFirstTokenEventAt: number | null = null;
    let holdDelayMs: number | undefined;
    let pendingPaint = '';
    let paintTimer: number | null = null;

    const flushPaint = () => {
      if (!pendingPaint) return;
      fullText += pendingPaint;
      pendingPaint = '';
      setStreamedContent(fullText);
    };

    const schedulePaint = (text: string) => {
      // First visible character: paint immediately (low UI TTFT).
      if (firstTokenMs === null) {
        firstTokenMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
        if (modelFirstTokenEventAt !== null) {
          holdDelayMs = Math.max(0, Math.round(performance.now() - modelFirstTokenEventAt));
        }
        setStreamAnswerTiming({
          firstTokenMs,
          modelFirstTokenMs,
          holdDelayMs,
        });
        fullText += text;
        setStreamedContent(fullText);
        return;
      }
      // After first char: light coalesce (~32ms) for smoother Markdown updates.
      pendingPaint += text;
      if (paintTimer !== null) return;
      paintTimer = window.setTimeout(() => {
        paintTimer = null;
        flushPaint();
      }, 32);
    };

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
          chatHistory: messages.map((message) => ({ role: message.role, content: message.content })),
          chatSessionId,
          userEmail: azureAdEmail,
          mode: chatMode,
        }),
      });

      if (!streamResponse.ok) {
        throw new Error('Failed to stream response');
      }

      const reader = streamResponse.body?.getReader();
      const decoder = new TextDecoder();

      let buffer = '';

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
            const dataText = dataLine.replace(/^data:\s?/, '').trim();
            let payload: any;
            try {
              payload = JSON.parse(dataText);
            } catch {
              payload = null;
            }

            if (eventName === 'steps' && payload?.steps) {
              latestThinkingSteps = payload.steps;
              setCurrentThinkingSteps(payload.steps);
            }
            if (eventName === 'meta' && payload) {
              meta = payload;
              if (typeof payload.answerReasoningEffort === 'string') {
                answerReasoningEffort = payload.answerReasoningEffort;
                setStreamAnswerReasoningEffort(payload.answerReasoningEffort);
              }
              if (Array.isArray(payload.imageUrls)) {
                setStreamImageUrls(payload.imageUrls);
              }
              if (payload.thinkingSteps) {
                latestThinkingSteps = payload.thinkingSteps;
                setCurrentThinkingSteps(payload.thinkingSteps);
              }
            }
            if (eventName === 'timing' && typeof payload?.modelFirstTokenMs === 'number') {
              modelFirstTokenMs = Math.max(0, Math.round(payload.modelFirstTokenMs));
              modelFirstTokenEventAt = performance.now();
              setStreamAnswerTiming((prev) =>
                prev
                  ? { ...prev, modelFirstTokenMs }
                  : firstTokenMs !== null
                    ? { firstTokenMs, modelFirstTokenMs }
                    : null
              );
            }
            if (eventName === 'stream_status' && typeof payload?.holding === 'boolean') {
              setStreamHolding(payload.holding);
            }
            if ((eventName === 'chunk' || eventName === 'message') && payload?.text) {
              setStreamHolding(false);
              schedulePaint(String(payload.text));
            }
            if (eventName === 'final' && typeof payload?.text === 'string') {
              if (paintTimer !== null) {
                window.clearTimeout(paintTimer);
                paintTimer = null;
              }
              flushPaint();
              // Apply final rewrite only when it differs (avoid visible jump on identical text).
              if (payload.text !== fullText) {
                fullText = payload.text;
                setStreamedContent(fullText);
              }
              if (firstTokenMs === null && payload.text.length > 0) {
                firstTokenMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
                setStreamAnswerTiming({
                  firstTokenMs,
                  modelFirstTokenMs,
                  holdDelayMs,
                });
              }
            }
          }
        }
      }

      if (paintTimer !== null) {
        window.clearTimeout(paintTimer);
        paintTimer = null;
      }
      flushPaint();
      setStreamHolding(false);

      const completeMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
      const answerTiming =
        firstTokenMs !== null
          ? { firstTokenMs, completeMs, modelFirstTokenMs, holdDelayMs }
          : fullText
            ? { firstTokenMs: completeMs, completeMs, modelFirstTokenMs, holdDelayMs }
            : undefined;
      if (answerTiming) {
        setStreamAnswerTiming(answerTiming);
      }

      const finalThinkingSteps =
        latestThinkingSteps.length > 0
          ? latestThinkingSteps
          : meta?.thinkingSteps || [];

      const assistantMessage: ChatMessageType = {
        role: 'assistant',
        content: fullText,
        thinkingSteps: finalThinkingSteps,
        thinkingStepsBySource: thinkingSources.reduce<Record<string, ThinkingStep[]>>((acc, source) => {
          acc[source.key] = finalThinkingSteps;
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
        answerTiming,
        answerReasoningEffort,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setStreamedContent('');
      setStreamImageUrls([]);
      setStreamAnswerTiming(null);
      setStreamAnswerReasoningEffort(null);
      setStreamHolding(false);
    } catch (error: any) {
      if (paintTimer !== null) {
        window.clearTimeout(paintTimer);
        paintTimer = null;
      }
      flushPaint();
      setStreamHolding(false);
      const isAbort = error?.name === 'AbortError';
      if (isAbort) {
        if (fullText) {
          const completeMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
          const answerTiming = {
            firstTokenMs: firstTokenMs ?? completeMs,
            completeMs,
            modelFirstTokenMs,
            holdDelayMs,
          };
          const finalThinkingSteps =
            latestThinkingSteps.length > 0 ? latestThinkingSteps : currentThinkingSteps;
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: fullText,
              thinkingSteps: finalThinkingSteps,
              thinkingStepsBySource: thinkingSources.reduce<Record<string, ThinkingStep[]>>((acc, source) => {
                acc[source.key] = finalThinkingSteps;
                return acc;
              }, {}),
              thinkingQuery: queryText,
              thinkingDocuments: docsForSend,
              thinkingSources,
              activeThinkingSourceKey: activeThinkingSource,
              imageUrls: meta?.imageUrls,
              pdfUrls: meta?.pdfUrls,
              answerTiming,
              answerReasoningEffort,
            },
          ]);
          setStreamedContent('');
          setStreamImageUrls([]);
          setStreamAnswerTiming(null);
          setStreamAnswerReasoningEffort(null);
        }
      } else {
        console.error('Error sending message:', error);
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: t('chatError') },
        ]);
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
      setStreamHolding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    acc.push({
      key,
      label: key === 'operation_and_maintenance_manual' ? t('ommManual') : t('shopManual'),
    });
    return acc;
  }, []);
  const activeThinkingSource = thinkingSources.find((source) => source.key === activeThinkingSourceKey)?.key
    || thinkingSources[0]?.key
    || 'shop_manual';

  const canChat = selectedDocuments.length > 0;
  const isLanding = messages.length === 0 && !isLoading;
  const selectedDocumentParts = [
    model.trim() && `${t('modelType')} ${model.trim()}`,
    serial.trim() && `${t('serialNumber')} ${serial.trim()}`,
    selectedShopManual && formatSelectedDocument(t('shopShort'), selectedShopManual),
    selectedOperationManual && formatSelectedDocument(t('ommShort'), selectedOperationManual),
  ].filter((part): part is string => Boolean(part));
  const selectedDocumentsTitle = [
    model.trim() && `${t('modelType')}: ${model.trim()}`,
    serial.trim() && `${t('serialNumber')}: ${serial.trim()}`,
    selectedShopManual && `${t('shopShort')}: ${selectedShopManual.documentTitle} (${selectedShopManual.documentNumber})`,
    selectedOperationManual && `${t('ommShort')}: ${selectedOperationManual.documentTitle} (${selectedOperationManual.documentNumber})`,
  ].filter(Boolean).join('\n');

  const composer = canChat ? (
    <ChatComposer
      textareaRef={textareaRef}
      value={input}
      onChange={setInput}
      onKeyDown={handleKeyDown}
      onSend={handleSend}
      isLoading={isLoading}
      placeholder={t('chatPlaceholder')}
      documentParts={selectedDocumentParts}
      documentTitle={selectedDocumentsTitle}
      onChangeDocuments={() => setShowDocSetup(true)}
      chatMode={chatMode}
      onChatModeChange={setChatMode}
    />
  ) : null;

  useEffect(() => {
    if (isLanding) return;
    const el = composerRef.current;
    if (!el) return;
    const update = () => setComposerPad(el.offsetHeight + 24);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isLanding, isLoading, canChat, selectedDocumentParts.join('|')]);

  if (!isAzureAdReady) {
    return (
      <div className="flex h-[var(--app-height,100dvh)] items-center justify-center bg-neutral-50 px-4 text-neutral-500">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('azureAdRedirect')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[var(--app-height,100dvh)] max-w-[100vw] overflow-hidden bg-neutral-50 text-neutral-900">
      {showMobileNav && (
        <div
          className="fixed inset-0 z-30 bg-neutral-900/40 md:hidden"
          onClick={() => setShowMobileNav(false)}
        />
      )}
      <aside
        className={`w-[min(220px,85vw)] bg-white flex flex-col border-r border-neutral-200 fixed inset-y-0 left-0 z-40 transform transition-transform pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:static md:translate-x-0 md:shrink-0 md:pt-0 md:pb-0 ${
          showMobileNav ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              resetChat();
              setShowMobileNav(false);
            }}
            disabled={isLoading}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 transition hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50"
            title={t('newChat')}
          >
            <Plus className="h-4 w-4" />
            {t('newChat')}
          </button>
          <button
            type="button"
            className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-neutral-100"
            onClick={() => setShowMobileNav(false)}
            title={t('close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1" />
        <div className="px-2 pb-2">
          <div className="text-[11px] text-neutral-500 mb-1 px-1">{t('uiLanguage')}</div>
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-neutral-200 p-0.5 bg-neutral-50">
            <button
              type="button"
              onClick={() => setLocale('ja')}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                locale === 'ja' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800'
              }`}
            >
              日本語
            </button>
            <button
              type="button"
              onClick={() => setLocale('en')}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                locale === 'en' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-800'
              }`}
            >
              English
            </button>
          </div>
        </div>
        {isAzureAdEnabled && (
          <div className="p-2 border-t border-neutral-100">
            {azureAdUserName ? (
              <div className="px-1">
                <div className="text-[11px] text-neutral-500 truncate" title={azureAdEmail}>
                  {azureAdUserName || t('signedIn')}
                </div>
                <button
                  type="button"
                  onClick={handleAzureAdSignOut}
                  className="mt-1 text-xs text-neutral-500 hover:text-neutral-800"
                >
                  {t('signOut')}
                </button>
              </div>
            ) : (
              <div className="px-1 text-[11px] text-red-600">{t('notAuthenticated')}</div>
            )}
          </div>
        )}
      </aside>

      <main className="flex-1 flex flex-col min-w-0 relative overflow-hidden">
        <div className="md:hidden min-h-11 px-3 pt-[env(safe-area-inset-top)] border-b border-neutral-200 bg-white flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowMobileNav(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-neutral-100"
            title={t('menu')}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0 text-sm font-semibold truncate">{t('appTitle')}</div>
          <button
            type="button"
            onClick={resetChat}
            disabled={isLoading}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('newChatShort')}
          </button>
        </div>
        {isLanding ? (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 flex flex-col items-center justify-center">
            <div className="w-full max-w-2xl min-w-0 flex flex-col items-center">
              <div className="text-center mb-6 sm:mb-8">
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-neutral-900">
                  {t('appTitle')}
                </h1>
                <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
                  {t('appSubtitle')}
                </p>
              </div>

              {!canChat && (
                <button
                  type="button"
                  onClick={() => setShowDocSetup(true)}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-neutral-800 hover:shadow-lg active:scale-[0.98]"
                >
                  <Settings2 className="h-4 w-4" />
                  {t('documentSetup')}
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
                        title={t('stopTitle')}
                      >
                        <Square className="h-3.5 w-3.5" />
                        {t('stop')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
              <div
                className="max-w-3xl mx-auto w-full min-w-0 px-3 sm:px-4 pt-4 space-y-4"
                style={{ paddingBottom: composerPad }}
              >
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
                          imageUrls: streamImageUrls,
                          answerTiming: streamAnswerTiming || undefined,
                          answerReasoningEffort: streamAnswerReasoningEffort || undefined,
                        }}
                        streaming
                        onOpenPdf={(url, title) => openPreview('pdf', url, title)}
                        onOpenImage={(url, alt) => openPreview('image', url, alt)}
                      />
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-500 text-sm pl-1">
                        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                        <span>{t('creatingAnswer')}</span>
                        {streamHolding && (
                          <span className="text-[11px] text-neutral-400">{t('assetLinkPreparing')}</span>
                        )}
                        {streamAnswerReasoningEffort && (
                          <span className="text-[11px] text-neutral-400 tabular-nums">
                            {formatReasoningEffortLabel(streamAnswerReasoningEffort, t)}
                          </span>
                        )}
                      </div>
                    )}
                    {streamedContent && streamHolding && (
                      <div className="text-[11px] text-neutral-400 pl-1 -mt-2">{t('assetLinkPreparing')}</div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-neutral-50 via-neutral-50/95 to-transparent pt-10 px-3 sm:px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <div ref={composerRef} className="pointer-events-auto max-w-3xl mx-auto min-w-0">
                {isLoading && (
                  <div className="mb-2 flex justify-center">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => abortRef.current?.abort()}
                      className="h-7 px-2 text-xs gap-1"
                      title={t('stopTitle')}
                    >
                      <Square className="h-3.5 w-3.5" />
                      {t('stop')}
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
            className="hidden md:block w-1.5 cursor-col-resize bg-transparent hover:bg-neutral-200/70 active:bg-neutral-300/70"
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
            title={t('dragToResize')}
          />
          <aside
            className="fixed inset-0 z-50 w-full max-w-[100vw] bg-white flex flex-col md:static md:inset-auto md:z-auto md:shrink-0 md:border-l md:border-neutral-200 md:w-[var(--panel-width)]"
            style={{ ['--panel-width' as string]: `${pdfPanelWidth}px` } as React.CSSProperties}
          >
            <div className="min-h-10 px-3 py-1.5 border-b border-neutral-200 flex items-center gap-1.5 flex-wrap">
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
                    title={t('zoomOut')}
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <div className="text-[11px] text-neutral-500 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.25) * 100) / 100))}
                    title={t('zoomIn')}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(1)} title={t('resetZoom')}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <button
                type="button"
                onClick={() => openPreviewInNewWindow(preview.url)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-neutral-100"
                title={t('openInNewWindow')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
              <Button variant="ghost" size="icon" onClick={() => setPreview(null)} title={t('close')} className="h-7 w-7">
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
  const { t } = useLocale();
  return (
    <div className="flex items-start gap-2 min-w-0">
      <div className="flex-1 min-w-0 text-[11px] leading-4 text-neutral-500 break-words" title={title}>
        <BookOpen className="h-3 w-3 mr-1 inline-block align-text-top text-neutral-400" />
        {parts.join(' · ')}
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className="shrink-0 inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50"
      >
        <Settings2 className="h-3 w-3" />
        {t('change')}
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
  chatMode,
  onChatModeChange,
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
  chatMode: 'thinking' | 'fast';
  onChatModeChange: (mode: 'thinking' | 'fast') => void;
}) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const { t } = useLocale();

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (modeMenuRef.current && target && !modeMenuRef.current.contains(target)) {
        setModeMenuOpen(false);
      }
    };
    const onKeyDownEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDownEsc);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDownEsc);
    };
  }, [modeMenuOpen]);

  const modeOptions: Array<{
    id: 'thinking' | 'fast';
    label: string;
    description: string;
  }> = [
    {
      id: 'thinking',
      label: t('modeThinking'),
      description: t('modeThinkingDesc'),
    },
    {
      id: 'fast',
      label: t('modeFast'),
      description: t('modeFastDesc'),
    },
  ];
  const activeMode = modeOptions.find((option) => option.id === chatMode) || modeOptions[0];

  return (
    <div className="border border-neutral-300 rounded-2xl bg-white shadow-sm px-3 pt-2.5 pb-2 transition-colors focus-within:border-neutral-500 focus-within:shadow-md min-w-0">
      <div className="flex items-start gap-1.5 min-w-0">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          title={t('sendHint')}
          disabled={isLoading}
          rows={1}
          className="flex-1 min-w-0 resize-none outline-none text-base sm:text-sm leading-6 min-h-[32px] max-h-40 bg-transparent py-1 disabled:text-neutral-400 disabled:cursor-not-allowed"
        />
        <div className="relative shrink-0 pt-0.5" ref={modeMenuRef}>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => setModeMenuOpen((open) => !open)}
            className="inline-flex h-8 items-center gap-0.5 px-1.5 text-[12px] font-medium text-neutral-600 hover:text-neutral-900 disabled:opacity-50"
            aria-haspopup="listbox"
            aria-expanded={modeMenuOpen}
            title={t('modeSelect')}
          >
            <span>{activeMode.label}</span>
            <ChevronDown className={`h-3.5 w-3.5 text-neutral-400 transition-transform ${modeMenuOpen ? 'rotate-180' : ''}`} />
          </button>
          {modeMenuOpen && (
            <div
              role="listbox"
              className="absolute top-full right-0 mt-1 w-60 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg z-30"
            >
              {modeOptions.map((option) => {
                const selected = option.id === chatMode;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChatModeChange(option.id);
                      setModeMenuOpen(false);
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-neutral-50 ${
                      selected ? 'bg-neutral-50' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-neutral-900">{option.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-neutral-500">{option.description}</span>
                    </span>
                    {selected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-neutral-900" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <Button
          onClick={onSend}
          disabled={isLoading || !value.trim()}
          size="icon"
          className="h-8 w-8 rounded-full shrink-0 mt-0.5"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <div className="mt-1.5 pt-1.5 border-t border-neutral-100">
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
  const { t } = useLocale();
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative w-full sm:max-w-6xl lg:max-w-7xl h-[var(--app-height,100dvh)] sm:h-auto sm:max-h-[min(88vh,var(--app-height,88vh))] bg-white sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="doc-setup-title"
      >
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-neutral-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="doc-setup-title" className="text-lg font-semibold tracking-tight">
              {t('documentSetup')}
            </h2>
            <p className="text-sm text-neutral-500 mt-0.5 break-words">
              {t('documentSetupHint')}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title={t('close')} className="shrink-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-neutral-100">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <div className="min-w-0 sm:flex-[1.4]">
              <label className="block text-xs font-medium text-neutral-600 mb-1">
                {t('modelLabel')} <span className="text-red-500">{t('required')}</span>
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                placeholder={t('modelPlaceholder')}
                className="w-full px-3 py-2 text-base sm:text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
              />
            </div>
            <div className="min-w-0 sm:flex-1">
              <label className="block text-xs font-medium text-neutral-600 mb-1">{t('serialLabel')}</label>
              <input
                type="text"
                value={serial}
                onChange={(e) => onSerialChange(e.target.value)}
                placeholder={t('serialPlaceholder')}
                className="w-full px-3 py-2 text-base sm:text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
              />
            </div>
            <div className="w-full sm:w-[148px] shrink-0">
              <label className="block text-xs font-medium text-neutral-600 mb-1">{t('documentLanguage')}</label>
              <select
                value={language}
                onChange={(e) => onLanguageChange(e.target.value)}
                className="w-full px-3 py-2 text-base sm:text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500 bg-white"
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
              className="w-full sm:w-auto shrink-0 gap-1.5"
            >
              {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {t('search')}
            </Button>
          </div>
          {searchError && (
            <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">
              {searchError}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-5 min-h-[160px]">
          {!hasSearched ? (
            <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center text-neutral-500">
              <Search className="h-8 w-8 text-neutral-300 mb-3" />
              <div className="text-sm font-medium text-neutral-600">{t('searchEmptyTitle')}</div>
              <div className="text-xs mt-1">{t('searchEmptyHint')}</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">{t('documentList')}</div>
                <div className="relative w-full sm:w-56">
                  <Search className="absolute left-2.5 top-2 h-4 w-4 text-neutral-400" />
                  <input
                    type="text"
                    placeholder={t('filterResults')}
                    value={docSearchQuery}
                    onChange={(e) => onDocSearchQueryChange(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-neutral-300 rounded-lg focus:outline-none focus:border-neutral-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-neutral-200">
                <div className="md:pr-5">
                  <DocumentSection
                    title={t('shopManual')}
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
                    title={t('ommManual')}
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

        <div className="px-4 sm:px-6 py-3 sm:py-4 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between gap-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="text-xs text-neutral-500 min-w-0 break-words">
            {selectedCount > 0 ? t('selectedCount', { count: selectedCount }) : t('selectOneEach')}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" onClick={onClose} className="px-3">
              {t('cancel')}
            </Button>
            <Button onClick={onClose} disabled={selectedCount === 0} className="px-3">
              {t('done')}
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
          <span className="flex items-start gap-1.5">
            <TruncatedWithTooltip
              text={label}
              className="block flex-1 min-w-0 font-medium line-clamp-2 break-words"
            />
            {meta && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 ${active ? 'bg-neutral-700 text-neutral-200' : 'bg-neutral-100 text-neutral-500'}`}>
                {meta}
              </span>
            )}
          </span>
          {sub && (
            <TruncatedWithTooltip
              text={sub}
              className={`block text-[11px] truncate ${active ? 'text-neutral-300' : 'text-neutral-500'}`}
            />
          )}
          {detail && (
            <TruncatedWithTooltip
              text={detail}
              className={`block text-[11px] truncate ${active ? 'text-neutral-400' : 'text-neutral-400'}`}
            />
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
  const { t } = useLocale();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-neutral-700">{title}</div>
        <div className="text-[11px] text-neutral-500">{t('countItems', { count })}</div>
      </div>
      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-500">
          {t('noDocuments')}
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
