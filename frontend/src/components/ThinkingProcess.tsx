import { useState } from 'react';
import { ThinkingStep } from '../types';
import { CheckCircle2, AlertCircle, Loader2, Circle, ChevronDown, ChevronRight } from 'lucide-react';
import { formatReasoningEffortLabel, translateStepTitle, useLocale } from '../i18n';

interface ThinkingProcessProps {
  steps: ThinkingStep[];
  /** When true, panel is expanded by default and current step description is shown prominently. */
  live?: boolean;
  sources?: { key: string; label: string }[];
  activeSourceKey?: string;
  onSourceChange?: (key: string) => void;
}

export function ThinkingProcess({
  steps,
  live = false,
  sources = [],
  activeSourceKey,
  onSourceChange,
}: ThinkingProcessProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { locale, t } = useLocale();

  if (!steps || steps.length === 0) return null;

  const completed = steps.filter((s) => s.status === 'completed').length;
  const errored = steps.filter((s) => s.status === 'error').length;
  const current = steps.find((s) => s.status === 'in_progress');

  const activeSourceLabel = sources.find((source) => source.key === activeSourceKey)?.label || '';

  const title = live
    ? current
      ? translateStepTitle(current.title, locale)
      : errored
      ? t('finishedWithErrors')
      : completed === steps.length
      ? t('thinkingDone')
      : t('thinking')
    : t('thinkingProcess');

  const visibleTitle = activeSourceLabel ? `${title} · ${activeSourceLabel}` : title;
  const creatingAnswer = live && !current && !errored && completed === steps.length;

  return (
    <div className="border border-neutral-200 rounded-xl bg-white">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {live && (current || creatingAnswer) ? (
          <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
        ) : errored ? (
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        )}
        <span className="flex-1 min-w-0 text-sm font-medium text-neutral-800 truncate">
          {visibleTitle}
        </span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-neutral-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-neutral-400" />
        )}
      </button>

      {sources.length > 1 && onSourceChange && (
        <div className="px-3 pb-2 -mt-1 flex flex-wrap gap-2">
          {sources.map((source) => {
            const active = source.key === activeSourceKey;
            return (
              <button
                key={source.key}
                type="button"
                onClick={() => onSourceChange(source.key)}
                className={`rounded-full px-2.5 py-1 text-xs border transition-colors ${
                  active
                    ? 'bg-neutral-900 text-white border-neutral-900'
                    : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50'
                }`}
              >
                {source.label}
              </button>
            );
          })}
        </div>
      )}

      {live && current?.description && !isOpen && (
        <div className="px-3 pb-2 -mt-1">
          <div className="text-xs text-neutral-500 truncate pl-6">{current.description}</div>
        </div>
      )}

      {isOpen && (
        <ol className="border-t border-neutral-200 divide-y divide-neutral-100">
          {steps.map((step, i) => (
            <li key={i} className="px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {step.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                  {step.status === 'in_progress' && <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />}
                  {step.status === 'error' && <AlertCircle className="h-4 w-4 text-red-500" />}
                  {step.status === 'pending' && <Circle className="h-4 w-4 text-neutral-300" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${
                      step.status === 'pending' ? 'text-neutral-400' : 'text-neutral-800'
                    }`}
                  >
                    <span>{translateStepTitle(step.title, locale)}</span>
                    {step.reasoningEffort && (
                      <span
                        className={`text-[11px] font-normal tabular-nums ${
                          step.status === 'pending' ? 'text-neutral-300' : 'text-neutral-400'
                        }`}
                      >
                        {formatReasoningEffortLabel(step.reasoningEffort, t)}
                      </span>
                    )}
                  </div>
                  {step.description && (
                    <div className="text-xs text-neutral-500 mt-0.5 break-words whitespace-pre-wrap">{step.description}</div>
                  )}
                  {step.error && (
                    <div className="text-xs text-red-600 mt-0.5 break-words">Error: {step.error}</div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
