import { ChatMessage as ChatMessageType } from '../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ThinkingProcess } from './ThinkingProcess';
import { User, Bot, FileText } from 'lucide-react';
import { formatReasoningEffortLabel, useLocale } from '../i18n';

interface ChatMessageProps {
  message: ChatMessageType;
  /** Live stream: render trailing incomplete lines as plain text for cheaper updates. */
  streaming?: boolean;
  onOpenPdf?: (url: string, title?: string) => void;
  onOpenImage?: (url: string, alt?: string) => void;
}

export function ChatMessage({ message, streaming = false, onOpenPdf, onOpenImage }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const { t } = useLocale();

  const splitStreamingContent = (content: string) => {
    if (!streaming || !content) return { stable: content, trailing: '' };
    const lastBreak = Math.max(content.lastIndexOf('\n\n'), content.lastIndexOf('\n'));
    if (lastBreak < 0 || lastBreak > content.length - 12) {
      // Short / single block: keep markdown for the whole thing once it has some length
      if (content.length < 80) return { stable: '', trailing: content };
      return { stable: content, trailing: '' };
    }
    return {
      stable: content.slice(0, lastBreak + 1),
      trailing: content.slice(lastBreak + 1),
    };
  };

  const isPdfUrl = (href?: string) => {
    if (!href) return false;
    const clean = href.split('#')[0].split('?')[0].toLowerCase();
    return clean.endsWith('.pdf') || clean.includes('.pdf');
  };

  const resolveImageSrc = (src?: string) => {
    if (!src) return src;
    if (src.startsWith('http')) return src;
    const candidates = message.imageUrls || [];
    const decoded = decodeURIComponent(src);
    const basename = decoded.split('/').pop();
    const exact = candidates.find((u) => u.includes(decoded));
    if (exact) return exact;
    if (basename) {
      const byBase = candidates.find(
        (u) => decodeURIComponent(u).split('?')[0].split('/').pop() === basename
      );
      if (byBase) return byBase;
    }
    return src;
  };

  if (isUser) {
    return (
      <div className="flex justify-end min-w-0">
        <div className="max-w-[min(85%,100%)] flex gap-2 items-start min-w-0">
          <div className="rounded-2xl rounded-tr-sm bg-neutral-900 text-white px-4 py-2.5 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-w-full">
            {message.content}
          </div>
          <div className="hidden sm:flex h-7 w-7 rounded-full bg-neutral-200 text-neutral-600 items-center justify-center shrink-0">
            <User className="h-4 w-4" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 sm:gap-3 items-start min-w-0">
      <div className="hidden sm:flex h-7 w-7 rounded-full bg-neutral-900 text-white items-center justify-center shrink-0">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0 space-y-3">
        {message.thinkingSteps && message.thinkingSteps.length > 0 && (
          <ThinkingProcess steps={message.thinkingSteps} />
        )}

        {message.content && (() => {
          const { stable, trailing } = splitStreamingContent(message.content);
          const markdownBody = stable || (!trailing ? message.content : '');
          return (
          <div className="text-[14px] leading-6 text-neutral-800 break-words [overflow-wrap:anywhere]
            [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2
            [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2
            [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5
            [&_p]:my-2
            [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2
            [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2
            [&_li]:my-0.5
            [&_hr]:my-4
            [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-neutral-100 [&_code]:rounded [&_code]:text-[13px] [&_code]:break-all
            [&_pre]:bg-neutral-900 [&_pre]:text-neutral-50 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:max-w-full
            [&_blockquote]:border-l-4 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 [&_blockquote]:my-2
            [&_th]:bg-neutral-100 [&_th]:border [&_th]:border-neutral-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left
            [&_td]:border [&_td]:border-neutral-200 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top">
            {markdownBody ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ node, ...props }) => (
                  <div className="my-3 -mx-1 overflow-x-auto max-w-full">
                    <table {...props} className="w-full min-w-[480px] border border-neutral-200 text-sm" />
                  </div>
                ),
                a: ({ node, ...props }) => {
                  const href = typeof props.href === 'string' ? props.href : undefined;
                  const isPlaceholder =
                    !href ||
                    href === '#' ||
                    href.includes('localhost:3000#') ||
                    (!href.startsWith('http') && !href.startsWith('/'));
                  const linkClass =
                    'inline-flex items-center text-[11px] leading-tight font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 mx-0.5 no-underline hover:bg-blue-100';
                  if (isPlaceholder) {
                    return <span className={linkClass}>{props.children}</span>;
                  }
                  if (onOpenPdf && isPdfUrl(href)) {
                    return (
                      <a
                        {...props}
                        href={href}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const title = typeof props.children === 'string' ? props.children : undefined;
                          onOpenPdf(href!, title);
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const title = typeof props.children === 'string' ? props.children : undefined;
                          onOpenPdf(href!, title);
                        }}
                        className={linkClass}
                      />
                    );
                  }
                  return (
                    <a
                      {...props}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClass}
                    />
                  );
                },
                img: ({ node, ...props }) => {
                  const resolved = resolveImageSrc(props.src);
                  return (
                    <img
                      {...props}
                      src={resolved}
                      className="max-w-full h-auto rounded-lg border border-neutral-200 my-2 cursor-zoom-in"
                      alt={props.alt || 'Image'}
                      onClick={() => {
                        if (onOpenImage && resolved) {
                          onOpenImage(resolved, props.alt || 'Image');
                        }
                      }}
                    />
                  );
                },
              }}
            >
              {markdownBody}
            </ReactMarkdown>
            ) : null}
            {trailing ? (
              <div className="whitespace-pre-wrap break-words">
                {trailing}
                {streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-neutral-400 animate-pulse" />}
              </div>
            ) : (
              streaming && <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-neutral-400 animate-pulse" />
            )}
          </div>
          );
        })()}

        {message.pdfUrls && message.pdfUrls.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.pdfUrls.map((pdf, idx) => (
              <a
                key={idx}
                href={pdf.url}
                onPointerDown={(e) => {
                  if (onOpenPdf) {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenPdf(pdf.url, pdf.title);
                  }
                }}
                onClick={(e) => {
                  if (onOpenPdf) {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenPdf(pdf.url, pdf.title);
                  }
                }}
                target={onOpenPdf ? undefined : '_blank'}
                rel={onOpenPdf ? undefined : 'noopener noreferrer'}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-neutral-200 bg-white text-xs text-neutral-700 hover:bg-neutral-50 max-w-full"
                title={pdf.title}
              >
                <FileText className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
                <span className="truncate">{pdf.title}</span>
              </a>
            ))}
          </div>
        )}

        {(message.answerTiming || message.answerReasoningEffort) && (
          <div className="text-[11px] leading-4 text-neutral-400 tabular-nums flex flex-wrap items-center gap-y-0.5">
            {message.answerReasoningEffort && (
              <span>
                {t('answerModel')} · {formatReasoningEffortLabel(message.answerReasoningEffort, t)}
              </span>
            )}
            {message.answerTiming && (
              <>
                {message.answerReasoningEffort && <span className="mx-1.5 text-neutral-300">·</span>}
                <span>
                  {t('answerStart')} {formatLatency(message.answerTiming.firstTokenMs)}
                </span>
                {typeof message.answerTiming.completeMs === 'number' && (
                  <>
                    <span className="mx-1.5 text-neutral-300">·</span>
                    <span>
                      {t('answerComplete')} {formatLatency(message.answerTiming.completeMs)}
                    </span>
                  </>
                )}
                {typeof message.answerTiming.modelFirstTokenMs === 'number' && (
                  <>
                    <span className="mx-1.5 text-neutral-300">·</span>
                    <span>
                      {t('modelTtft')} {formatLatency(message.answerTiming.modelFirstTokenMs)}
                    </span>
                  </>
                )}
                {typeof message.answerTiming.holdDelayMs === 'number' && (
                  <>
                    <span className="mx-1.5 text-neutral-300">·</span>
                    <span>
                      {t('holdDelay')} {formatLatency(message.answerTiming.holdDelayMs)}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
