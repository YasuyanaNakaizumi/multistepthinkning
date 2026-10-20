import { useMemo, useState } from 'react';
import { ThinkingStep } from '../types';
import { CheckCircle2, AlertCircle, Loader2, Circle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  formatReasoningEffortLabel,
  translateStepDescription,
  translateStepTitle,
  useLocale,
} from '../i18n';

export type LiveReasoningSummary = {
  active: boolean;
  /** null = encrypted-only / no summary text; string = visible summary (may be empty while streaming). */
  text: string | null;
};

export type ReasoningHistoryItem = {
  text: string | null;
  /** Insert after this index in the flat steps array (chronological). */
  afterStepIndex?: number;
};

interface ThinkingProcessProps {
  steps: ThinkingStep[];
  /** When true, panel is expanded by default and current step description is shown prominently. */
  live?: boolean;
  /** Completed / retained reasoning parts — shown solidly inside Thinking Process. */
  reasoningHistory?: ReasoningHistoryItem[];
  /** Current live reasoning part (also kept solidly in Process while active). */
  reasoningSummary?: LiveReasoningSummary;
  sources?: { key: string; label: string }[];
  activeSourceKey?: string;
  onSourceChange?: (key: string) => void;
}

type StepGroup =
  | { type: 'tool'; parent: ThinkingStep; children: ThinkingStep[]; key: string; startIndex: number; endIndex: number }
  | { type: 'solo'; step: ThinkingStep; key: string; startIndex: number; endIndex: number };

type TimelineEntry =
  | { type: 'group'; group: StepGroup; key: string }
  | { type: 'reasoning'; text: string | null; live?: boolean; key: string };

function isToolStep(step: ThinkingStep): boolean {
  return step.kind === 'tool' || /^Tool:\s*/i.test(step.title || '');
}

function isDetailStep(step: ThinkingStep): boolean {
  if (step.kind === 'detail') return true;
  const t = step.title || '';
  return (
    /^Loading TOC/i.test(t) ||
    /^Selecting TOC/i.test(t) ||
    /^Fetching chapter/i.test(t) ||
    t.includes('しおり') ||
    t.includes('章テキスト')
  );
}

/** Group flat steps: Tool parent + following detail rows as one card. */
function groupThinkingSteps(steps: ThinkingStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (isToolStep(step)) {
      const details: ThinkingStep[] = [];
      let j = i + 1;
      while (j < steps.length) {
        const next = steps[j];
        if (isToolStep(next)) break;
        if (next.kind === 'agent' || next.kind === 'answer') break;
        if (/^Agent thinking|^Agent answering|^Generating answer/i.test(next.title || '')) break;
        const sameGroup = Boolean(step.groupId && next.groupId === step.groupId);
        if (sameGroup || isDetailStep(next)) {
          details.push(next);
          j += 1;
          continue;
        }
        break;
      }
      groups.push({
        type: 'tool',
        parent: step,
        children: details,
        key: `tool-${i}`,
        startIndex: i,
        endIndex: j - 1,
      });
      i = j;
      continue;
    }
    groups.push({ type: 'solo', step, key: `solo-${i}`, startIndex: i, endIndex: i });
    i += 1;
  }
  return groups;
}

function StatusIcon({ status }: { status: ThinkingStep['status'] }) {
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === 'in_progress') return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
  if (status === 'error') return <AlertCircle className="h-4 w-4 text-red-500" />;
  return <Circle className="h-4 w-4 text-neutral-300" />;
}

function StepBody({
  step,
  locale,
  t,
  compact,
}: {
  step: ThinkingStep;
  locale: 'ja' | 'en';
  t: (key: any) => string;
  compact?: boolean;
}) {
  const description = translateStepDescription(step.description || '', locale);
  return (
    <div className="flex-1 min-w-0">
      <div
        className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${
          compact ? 'text-xs font-medium' : 'text-sm'
        } ${step.status === 'pending' ? 'text-neutral-400' : 'text-neutral-800'}`}
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
      {description && (
        <div
          className={`mt-1 break-words whitespace-pre-wrap leading-relaxed ${
            compact ? 'text-[11px] text-neutral-500' : 'text-xs text-neutral-600'
          }`}
        >
          {description}
        </div>
      )}
      {step.error && (
        <div className="text-xs text-red-600 mt-0.5 break-words">Error: {step.error}</div>
      )}
    </div>
  );
}

function ToolGroupCard({
  parent,
  details,
  locale,
  t,
  defaultOpen,
}: {
  parent: ThinkingStep;
  details: ThinkingStep[];
  locale: 'ja' | 'en';
  t: (key: any) => string;
  defaultOpen: boolean;
}) {
  const busy = parent.status === 'in_progress' || details.some((c) => c.status === 'in_progress');
  const [open, setOpen] = useState(defaultOpen || busy);
  const parentDescription = translateStepDescription(parent.description || '', locale);

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <StatusIcon status={busy ? 'in_progress' : parent.status} />
        </span>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="w-full flex items-start gap-2 text-left"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-800">
                {translateStepTitle(parent.title, locale)}
              </div>
              {parentDescription && (
                <div className="text-xs text-neutral-600 mt-0.5 break-words">{parentDescription}</div>
              )}
              {parent.error && (
                <div className="text-xs text-red-600 mt-0.5 break-words">Error: {parent.error}</div>
              )}
            </div>
            {details.length > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-neutral-400 shrink-0 mt-0.5">
                {t('thinkingSubsteps', { n: details.length })}
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </span>
            )}
          </button>

          {open && details.length > 0 && (
            <ol className="mt-2 ml-1 border-l-2 border-neutral-200 pl-3 space-y-2">
              {details.map((child, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">
                    <StatusIcon status={child.status} />
                  </span>
                  <StepBody step={child} locale={locale} t={t} compact />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </li>
  );
}

function ReasoningRow({
  text,
  live,
  t,
}: {
  text: string | null;
  live?: boolean;
  t: (key: any, params?: Record<string, string | number>) => string;
}) {
  return (
    <li className="px-3 py-2.5 bg-neutral-50">
      <div className="mb-1 text-[10px] font-semibold tracking-wide uppercase text-neutral-500">
        {t('reasoningSummary')}
      </div>
      <div
        className={`text-[13px] leading-relaxed whitespace-pre-wrap break-words text-neutral-700 ${
          live ? 'border-l-2 border-blue-300 pl-2' : ''
        }`}
      >
        {text === null ? (
          <span className="text-neutral-500">{t('reasoningEncryptedOnly')}</span>
        ) : (
          text || <span className="text-neutral-400">…</span>
        )}
      </div>
    </li>
  );
}

/**
 * Interleave reasoning after the step it was produced during (afterStepIndex),
 * instead of stacking everything at the bottom.
 */
function buildTimeline(
  groups: StepGroup[],
  stepCount: number,
  reasoningItems: Array<{ text: string | null; live?: boolean; afterStepIndex?: number }>
): TimelineEntry[] {
  const anchored = new Map<number, Array<{ text: string | null; live?: boolean; ord: number }>>();
  const unanchored: Array<{ text: string | null; live?: boolean; ord: number }> = [];

  reasoningItems.forEach((item, ord) => {
    if (typeof item.afterStepIndex === 'number' && item.afterStepIndex >= 0) {
      const idx = Math.min(item.afterStepIndex, Math.max(0, stepCount - 1));
      const list = anchored.get(idx) || [];
      list.push({ text: item.text, live: item.live, ord });
      anchored.set(idx, list);
    } else {
      unanchored.push({ text: item.text, live: item.live, ord });
    }
  });

  const entries: TimelineEntry[] = [];
  const emitted = new Set<number>();

  for (const g of groups) {
    entries.push({ type: 'group', group: g, key: g.key });
    for (let i = g.startIndex; i <= g.endIndex; i++) {
      const list = anchored.get(i);
      if (!list) continue;
      emitted.add(i);
      for (const r of list) {
        entries.push({
          type: 'reasoning',
          text: r.text,
          live: r.live,
          key: `reasoning-${r.ord}`,
        });
      }
    }
  }

  // Reasoning whose anchor step is not yet in any group (e.g. empty steps) — show at end.
  for (const [idx, list] of anchored) {
    if (emitted.has(idx)) continue;
    for (const r of list) {
      entries.push({
        type: 'reasoning',
        text: r.text,
        live: r.live,
        key: `reasoning-${r.ord}`,
      });
    }
  }

  for (const r of unanchored) {
    entries.push({
      type: 'reasoning',
      text: r.text,
      live: r.live,
      key: `reasoning-${r.ord}`,
    });
  }

  return entries;
}

export function ThinkingProcess({
  steps,
  live = false,
  reasoningHistory = [],
  reasoningSummary,
  sources = [],
  activeSourceKey,
  onSourceChange,
}: ThinkingProcessProps) {
  const [isOpen, setIsOpen] = useState(true);
  const { locale, t } = useLocale();

  const groups = useMemo(() => groupThinkingSteps(steps || []), [steps]);

  const processReasoningItems = useMemo(() => {
    // History is the source of truth (persists across steps). Mark last as live while streaming.
    const items: Array<{ text: string | null; live?: boolean; afterStepIndex?: number }> =
      reasoningHistory.map((r) => ({
        text: r.text,
        afterStepIndex: r.afterStepIndex,
      }));
    if (live && reasoningSummary?.active) {
      const last = items[items.length - 1];
      if (last && last.text === reasoningSummary.text) {
        last.live = true;
      } else if (!last || last.text !== reasoningSummary.text) {
        // Live part not yet mirrored in history — park after current last step.
        items.push({
          text: reasoningSummary.text,
          live: true,
          afterStepIndex: Math.max(0, (steps || []).length - 1),
        });
      }
    }
    return items;
  }, [reasoningHistory, reasoningSummary, live, steps]);

  const timeline = useMemo(
    () => buildTimeline(groups, (steps || []).length, processReasoningItems),
    [groups, steps, processReasoningItems]
  );

  if ((!steps || steps.length === 0) && processReasoningItems.length === 0) return null;

  const completed = (steps || []).filter((s) => s.status === 'completed').length;
  const errored = (steps || []).filter((s) => s.status === 'error').length;
  const current = (steps || []).find((s) => s.status === 'in_progress');

  const activeSourceLabel = sources.find((source) => source.key === activeSourceKey)?.label || '';

  const title = live
    ? current
      ? translateStepTitle(current.title, locale)
      : errored
      ? t('finishedWithErrors')
      : steps && completed === steps.length && steps.length > 0
      ? t('thinkingDone')
      : t('thinking')
    : t('thinkingProcess');

  const visibleTitle = activeSourceLabel ? `${title} · ${activeSourceLabel}` : title;
  const creatingAnswer = live && !current && !errored && !!steps?.length && completed === steps.length;
  const showReasoningBusy = Boolean(live && reasoningSummary?.active);

  return (
    <div className="border border-neutral-200 rounded-xl bg-white">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {live && (current || creatingAnswer || showReasoningBusy) ? (
          <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
        ) : errored ? (
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        )}
        <span className="flex-1 min-w-0 text-sm font-medium text-neutral-800 truncate">
          {visibleTitle}
        </span>
        <span className="text-[11px] text-neutral-400 tabular-nums shrink-0">
          {t('thinkingStages', { n: groups.length })}
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
          <div className="text-xs text-neutral-600 whitespace-pre-wrap break-words pl-6 max-h-28 overflow-y-auto">
            {translateStepDescription(current.description, locale)}
          </div>
        </div>
      )}

      {isOpen && timeline.length > 0 && (
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto">
          <ol className="border-t border-neutral-200 divide-y divide-neutral-100">
            {timeline.map((entry) =>
              entry.type === 'reasoning' ? (
                <ReasoningRow key={entry.key} text={entry.text} live={entry.live} t={t} />
              ) : entry.group.type === 'tool' ? (
                <ToolGroupCard
                  key={entry.key}
                  parent={entry.group.parent}
                  details={entry.group.children}
                  locale={locale}
                  t={t}
                  defaultOpen={live}
                />
              ) : (
                <li key={entry.key} className="px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0">
                      <StatusIcon status={entry.group.step.status} />
                    </span>
                    <StepBody step={entry.group.step} locale={locale} t={t} />
                  </div>
                </li>
              )
            )}
          </ol>
        </div>
      )}
    </div>
  );
}
