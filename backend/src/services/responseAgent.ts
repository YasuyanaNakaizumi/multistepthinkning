import { config } from '../config';
import { ThinkingStep, SelectedDocument, ChatMessage } from '../types';
import {
  AGENT_TOOL_DEFINITIONS,
  AgentAssetStore,
  AgentMode,
  AgentToolContext,
  executeAgentTool,
  summarizeToolArgs,
} from './agentTools';
import {
  CHAT_REASONING_EFFORT,
  FAST_REASONING_EFFORT,
  FINAL_ANSWER_REASONING_EFFORT,
  AgentReasoningEffort,
  createStreamingAssetRenderer,
  rewriteFinalAnswerArtifacts,
  logGptExchange,
  clipForLog,
  clipDeepForLog,
} from './openai';
import {
  createAzureConversation,
  isConversationMissingError,
  isConversationSurfaceNotFoundError,
  getConversationResponsesEndpoint,
} from './azureConversations';
import { upsertConversationIdRecord, getConversationIdRecord } from './conversationIdBlob';
import { createGptCallRecorder, GptCallRecorder } from './gptCallLog';

type ResponseInputItem = Record<string, unknown>;

export interface ResponseAgentHooks {
  onSteps?: (steps: ThinkingStep[]) => void;
  onToolStart?: (payload: { name: string; argsSummary: string; callId: string }) => void;
  onToolDone?: (payload: {
    name: string;
    callId: string;
    ok: boolean;
    summary: string;
  }) => void;
  onAgentStatus?: (status: 'thinking' | 'answering') => void;
  /** User-facing final_answer text only (phase === final_answer, or unphased message with no tools). */
  onChunk?: (text: string) => void;
  /**
   * Reasoning summary for Thinking Process UI.
   * active=false clears; active=true with text=null means encrypted-only (no summary).
   */
  onReasoningSummary?: (payload: { active: boolean; text: string | null }) => void;
  onModelFirstToken?: (msFromAnswerStart: number) => void;
  onHoldChange?: (holding: boolean) => void;
}

/** Reasoning options for Responses API (Fast=low / Thinking=medium). */
function buildReasoningConfig(effort: AgentReasoningEffort): Record<string, string> {
  if (effort === 'none') {
    return { effort: 'none' };
  }
  return {
    effort,
    summary: 'auto',
    context: 'all_turns',
  };
}

export interface ResponseAgentResult {
  answer: string;
  thinkingSteps: ThinkingStep[];
  imageUrls: string[];
  pdfUrls: Array<{ title: string; url: string }>;
  answerReasoningEffort: AgentReasoningEffort;
  tokenUsage: TokenUsage;
  /** Latest Azure Responses id (debug / fallback). Prefer conversationId for multi-turn. */
  responseId?: string;
  /** Azure Conversations API id — pass on the next user turn; tool turns are stored here. */
  conversationId?: string;
  /** True when the client aborted (Stop / disconnect). Conversation is left usable for follow-up. */
  aborted?: boolean;
  /** Local path of per-question GPT I/O JSON log (if written). */
  gptCallLogPath?: string | null;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
}

function extractTokenUsage(data: any): TokenUsage | null {
  const u = data?.usage || data?.response?.usage;
  if (!u || typeof u !== 'object') return null;
  const inputTokens = Number(u.input_tokens) || 0;
  const outputTokens = Number(u.output_tokens) || 0;
  const cachedInputTokens = Number(u.input_tokens_details?.cached_tokens) || 0;
  const totalTokens = Number(u.total_tokens) || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !cachedInputTokens) return null;
  return { inputTokens, outputTokens, cachedInputTokens, totalTokens };
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function extractResponseId(data: any): string | undefined {
  const id = data?.id || data?.response?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

function isPreviousResponseMissingError(error: unknown): boolean {
  const msg = String((error as Error)?.message || error || '').toLowerCase();
  return (
    msg.includes('previous_response') ||
    msg.includes('response_not_found') ||
    msg.includes('not found') ||
    msg.includes('expired')
  );
}

function requireNonEmpty(value: string, name: string): string {
  if (!value) throw new Error(`${name} is missing or empty`);
  return value;
}

/** Thrown when the client disconnects / presses Stop. */
export class AgentAbortedError extends Error {
  constructor(message = 'Agent aborted by client') {
    super(message);
    this.name = 'AgentAbortedError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof AgentAbortedError) return true;
  const name = String((error as Error)?.name || '');
  const msg = String((error as Error)?.message || error || '').toLowerCase();
  return name === 'AbortError' || msg.includes('aborted') || msg.includes('abort');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAbortedError();
}

function agentTiming(phase: string, startedAt: number, extra?: string): void {
  const ms = Math.max(0, Date.now() - startedAt);
  console.log(`[AgentTiming] ${phase}: ${ms}ms${extra ? ` | ${extra}` : ''}`);
}

function slimHistory(history: ChatMessage[]): ChatMessage[] {
  return (history || [])
    .slice(-4)
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }))
    .filter((m) => m.content);
}

/** Full answer template (Summary / Connector / Tools / Components). Shared by Fast and Thinking. */
function buildAnswerFormatRules(): string {
  return `Answer Creation Rules — apply the FULL template below when the user asks about an error/fault code or a procedure as a WHOLE.
For narrower questions, answer directly and skip unused sections (Related Connector / Required Tools / Related Component), but ALWAYS keep the opening Summary.

Answer Creation Rules (treat each fetched chapter as a Document Ref):
0. Language (CRITICAL / ABSOLUTE HIGHEST PRIORITY): Always write the entire answer in the same language as the user's question, regardless of the document language. This applies to the summary, headings, bullets, tables, connector labels, citations text around links, and all explanatory text. If the user's question mixes languages, follow the dominant language of the question. Do not switch to the document language unless the user explicitly asks for it. Never default to Japanese just because the documents are Japanese.
1. Summary (CRITICAL — ALWAYS): Begin EVERY answer with a 3-4 sentence summary that tells the user the overall conclusion, what to do first, and what kind of answer follows. Do not skip the summary for narrow questions.
2. Completeness: Reproduce every procedure step, numeric value (torque, clearance, part number), pass/fail criterion, and explicit condition found in the primary (MAIN) fetched chapters. Also reproduce connector facts from connector-list/layout chapters when connector information is required. Do not shorten or summarize them away. From supporting / referenced (SUB) chapters, include supporting procedures, specs, criteria, and explanations when they help answer the question; keep the amount proportional to need (key steps and values, not an unnecessary full dump of every SUB chapter).
3. Safety: Clearly mark warnings (▼) and cautions (!) at relevant steps.
4. No Hallucination: Do not write facts that are not explicitly in the tool results.
5. No Chapter Mixing: Do not mix procedures from different chapters into one step, and only insert images that belong to the SAME fetched chapter as the text you are describing.
5b. Roles of fetched chapters:
   - MAIN: Primary source for the answer body (procedures, specifications, explanations, images) — typically the failure-code / procedure chapter that answers the question.
   - SUB: Supporting / referenced chapters. You MAY and SHOULD write SUB content into the answer when it is needed to complete the procedure, explain a cross-reference, or supply specs the user needs. Prefer a concise, useful excerpt rather than pasting the entire SUB chapter. Cite the SUB chapter with its PDF token sparingly (see Citations). If a MAIN passage says "〜を参照" / "see ...", expand the needed SUB details in place (not link-only). Unused SUB refs that were not quoted may be listed briefly at the end under "Related documents" / "関連資料".
   - CONNECTOR: You MAY and SHOULD write connector information in the answer body (tables, pin counts, installation position, 3D layout images) using connector-list/layout chapters.
6. Structure: Choose natural headings that match the question and the fetched evidence.
7. Readability: Use Markdown tables for specification values, pin assignments, inspection steps with criteria, and parts lists with torque/clearance. Keep paragraphs short; prefer headings, bullets, and tables over walls of text.
8. Citations (SPARSE — do not over-cite):
   - Cite with [[PDF:shop-N]] using PDF_CITATION_TOKEN from the SAME fetched chapter. The backend inserts the real URL.
   - FORBIDDEN: writing any http(s) URL, SAS query string, or copying a long markdown link.
   - Do NOT place a PDF token after every bullet or every short paragraph. Prefer ONE citation per heading section (or per contiguous block from the same chapter), typically at the end of that section.
   - Add an extra citation only when the source chapter changes (e.g. MAIN → SUB cross-reference), or when a distinct procedure block clearly comes from a different Document Ref.
   - Do not stamp the enclosing error-code chapter onto content that is a cross-reference to another chapter — use that other chapter's token once for that block.
   - No links inside tables, except a "参照" / "参考" / "Reference" column. Never repeat the same [[PDF:shop-N]] many times in a row.
9. Cross-chapter References: When a MAIN step says "〜を参照", "refer to ...", "see ...", or names another chapter (e.g. CHECKS BEFORE TROUBLESHOOTING, CHECK ELECTRIC EQUIPMENT, RELATED INFORMATION FOR TROUBLESHOOTING), include the needed content from that fetched chapter at an appropriate length, and cite it once with that chapter's own [[PDF:shop-N]] token for that block. Do NOT replace it with the parent FAILURE CODE chapter token. Match by title (ignore punctuation / extra brackets). If it was not fetched, leave the chapter name as plain text.
10. Images — you MUST NOT write image URLs; the backend inserts them:
    - Insert an image by writing [[IMG:<file name>]] on its own line, using a file name that literally appears in image_explanation / available_images of the SAME fetched chapter.
    - FORBIDDEN: ![name.jpg](...), !name.jpg, or a bare name.jpg as a paragraph. Never invent a file name.
    - Place the token right after the sentence or step it illustrates; never collect images at the end.
    - Do not put tokens inside tables, and do not mention the file name in the prose.
11. Required Tools: Output a "## Required Tools" table at the end when the fetched chapters list tools or the question involves assembly, disassembly, maintenance, or diagnostics.

CONNECTOR SECTION (when fault diagnosis and connector IDs appear in the target MAIN chapter body):
   - Output "## Related Connector Information" just before "## Required Tools".
   - The table MUST have exactly these 5 columns, in this order, with this exact header. No extra, missing, renamed, reordered, merged, or translated columns:
| Connector No. | Connector Type | Number of pins | Installation position | Address |
|---|---|---|---|---|
   - Connector No. sources (CRITICAL):
     - ALLOWED: Connector numbers that appear in the MAIN diagnostic chapter body text only (the chapter "context" / contents field — prose, tables, and procedure steps in that text).
     - FORBIDDEN as a source of Connector No. (do NOT put these in the Related Connector table or elsewhere in the answer as connector IDs): numbers that appear only in images, image_explanation, Caption, OCR, 3D layout drawings / 立体配置図, cropped figures, or the full connector catalog. You may still insert layout [[IMG:]] after the table, but do not list connector IDs that are visible only in those images.
   - Connector-list / layout chapters may be used only to fill Type / pins / Installation position / Address for those body-text-mentioned IDs. Do NOT dump every catalog row.
   - One row per allowed connector. Unknown cells: "不明（提示された資料に記載なし）". If MAIN body text names no connector numbers, omit the table (do not invent rows).
   - Do NOT put links, citations, or images inside the table. IMMEDIATELY after the table, insert 3D layout diagram image(s) with [[IMG:<file name>]] tokens (one per line) from CONNECTOR chapter available_images / image_explanation when present (コネクタ立体配置図 / 立体配置図 / connector layout). A wiring/circuit diagram is NOT a valid substitute.

Related components: When fetched chapter bodies name related components / sensors / controllers, also output "## Related Component Information" after the connector section, listing each with location/mounting info. Cite the source PDF at most once for the section. Do not invent.`;
}

function buildSystemPrompt(mode: AgentMode, documentLabels: string[]): string {
  const docs = documentLabels.length ? documentLabels.join(', ') : '(selected manuals)';
  const modeBlock = mode === 'fast'
    ? `MODE: Fast
- Use tools when the current question needs manual evidence that is not already available.
- If a complete TOC is already available in this conversation (prior get_toc_bookmarks result still present), do NOT call get_toc_bookmarks again — call fetch_chapters_by_paths directly with exact paths from that TOC. Call get_toc_bookmarks only when no usable TOC is available yet (first turn or new manuals).
- Prefer focused paths. Do not seek additional material unless it is necessary and the mode allows it.
- tool_choice is auto; the host does not force a tool.`
    : `MODE: Thinking
- Use tools when the current question needs manual evidence that is not already available.
- If a complete TOC is already available in this conversation (prior get_toc_bookmarks result still present), do NOT call get_toc_bookmarks again — call fetch_chapters_by_paths directly with exact paths from that TOC. Call get_toc_bookmarks only when no usable TOC is available yet (first turn or new manuals).
- After EVERY first fetch, you MUST read the fetched chapter body text (context/contents) and decide whether a second fetch is required BEFORE writing the final answer. Do not answer yet if a second fetch is required.
- MUST call fetch_chapters_by_paths again (reuse the already-loaded TOC; pick new exact paths) when the fetched MAIN body text contains any of the following that are not already covered by fetched chapters:
  1) An explicit reference to another section/chapter/procedure (e.g. "〜を参照", "see ...", "refer to ...", related-information / checks / troubleshooting / procedure titles named in the body).
  2) Connector IDs / connector numbers needed for the answer, without connector list / layout / contact-identification chapters already fetched.
  3) Any other concrete missing evidence named by the body that is required to answer accurately (spec, check procedure, related fault target, measurement method).
- On the second fetch, pass only the newly needed exact paths. Prefer few focused paths. Do not re-fetch chapters you already have.
- If none of the above gaps exist, answer without a second fetch.
- At most TWO fetch_chapters_by_paths calls this turn.
- tool_choice is auto; the host does not force a tool. The host also does not scan chapter text for you — YOU must call the second fetch when the body text shows the gaps above.`;

  return `You are an assistant supporting a mechanical engineer.

Main instruction: Answer the user's question appropriately（ユーザーの質問に適切に回答すること）.
That is the primary goal. Decide whether tools are needed based on the evidence required for this question.

Selected manuals: ${docs}

Decision for retrieval:
- Retrieve when the current question cannot be answered accurately from the current conversation's relevant evidence, or when the user explicitly asks to look up/check the manual.
- Reuse prior evidence for clarification, summary, or a narrow fact when it directly covers the current question.
- A topic change usually requires new chapter evidence via fetch_chapters_by_paths, but do NOT re-call get_toc_bookmarks when a usable TOC is already in this conversation — reuse that TOC and fetch new paths.
- Do not retrieve if the user is only making a conversational remark that needs no manual facts.
- In Thinking mode, after the first fetch inside the same turn, a second fetch is required when the fetched body text itself points to missing sections or connectors (see MODE: Thinking). Do not skip that second fetch.
- Never use a brief mention, an unrelated chapter, or generic memory as a substitute for evidence.

Pipeline:
1) Call get_toc_bookmarks only when no usable TOC is already available in this conversation.
2) Call fetch_chapters_by_paths with exact relevant tree paths from the (prior or just-loaded) TOC.
3) Thinking only: if the fetched body text references another section or needs connector/layout evidence not yet fetched, call fetch_chapters_by_paths again with those exact new paths before answering.
4) You write the final answer from those results in the SAME turn/agent (no separate answer model or answer-only follow-up). When ready to reply to the user, emit the user-facing message as the final answer (phase final_answer), not commentary.

Conversation continuity: reuse relevant prior evidence and prior TOC when still available, but do not let a previous topic, template, or answer format determine the response to a new question.

${modeBlock}

${buildAnswerFormatRules()}`;
}

function shortToolResultSummary(name: string, result: unknown, ok: boolean, fallback: string): string {
  if (!ok) return fallback || 'Failed';
  if (name === 'get_toc_bookmarks') {
    const r = result as { tocEntryCount?: number } | null;
    return `Retrieved TOC list (${Number(r?.tocEntryCount || 0)} entries)`;
  }
  if (name === 'select_toc_bookmarks') {
    const r = result as { pathCount?: number; selectionMode?: string; tocEntryCount?: number } | null;
    const n = Number(r?.pathCount || 0);
    const mode = r?.selectionMode ? ` · ${r.selectionMode}` : '';
    if (r?.selectionMode === 'main_agent_pending') {
      return `Passed full TOC to main agent (${r.tocEntryCount || 0} entries)`;
    }
    return n > 0 ? `Selected ${n} bookmark(s)${mode}` : `Could not select bookmarks${mode}`;
  }
  if (name === 'fetch_chapters_by_paths') {
    const r = result as { chapterCount?: number; truncated?: boolean; followUp?: boolean } | null;
    const n = Number(r?.chapterCount || 0);
    const follow = r?.followUp ? ' · follow-up' : '';
    const trunc = r?.truncated ? ' · truncated' : '';
    return n > 0 ? `Fetched ${n} chapter(s)${follow}${trunc}` : `Could not fetch chapters${follow}`;
  }
  return fallback || 'Done';
}

function shortToolStartSummary(name: string, argsSummary: string): string {
  if (name === 'get_toc_bookmarks') {
    return argsSummary || 'Retrieving TOC list…';
  }
  if (name === 'select_toc_bookmarks') {
    const q = argsSummary
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('query:') || l.startsWith('focus:'));
    return q || 'Selecting bookmarks…';
  }
  if (name === 'fetch_chapters_by_paths') {
    const p = argsSummary
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('paths:'));
    return p || 'Fetching chapter text…';
  }
  return argsSummary || 'Running…';
}

function pushStep(steps: ThinkingStep[], step: ThinkingStep, onSteps?: (s: ThinkingStep[]) => void) {
  steps.push(step);
  onSteps?.(steps.slice());
}

function updateLastInProgress(
  steps: ThinkingStep[],
  patch: Partial<ThinkingStep>,
  onSteps?: (s: ThinkingStep[]) => void
) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status === 'in_progress') {
      steps[i] = { ...steps[i], ...patch, timestamp: new Date().toISOString() };
      onSteps?.(steps.slice());
      return;
    }
  }
}

function completeAllInProgress(
  steps: ThinkingStep[],
  patch: Partial<ThinkingStep>,
  onSteps?: (s: ThinkingStep[]) => void
) {
  let changed = false;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].status === 'in_progress') {
      steps[i] = {
        ...steps[i],
        ...patch,
        status: 'completed',
        timestamp: new Date().toISOString(),
      };
      changed = true;
    }
  }
  if (changed) onSteps?.(steps.slice());
}

function extractFunctionCalls(data: any): Array<{ callId: string; name: string; arguments: string }> {
  const output = Array.isArray(data?.output) ? data.output : [];
  const calls: Array<{ callId: string; name: string; arguments: string }> = [];
  for (const item of output) {
    const type = String(item?.type || '');
    if (type === 'function_call' || type === 'tool_call') {
      calls.push({
        callId: String(item.call_id || item.id || ''),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
      });
    }
  }
  return calls.filter((c) => c.callId && c.name);
}

function extractDeltaText(evt: any): string {
  if (typeof evt?.delta === 'string') return evt.delta;
  if (typeof evt?.delta?.text === 'string') return evt.delta.text;
  if (Array.isArray(evt?.delta?.content)) {
    return evt.delta.content.map((c: any) => c?.text || '').join('');
  }
  if (typeof evt?.choices?.[0]?.delta?.content === 'string') {
    return evt.choices[0].delta.content;
  }
  return '';
}

async function createResponses(
  body: Record<string, unknown>,
  logLabel = 'agent.responses',
  endpointOverride?: string | null,
  signal?: AbortSignal,
  gptLog?: GptCallRecorder | null
): Promise<any> {
  throwIfAborted(signal);
  const url = requireNonEmpty(
    endpointOverride || config.azureOpenAI.endpoint,
    endpointOverride ? 'Conversation Responses endpoint' : 'AZURE_OPENAI_ENDPOINT'
  );
  const apiKey = requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY');
  if (endpointOverride) {
    console.log(`[GPT]   endpoint override (${logLabel}): ${url}`);
  }
  logGptExchange(logLabel, body);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw new AgentAbortedError();
    throw error;
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Responses API error: ${resp.status} ${resp.statusText} ${txt}`);
  }
  const data: any = await resp.json();
  const calls = extractFunctionCalls(data);
  const outputText =
    data?.output_text ||
    (Array.isArray(data?.output)
      ? data.output
          .map((item: any) => {
            if (item?.type === 'message') {
              return (item.content || []).map((c: any) => c?.text || '').join('');
            }
            if (item?.type === 'function_call' || item?.type === 'tool_call') {
              return `tool:${item.name}(${typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})})`;
            }
            return '';
          })
          .filter(Boolean)
          .join(' | ')
      : '');
  // Console stays compact; JSON file log stores the raw Responses body (clipped).
  console.log(
    `[GPT]   response (${logLabel}): ${JSON.stringify(
      clipDeepForLog({
        id: data?.id,
        status: data?.status,
        calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
        output_text: outputText,
        usage: data?.usage || null,
      })
    )}`
  );
  gptLog?.record(logLabel, body, data);
  return data;
}

type StreamItemMeta = {
  type: string;
  phase?: string | null;
  callId?: string;
  name?: string;
  arguments: string;
};

type StreamTurnHooks = {
  onFinalAnswerDelta?: (text: string) => void;
  onReasoningSummary?: (payload: { active: boolean; text: string | null }) => void;
  onModelFirstToken?: (ms: number) => void;
};

type StreamTurnResult = {
  text: string;
  functionCalls: Array<{ callId: string; name: string; arguments: string }>;
  usage: TokenUsage | null;
  responseId?: string;
};

function itemKey(evt: any, item?: any): string {
  const id = String(evt?.item_id || item?.id || '').trim();
  if (id) return id;
  if (typeof evt?.output_index === 'number') return `idx:${evt.output_index}`;
  if (typeof item?.output_index === 'number') return `idx:${item.output_index}`;
  return '';
}

function summaryTextFromReasoningItem(item: any): string {
  const parts = Array.isArray(item?.summary) ? item.summary : [];
  return parts
    .map((p: any) => (p?.type === 'summary_text' || !p?.type ? String(p?.text || '') : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Stream one Responses turn.
 * - reasoning_summary_* → live overwriteable summary (UI)
 * - output_text with phase final_answer → user answer
 * - commentary phase → suppressed from answer channel
 * - unphased message text → emitted only if the turn has no function calls
 */
async function streamResponsesTurn(
  body: Record<string, unknown>,
  turnHooks: StreamTurnHooks,
  logLabel = 'agent.stream',
  endpointOverride?: string | null,
  signal?: AbortSignal,
  gptLog?: GptCallRecorder | null
): Promise<StreamTurnResult> {
  throwIfAborted(signal);
  const url = requireNonEmpty(
    endpointOverride || config.azureOpenAI.endpoint,
    endpointOverride ? 'Conversation Responses endpoint' : 'AZURE_OPENAI_ENDPOINT'
  );
  const apiKey = requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY');
  const startedAt = Date.now();
  let firstReported = false;
  logGptExchange(logLabel, { ...body, stream: true });

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw new AgentAbortedError();
    throw error;
  }
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Responses stream error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: TokenUsage | null = null;
  let responseId: string | undefined;
  let completedOutput: any[] | null = null;
  /** Raw Responses API object from response.completed / incomplete (for vendor logs). */
  let completedResponse: any = null;

  const items = new Map<string, StreamItemMeta>();
  const bufferedDeltas = new Map<string, string>();
  const streamedFinalByKey = new Set<string>();
  let finalText = '';
  let currentSummary = '';
  let currentSummaryIndex: number | null = null;
  const reasoningDeltaKeys = new Set<string>();
  let answerStarted = false;

  const reportFirst = () => {
    if (!firstReported) {
      firstReported = true;
      turnHooks.onModelFirstToken?.(Math.max(0, Date.now() - startedAt));
    }
  };

  const clearReasoningUi = () => {
    currentSummary = '';
    currentSummaryIndex = null;
    turnHooks.onReasoningSummary?.({ active: false, text: null });
  };

  const emitReasoningUi = (text: string | null) => {
    turnHooks.onReasoningSummary?.({ active: true, text });
  };

  const emitFinalDelta = (delta: string) => {
    if (!delta) return;
    if (!answerStarted) {
      answerStarted = true;
      clearReasoningUi();
    }
    reportFirst();
    finalText += delta;
    turnHooks.onFinalAnswerDelta?.(delta);
  };

  const routeMessageDelta = (key: string, delta: string) => {
    if (!delta) return;
    const meta = items.get(key);
    const phase = meta?.phase;
    if (phase === 'commentary') {
      return;
    }
    if (phase === 'final_answer') {
      streamedFinalByKey.add(key);
      emitFinalDelta(delta);
      return;
    }
    // Phase not known yet — buffer until output_item.added / done (or end of turn).
    if (phase == null || phase === '') {
      bufferedDeltas.set(key, (bufferedDeltas.get(key) || '') + delta);
    }
  };

  const flushBuffered = (key: string) => {
    const pending = bufferedDeltas.get(key);
    if (!pending) return;
    bufferedDeltas.delete(key);
    const meta = items.get(key);
    if (meta?.phase === 'final_answer') {
      // Avoid double-count in unphasedText: peel from end if needed is hard; track separately.
      emitFinalDelta(pending);
    }
    // commentary / unknown: drop from answer channel
  };

  const upsertItem = (key: string, patch: Partial<StreamItemMeta> & { type?: string }) => {
    if (!key) return;
    const prev = items.get(key) || { type: patch.type || 'unknown', arguments: '' };
    items.set(key, {
      ...prev,
      ...patch,
      type: patch.type || prev.type,
      arguments: patch.arguments !== undefined ? patch.arguments : prev.arguments,
    });
  };

  const handleEvent = (evt: any) => {
    const type = String(evt?.type || '');
    const maybeId = extractResponseId(evt) || extractResponseId(evt?.response);
    if (maybeId) responseId = maybeId;
    const maybeUsage = extractTokenUsage(evt) || extractTokenUsage(evt?.response);
    if (maybeUsage) usage = maybeUsage;

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (evt?.response && typeof evt.response === 'object') {
        completedResponse = evt.response;
      }
      const out = evt?.response?.output;
      if (Array.isArray(out)) completedOutput = out;
      return;
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = evt?.item;
      const key = itemKey(evt, item);
      const itemType = String(item?.type || '');
      if (itemType === 'message') {
        upsertItem(key, {
          type: 'message',
          phase: item?.phase ?? null,
        });
        if (type === 'response.output_item.added') {
          flushBuffered(key);
        }
        if (type === 'response.output_item.done' && item?.phase === 'final_answer') {
          // Azure may deliver full text only on done; if we never got deltas, take content.
          if (!streamedFinalByKey.has(key)) {
            const text = Array.isArray(item?.content)
              ? item.content.map((c: any) => c?.text || '').join('')
              : '';
            if (text) emitFinalDelta(text);
          }
        }
      } else if (itemType === 'function_call' || itemType === 'tool_call') {
        upsertItem(key, {
          type: itemType,
          callId: String(item?.call_id || item?.id || ''),
          name: String(item?.name || ''),
          arguments:
            typeof item?.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item?.arguments || {}),
        });
      } else if (itemType === 'reasoning') {
        upsertItem(key, { type: 'reasoning' });
        if (type === 'response.output_item.added') {
          // Show reasoning slot immediately (may be encrypted-only until summary arrives).
          emitReasoningUi(currentSummary || null);
        }
        if (type === 'response.output_item.done' && !reasoningDeltaKeys.has(key)) {
          // Azure often ships full summary only on done (no incremental deltas).
          const text = summaryTextFromReasoningItem(item);
          currentSummary = text;
          emitReasoningUi(text || null);
        }
      }
      return;
    }

    if (type === 'response.reasoning_summary_part.added') {
      const idx = typeof evt?.summary_index === 'number' ? evt.summary_index : 0;
      // New summary part → overwrite UI (common ChatGPT-style behavior).
      currentSummaryIndex = idx;
      currentSummary = '';
      emitReasoningUi('');
      return;
    }

    if (type === 'response.reasoning_summary_text.delta') {
      const key = itemKey(evt);
      if (key) reasoningDeltaKeys.add(key);
      const idx = typeof evt?.summary_index === 'number' ? evt.summary_index : currentSummaryIndex;
      if (idx !== currentSummaryIndex) {
        currentSummaryIndex = idx ?? 0;
        currentSummary = '';
      }
      const delta = typeof evt?.delta === 'string' ? evt.delta : extractDeltaText(evt);
      if (!delta) return;
      currentSummary += delta;
      emitReasoningUi(currentSummary);
      return;
    }

    if (type === 'response.reasoning_summary_text.done') {
      const key = itemKey(evt);
      if (key) reasoningDeltaKeys.add(key);
      const text = typeof evt?.text === 'string' ? evt.text : '';
      if (text) {
        currentSummary = text;
        emitReasoningUi(text);
      } else if (!currentSummary) {
        emitReasoningUi(null);
      }
      return;
    }

    if (type === 'response.function_call_arguments.delta') {
      const key = itemKey(evt);
      const delta = typeof evt?.delta === 'string' ? evt.delta : '';
      if (key && delta) {
        const prev = items.get(key);
        upsertItem(key, {
          type: prev?.type || 'function_call',
          arguments: (prev?.arguments || '') + delta,
          callId: prev?.callId,
          name: prev?.name,
        });
      }
      return;
    }

    if (type === 'response.function_call_arguments.done') {
      const key = itemKey(evt);
      if (key && typeof evt?.arguments === 'string') {
        const prev = items.get(key);
        upsertItem(key, {
          type: prev?.type || 'function_call',
          arguments: evt.arguments,
          callId: prev?.callId || String(evt?.call_id || ''),
          name: prev?.name || String(evt?.name || ''),
        });
      }
      return;
    }

    if (
      type === 'response.output_text.delta' ||
      type === 'response.content_part.delta' ||
      type === 'response.text.delta'
    ) {
      const key = itemKey(evt);
      const delta = extractDeltaText(evt);
      if (key) routeMessageDelta(key, delta);
      else if (delta) {
        // No item id — buffer until we know whether this turn has tools.
        bufferedDeltas.set('_unkeyed', (bufferedDeltas.get('_unkeyed') || '') + delta);
      }
      return;
    }
  };

  try {
    while (true) {
      throwIfAborted(signal);
      let readResult: { done: boolean; value?: Uint8Array };
      try {
        readResult = await reader.read();
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw new AgentAbortedError();
        throw error;
      }
      const { done, value } = readResult;
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch (error) {
          if (error instanceof AgentAbortedError) throw error;
          // ignore non-JSON
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // Collect function calls from tracked items + completed output.
  const callMap = new Map<string, { callId: string; name: string; arguments: string }>();
  for (const meta of items.values()) {
    if (meta.type !== 'function_call' && meta.type !== 'tool_call') continue;
    if (!meta.callId || !meta.name) continue;
    callMap.set(meta.callId, {
      callId: meta.callId,
      name: meta.name,
      arguments: meta.arguments || '{}',
    });
  }
  if (completedOutput) {
    for (const c of extractFunctionCalls({ output: completedOutput })) {
      callMap.set(c.callId, c);
    }
  }
  const functionCalls = [...callMap.values()];

  // Unphased / buffered text: only promote to final answer when this turn has no tools
  // and we never streamed an explicit final_answer (models that omit phase).
  if (!functionCalls.length && !finalText) {
    let leftover = bufferedDeltas.get('_unkeyed') || '';
    for (const [key, text] of bufferedDeltas) {
      if (key === '_unkeyed') continue;
      const phase = items.get(key)?.phase;
      if (phase === 'commentary') continue;
      leftover += text;
    }
    if (leftover) emitFinalDelta(leftover);
  }

  // Prefer streamed summary for UI; fall back to completed output items.
  let reasoningSummary = currentSummary.trim();
  if (!reasoningSummary && completedOutput) {
    for (const item of completedOutput) {
      if (String(item?.type || '') !== 'reasoning') continue;
      const text = summaryTextFromReasoningItem(item);
      if (text) {
        reasoningSummary = text;
        break;
      }
    }
  }
  const hadReasoningItem =
    [...items.values()].some((m) => m.type === 'reasoning') ||
    (Array.isArray(completedOutput) &&
      completedOutput.some((item) => String(item?.type || '') === 'reasoning'));

  // Log the vendor-facing raw Responses object (long strings clipped in gptCallLog).
  const rawForLog =
    completedResponse ??
    (completedOutput
      ? {
          id: responseId,
          status: 'unknown',
          output: completedOutput,
          usage,
          _note: 'reconstructed: stream ended without response.completed payload',
        }
      : {
          id: responseId,
          status: 'unknown',
          usage,
          _note: 'stream ended without response.completed / output',
        });

  console.log(
    `[GPT]   response (${logLabel}): calls=${functionCalls.length} finalChars=${finalText.length} reasoning=${reasoningSummary ? `${reasoningSummary.length}chars` : hadReasoningItem ? 'encrypted-only' : 'none'} ${clipForLog(finalText)}`
  );
  gptLog?.record(logLabel, { ...body, stream: true }, rawForLog);
  return { text: finalText, functionCalls, usage, responseId };
}

function buildLookupFromAssetStore(store: AgentAssetStore) {
  const imageByTitle = new Map<string, string>();
  const imageUrlToBasename = new Map<string, string>();
  const pdfByTitle = new Map<string, string>();
  const pdfLinkTitles: Array<{ label: string; url: string }> = [];
  const pdfByRefId = new Map<string, string>();

  for (const [fileName, url] of store.imageSasUrlMap) {
    imageByTitle.set(fileName.toLowerCase(), url);
    imageUrlToBasename.set(url, fileName);
  }
  for (const [refId, markdown] of store.refLinkMap) {
    pdfByRefId.set(refId.toLowerCase(), markdown);
    const parsed = markdown.match(/^\[([^\]]+)\]\(<([^>]+)>\)$/) || markdown.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (parsed) {
      const title = parsed[1].trim();
      const url = parsed[2].trim();
      pdfByTitle.set(title.toLowerCase(), url);
      pdfLinkTitles.push({ label: title, url });
    }
  }
  return { imageByTitle, imageUrlToBasename, pdfByTitle, pdfLinkTitles, pdfByRefId };
}

export async function runResponseAgent(options: {
  query: string;
  mode: AgentMode;
  selectedDocuments: SelectedDocument[];
  selectedDocumentNumbers: string[];
  chatHistory: ChatMessage[];
  /** Azure Conversations API id from the previous user turn. */
  conversationId?: string;
  /** Client chat session id — used to persist conversationId JSON in Blob. */
  chatSessionId?: string;
  /** Logged-in user email for Blob path. */
  userEmail?: string;
  /** Fallback when Conversations API is unavailable. */
  previousResponseId?: string;
  /** Abort when the client presses Stop / disconnects SSE. */
  signal?: AbortSignal;
  hooks?: ResponseAgentHooks;
}): Promise<ResponseAgentResult> {
  const mode = options.mode;
  const signal = options.signal;
  const gptLog = createGptCallRecorder({
    query: options.query,
    mode,
    chatSessionId: options.chatSessionId,
    conversationId: options.conversationId,
  });
  const toolEffort = mode === 'fast' ? FAST_REASONING_EFFORT : FINAL_ANSWER_REASONING_EFFORT; // Fast=low, Thinking=medium
  const answerEffort = toolEffort;
  // Fast: select + fetch. Thinking: up to (select+fetch)×2 plus review rounds.
  const maxRounds = mode === 'fast' ? 3 : 6;
  const agentStartedAt = Date.now();
  const assetStore = new AgentAssetStore();
  const steps: ThinkingStep[] = [];
  const hooks = options.hooks || {};
  let activeToolGroupId: string | undefined;

  const toolCtx: AgentToolContext = {
    mode,
    selectedDocuments: options.selectedDocuments,
    selectedDocumentNumbers: options.selectedDocumentNumbers,
    chatHistory: slimHistory(options.chatHistory),
    currentQuery: options.query,
    assetStore,
    chapterCap: mode === 'fast' ? 12 : 16,
    contentCharCap: mode === 'fast' ? 6000 : 20000,
    fetchedChapterRefs: [],
    signal,
    onProgress: (event) => {
      const status = event.status || 'in_progress';
      const isToolTitle = (title: string) => String(title || '').startsWith('Tool:');
      const groupId = activeToolGroupId;

      if (status === 'in_progress') {
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].status !== 'in_progress') continue;
          if (isToolTitle(steps[i].title) || steps[i].kind === 'tool') continue;
          steps[i] = {
            ...steps[i],
            status: 'completed',
            timestamp: new Date().toISOString(),
          };
          hooks.onSteps?.(steps.slice());
          break;
        }
        pushStep(
          steps,
          {
            title: event.title,
            description: event.description,
            status: 'in_progress',
            timestamp: new Date().toISOString(),
            reasoningEffort: event.reasoningEffort,
            kind: 'detail',
            groupId,
          },
          hooks.onSteps
        );
        return;
      }

      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].status !== 'in_progress') continue;
        if (isToolTitle(steps[i].title) || steps[i].kind === 'tool') continue;
        steps[i] = {
          ...steps[i],
          status,
          description: event.description,
          error: status === 'error' ? event.description : undefined,
          reasoningEffort: event.reasoningEffort || steps[i].reasoningEffort,
          kind: steps[i].kind || 'detail',
          groupId: steps[i].groupId || groupId,
          timestamp: new Date().toISOString(),
        };
        hooks.onSteps?.(steps.slice());
        return;
      }
    },
  };

  const documentLabels = options.selectedDocuments.length
    ? options.selectedDocuments.map((d) => `${d.documentNumber} (${d.documentTitle || d.documentType})`)
    : options.selectedDocumentNumbers;

  const model = requireNonEmpty(config.azureOpenAI.deployment, 'AZURE_OPENAI_DEPLOYMENT_NAME');
  const history = slimHistory(options.chatHistory);

  /** Foundry /openai/v1 Responses requires explicit type: "message" on input items. */
  const messageItem = (role: string, text: string): ResponseInputItem => ({
    type: 'message',
    role,
    content: [{ type: 'input_text', text }],
  });

  const buildFreshInput = (): ResponseInputItem[] => [
    messageItem('system', buildSystemPrompt(mode, documentLabels)),
    ...history.map((m) => messageItem(m.role, m.content)),
    messageItem('user', options.query),
  ];

  const buildContinueInput = (): ResponseInputItem[] => [
    messageItem(
      'user',
      [
        'Follow-up in the same Conversation (Conversations API + Responses).',
        `Selected manuals: ${documentLabels.length ? documentLabels.join(', ') : '(selected manuals)'}.`,
        `Mode: ${mode}.`,
        'Main instruction: Handle the user\'s request appropriately（ユーザーの要望に適切に対処しなさい）.',
        'Use prior tool results when they directly answer the current question. Do not let the previous topic or answer format determine this answer.',
        'If current evidence is insufficient or the user asks to check the manual: call fetch_chapters_by_paths with exact paths. If a complete TOC from a prior get_toc_bookmarks is still available in this conversation, reuse it and do NOT call get_toc_bookmarks again. Call get_toc_bookmarks only when no usable TOC is present (first turn or new manuals).',
        'A topic change often needs new chapter evidence, but reuse the existing TOC when available. Do not retrieve for a conversational remark that needs no manual facts.',
        'After a fetch in Thinking mode, you MUST inspect the fetched chapter body text. If it names another section/chapter to refer to, or contains connector IDs without connector list/layout already fetched, call fetch_chapters_by_paths again with those exact paths before answering. Do not answer from memory for those gaps.',
        'Do not use a brief mention, unrelated chapter, or generic memory as a substitute for evidence. Decide based on whether new chapter text materially improves accuracy. tool_choice is auto; the host does not force tools.',
        mode === 'thinking'
          ? 'Mandatory second-fetch triggers after the first fetch: unresolved 「〜を参照」/see/refer-to section titles in body text; connector numbers in body without connector chapters yet; other body-named missing evidence needed for an accurate answer. Otherwise answer directly.'
          : 'Fast: reuse prior TOC when available, otherwise get TOC once, then one focused fetch and answer.',
        'You MAY reuse [[PDF:shop-N]] / [[IMG:]] tokens from earlier turns — the host keeps the citation map.',
        'When retrieving, use the current question and a focused query. Do not repeat prior-topic chapters unless the current question needs them.',
        'When you retrieve new chapters, prefer their PDF_CITATION_TOKEN values. Answer from the available evidence at the detail level requested; do not assume the user has already seen the relevant steps.',
        '',
        options.query,
      ].join('\n')
    ),
  ];

  // Conversations API + Responses: create/reuse conversation and record tool turns.
  // Fall back to previous_response_id if Conversations is unavailable.
  let conversationId = String(options.conversationId || '').trim() || undefined;
  let conversationJustCreated = false;
  let conversationApiAvailable = true;
  let conversationResponsesEndpoint: string | null = null;
  let tokenUsage = emptyTokenUsage();
  let previousResponseId = String(options.previousResponseId || '').trim() || undefined;
  let assetsHydrated = false;

  // Always try Blob first: restore conversation id AND prior PDF/image citation maps.
  if (options.chatSessionId) {
    const stored = await getConversationIdRecord({
      userEmail: options.userEmail,
      chatSessionId: options.chatSessionId,
    }).catch(() => null);
    if (stored?.status === 'active') {
      if (
        !conversationId &&
        stored.conversationId &&
        !stored.conversationId.startsWith('resp-chain:')
      ) {
        conversationId = stored.conversationId;
        conversationResponsesEndpoint = getConversationResponsesEndpoint();
        console.log(
          `[Conversation] restored from Blob session=${options.chatSessionId} id=${conversationId}`
        );
      } else if (!conversationId && stored?.lastResponseId && !previousResponseId) {
        previousResponseId = stored.lastResponseId;
        console.log(
          `[Conversation] restored previous_response_id from Blob session=${options.chatSessionId}`
        );
      }

      if ((stored.pdfRefs?.length || stored.imageRefs?.length) && !assetsHydrated) {
        await assetStore.hydratePersisted({
          pdfRefs: stored.pdfRefs,
          imageRefs: stored.imageRefs,
        });
        assetsHydrated = true;
        console.log(
          `[Conversation] hydrated assets pdf=${stored.pdfRefs?.length || 0} images=${stored.imageRefs?.length || 0} nextRef≈shop-${assetStore.refLinkMap.size ? 'continued' : '1'}`
        );
      }
    }
  }

  if (!conversationId) {
    try {
      const created = await createAzureConversation({
        metadata: {
          chatSessionId: String(options.chatSessionId || '').slice(0, 64),
          mode,
        },
      });
      conversationId = created.id;
      conversationJustCreated = true;
      conversationResponsesEndpoint = getConversationResponsesEndpoint();
    } catch (error) {
      conversationApiAvailable = false;
      console.warn(
        `[Conversation] create unavailable — falling back to previous_response_id. ${(error as Error).message}`
      );
    }
  } else if (!conversationResponsesEndpoint) {
    conversationResponsesEndpoint = getConversationResponsesEndpoint();
  }

  const persistConversationBlob = async (extra?: { lastResponseId?: string }) => {
    if (!options.chatSessionId) return;
    const idForBlob =
      conversationId ||
      (extra?.lastResponseId ? `resp-chain:${extra.lastResponseId}` : undefined);
    if (!idForBlob) return;
    const persisted = assetStore.exportPersisted();
    await upsertConversationIdRecord({
      userEmail: options.userEmail,
      chatSessionId: options.chatSessionId,
      conversationId: idForBlob,
      lastResponseId: extra?.lastResponseId,
      lastTotalTokens: tokenUsage.totalTokens || undefined,
      pdfRefs: persisted.pdfRefs,
      imageRefs: persisted.imageRefs,
    }).catch((err) => {
      console.warn('[ConversationBlob] upsert failed:', (err as Error).message);
    });
  };

  if (conversationJustCreated) {
    await persistConversationBlob();
  }
  gptLog.setConversationId(conversationId);

  const startedWithContinuation = Boolean(
    (conversationId && !conversationJustCreated) || (!conversationId && previousResponseId)
  );
  let pendingInput: ResponseInputItem[] = startedWithContinuation
    ? buildContinueInput()
    : buildFreshInput();

  if (startedWithContinuation) {
    pushStep(
      steps,
      {
        title: 'Agent thinking',
        description: conversationId
          ? `Continuing conversation (Conversation ${conversationId})`
          : `Continuing conversation (previous_response_id)`,
        status: 'completed',
        timestamp: new Date().toISOString(),
        reasoningEffort: toolEffort,
        kind: 'agent',
      },
      hooks.onSteps
    );
  } else {
    pushStep(
      steps,
      {
        title: 'Agent thinking',
        description: conversationId
          ? `Conversation created (${conversationId}). Tool turns are stored on the Conversation.`
          : 'Conversations API unavailable — continuing with previous_response_id.',
        status: 'completed',
        timestamp: new Date().toISOString(),
        reasoningEffort: toolEffort,
        kind: 'agent',
      },
      hooks.onSteps
    );
  }

  pushStep(
    steps,
    {
      title: 'Agent thinking',
      description: mode === 'fast' ? 'Preparing answer in Fast mode' : 'Preparing answer in Thinking mode',
      status: 'in_progress',
      timestamp: new Date().toISOString(),
      reasoningEffort: toolEffort,
      kind: 'agent',
    },
    hooks.onSteps
  );
  hooks.onAgentStatus?.('thinking');

  let rounds = 0;
  let continuationFallbackUsed = false;
  let retrieveCount = 0;
  let pendingToolOutputs: ResponseInputItem[] = [];
  /** Function calls returned by Azure that still need function_call_output (for abort settle). */
  let openFunctionCalls: Array<{ callId: string; name: string }> = [];

  const attachConversation = (body: Record<string, unknown>) => {
    if (conversationId && conversationApiAvailable) {
      body.conversation = conversationId;
      delete body.previous_response_id;
    } else if (previousResponseId) {
      body.previous_response_id = previousResponseId;
      delete body.conversation;
    }
  };

  const isConversationParamUnsupported = (error: unknown): boolean => {
    const msg = String((error as Error)?.message || error || '').toLowerCase();
    return msg.includes('unknown_parameter') && msg.includes('conversation');
  };

  /** Close dangling function_call items so the next user turn can reuse this Conversation. */
  const settleOpenFunctionCalls = async (): Promise<void> => {
    const outputs = [...pendingToolOutputs];
    const already = new Set(
      outputs
        .map((item) => String((item as { call_id?: string }).call_id || ''))
        .filter(Boolean)
    );
    for (const call of openFunctionCalls) {
      if (already.has(call.callId)) continue;
      outputs.push({
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify({
          ok: false,
          cancelled: true,
          error: 'User stopped generation',
        }),
      });
    }
    if (!outputs.length) {
      openFunctionCalls = [];
      pendingToolOutputs = [];
      return;
    }
    try {
      const settleBody: Record<string, unknown> = {
        model,
        tools: AGENT_TOOL_DEFINITIONS,
        tool_choice: 'none',
        store: true,
        stream: false,
        input: [
          ...outputs,
          messageItem(
            'user',
            '(User stopped generation. No further tool calls. Reply with a short acknowledgement only.)'
          ),
        ],
        reasoning: buildReasoningConfig(toolEffort),
      };
      attachConversation(settleBody);
      const settleData = await createResponses(
        settleBody,
        'agent.abort_settle',
        conversationId && conversationApiAvailable ? conversationResponsesEndpoint : null,
        undefined,
        gptLog
        // intentionally no signal — cleanup must finish after client abort
      );
      previousResponseId = extractResponseId(settleData) || previousResponseId;
      const settleUsage = extractTokenUsage(settleData);
      if (settleUsage) tokenUsage = addTokenUsage(tokenUsage, settleUsage);
      console.log(
        `[Agent] abort settle ok conversation=${conversationId || '-'} response=${previousResponseId || '-'}`
      );
    } catch (error) {
      console.warn(
        `[Agent] abort settle failed (follow-up may need a fresh conversation): ${(error as Error).message}`
      );
    } finally {
      openFunctionCalls = [];
      pendingToolOutputs = [];
    }
  };

  const buildAbortedResult = async (partialAnswer = ''): Promise<ResponseAgentResult> => {
    await settleOpenFunctionCalls();
    completeAllInProgress(
      steps,
      { status: 'completed', description: 'User stopped generation' },
      hooks.onSteps
    );
    await persistConversationBlob({
      lastResponseId: previousResponseId,
    });
    gptLog.setConversationId(conversationId);
    const gptCallLogPath = await gptLog.flush();
    agentTiming(
      'aborted',
      agentStartedAt,
      `rounds=${rounds} retrieves=${retrieveCount} conversation=${conversationId || '-'}`
    );
    return {
      answer: partialAnswer,
      thinkingSteps: steps,
      imageUrls: assetStore.imageUrls,
      pdfUrls: assetStore.pdfUrls,
      answerReasoningEffort: answerEffort,
      tokenUsage,
      responseId: previousResponseId,
      conversationId,
      aborted: true,
      gptCallLogPath,
    };
  };

  const renderer = createStreamingAssetRenderer(
    assetStore.imageSasUrlMap,
    assetStore.refLinkMap,
    hooks.onHoldChange
  );
  let streamedAnswer = '';

  const feedAnswerDelta = (delta: string) => {
    const visible = renderer.feed(delta);
    if (visible) {
      streamedAnswer += visible;
      hooks.onChunk?.(visible);
    }
  };

  try {
  while (rounds < maxRounds) {
    throwIfAborted(signal);
    rounds += 1;
    // Single agent loop: tools + reasoning + final_answer in the same Responses turns
    // (no separate answer call / answer prompt).
    const body: Record<string, unknown> = {
      model,
      tools: AGENT_TOOL_DEFINITIONS,
      tool_choice: 'auto',
      reasoning: buildReasoningConfig(toolEffort),
      store: true,
      input: pendingInput,
    };
    attachConversation(body);

    const roundStartedAt = Date.now();
    let turn: StreamTurnResult;
    try {
      turn = await streamResponsesTurn(
        body,
        {
          onFinalAnswerDelta: (delta) => {
            if (!streamedAnswer && !delta) return;
            hooks.onAgentStatus?.('answering');
            feedAnswerDelta(delta);
          },
          onReasoningSummary: (payload) => {
            hooks.onReasoningSummary?.(payload);
          },
          onModelFirstToken: hooks.onModelFirstToken,
        },
        'agent.stream',
        conversationId && conversationApiAvailable ? conversationResponsesEndpoint : null,
        signal,
        gptLog
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        const partial = rewriteFinalAnswerArtifacts(
          streamedAnswer || '',
          buildLookupFromAssetStore(assetStore)
        );
        return await buildAbortedResult(partial);
      }
      if (
        conversationId &&
        conversationResponsesEndpoint &&
        !continuationFallbackUsed &&
        isConversationSurfaceNotFoundError(error)
      ) {
        continuationFallbackUsed = true;
        conversationApiAvailable = false;
        console.warn(
          `[Conversation] paired Responses URL 404 — falling back to AZURE_OPENAI_ENDPOINT + previous_response_id. url=${conversationResponsesEndpoint} err=${(error as Error).message}`
        );
        conversationId = undefined;
        conversationResponsesEndpoint = null;
        pendingInput = previousResponseId ? buildContinueInput() : buildFreshInput();
        updateLastInProgress(
          steps,
          {
            status: 'completed',
            description: 'Conversation Responses URL unavailable — using AZURE_OPENAI_ENDPOINT',
          },
          hooks.onSteps
        );
        pushStep(
          steps,
          {
            title: 'Agent thinking',
            description: 'Restarted without Conversations (endpoint mismatch)',
            status: 'in_progress',
            timestamp: new Date().toISOString(),
            reasoningEffort: toolEffort,
          },
          hooks.onSteps
        );
        rounds -= 1;
        continue;
      }

      if (conversationId && !continuationFallbackUsed && isConversationParamUnsupported(error)) {
        continuationFallbackUsed = true;
        conversationApiAvailable = false;
        console.warn(
          `[Conversation] Responses rejects conversation param — switching to previous_response_id. ${(error as Error).message}`
        );
        conversationId = undefined;
        conversationResponsesEndpoint = null;
        pendingInput = previousResponseId ? buildContinueInput() : buildFreshInput();
        updateLastInProgress(
          steps,
          {
            status: 'completed',
            description: 'conversation param unsupported — using previous_response_id',
          },
          hooks.onSteps
        );
        pushStep(
          steps,
          {
            title: 'Agent thinking',
            description: 'Restarted without Conversations API',
            status: 'in_progress',
            timestamp: new Date().toISOString(),
            reasoningEffort: toolEffort,
          },
          hooks.onSteps
        );
        rounds -= 1;
        continue;
      }

      const canRecoverConversation =
        conversationId &&
        !continuationFallbackUsed &&
        (isConversationMissingError(error) || isPreviousResponseMissingError(error));
      if (canRecoverConversation) {
        continuationFallbackUsed = true;
        console.warn(
          `[Conversation] missing/expired — recreating. prev=${conversationId} err=${(error as Error).message}`
        );
        try {
          const created = await createAzureConversation({
            metadata: {
              chatSessionId: String(options.chatSessionId || '').slice(0, 64),
              mode,
              recovered: '1',
            },
          });
          conversationId = created.id;
          conversationApiAvailable = true;
          conversationResponsesEndpoint = getConversationResponsesEndpoint();
          previousResponseId = undefined;
          pendingInput = buildFreshInput();
          await persistConversationBlob();
        } catch (createErr) {
          conversationApiAvailable = false;
          conversationId = undefined;
          conversationResponsesEndpoint = null;
          previousResponseId = undefined;
          pendingInput = buildFreshInput();
          console.warn(
            `[Conversation] recreate failed — chatHistory fallback. ${(createErr as Error).message}`
          );
        }
        updateLastInProgress(
          steps,
          {
            status: 'completed',
            description: conversationId
              ? 'Conversation unavailable — recreated and fell back to chatHistory'
              : 'Conversation unavailable — fell back to chatHistory',
          },
          hooks.onSteps
        );
        pushStep(
          steps,
          {
            title: 'Agent thinking',
            description: conversationId
              ? `Restarted with new Conversation ${conversationId}`
              : 'Restarted turn with chatHistory',
            status: 'in_progress',
            timestamp: new Date().toISOString(),
            reasoningEffort: toolEffort,
          },
          hooks.onSteps
        );
        rounds -= 1;
        continue;
      }

      if (previousResponseId && !continuationFallbackUsed && isPreviousResponseMissingError(error)) {
        continuationFallbackUsed = true;
        previousResponseId = undefined;
        pendingInput = buildFreshInput();
        updateLastInProgress(
          steps,
          {
            status: 'completed',
            description: 'previous_response_id unavailable — fell back to chatHistory',
          },
          hooks.onSteps
        );
        pushStep(
          steps,
          {
            title: 'Agent thinking',
            description: 'Restarted turn with chatHistory',
            status: 'in_progress',
            timestamp: new Date().toISOString(),
            reasoningEffort: toolEffort,
          },
          hooks.onSteps
        );
        rounds -= 1;
        continue;
      }
      throw error;
    }

    previousResponseId = turn.responseId || previousResponseId;
    // Tool outputs in this request were accepted by Responses.
    pendingToolOutputs = [];
    openFunctionCalls = [];
    pendingInput = [];
    if (turn.usage) tokenUsage = addTokenUsage(tokenUsage, turn.usage);

    const calls = turn.functionCalls;
    agentTiming(
      `agent_round_${rounds}`,
      roundStartedAt,
      `calls=${calls.length} finalChars=${(turn.text || '').length} tool_choice=auto mode=${mode}`
    );

    if (!calls.length) {
      // Same turn already streamed phase=final_answer (or unphased message). No separate answer call.
      hooks.onReasoningSummary?.({ active: false, text: null });
      updateLastInProgress(
        steps,
        {
          status: 'completed',
          description: turn.text
            ? 'Final answer generated (phase: final_answer)'
            : 'Turn completed without tools',
        },
        hooks.onSteps
      );
      break;
    }

    openFunctionCalls = calls.map((c) => ({ callId: c.callId, name: c.name }));

    updateLastInProgress(
      steps,
      {
        status: 'completed',
        description:
          calls.length === 1
            ? `Calling tool: ${calls[0].name}`
            : `Calling ${calls.length} tools`,
        kind: 'agent',
      },
      hooks.onSteps
    );

    pendingToolOutputs = [];
    for (const call of calls) {
      throwIfAborted(signal);
      const argsSummary = summarizeToolArgs(call.name, call.arguments);
      const groupId = call.callId || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeToolGroupId = groupId;
      hooks.onToolStart?.({ name: call.name, argsSummary, callId: call.callId });
      pushStep(
        steps,
        {
          title: `Tool: ${call.name}`,
          description: shortToolStartSummary(call.name, argsSummary),
          status: 'in_progress',
          timestamp: new Date().toISOString(),
          kind: 'tool',
          groupId,
        },
        hooks.onSteps
      );

      let ok = true;
      let summary = '';
      let result: unknown;
      const toolStartedAt = Date.now();
      try {
        const executed = await executeAgentTool(call.name, call.arguments, toolCtx);
        throwIfAborted(signal);
        result = executed.result;
        summary = executed.summary;
        ok = (executed.result as { ok?: boolean })?.ok !== false;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          // Remaining open calls (including current) are settled in buildAbortedResult.
          const partial = rewriteFinalAnswerArtifacts(
            streamedAnswer || '',
            buildLookupFromAssetStore(assetStore)
          );
          return await buildAbortedResult(partial);
        }
        ok = false;
        summary = (error as Error).message;
        result = { ok: false, error: summary };
      }
      agentTiming(`tool_${call.name}`, toolStartedAt, ok ? 'ok' : `error=${summary}`);

      const brief = shortToolResultSummary(call.name, result, ok, summary);
      for (let i = steps.length - 1; i >= 0; i--) {
        if (
          steps[i].status === 'in_progress' &&
          (steps[i].kind === 'tool' || String(steps[i].title).startsWith('Tool:'))
        ) {
          steps[i] = {
            ...steps[i],
            status: ok ? 'completed' : 'error',
            description: brief,
            error: ok ? undefined : summary,
            kind: 'tool',
            groupId,
            timestamp: new Date().toISOString(),
          };
          hooks.onSteps?.(steps.slice());
          break;
        }
      }
      activeToolGroupId = undefined;
      hooks.onToolDone?.({ name: call.name, callId: call.callId, ok, summary: brief });

      const outputItem: ResponseInputItem = {
        type: 'function_call_output',
        call_id: call.callId,
        output: JSON.stringify(result),
      };
      pendingInput.push(outputItem);
      pendingToolOutputs.push(outputItem);
      openFunctionCalls = openFunctionCalls.filter((c) => c.callId !== call.callId);

      if (call.name === 'fetch_chapters_by_paths') {
        retrieveCount += 1;
      }
    }

    const reviewDetail = toolCtx.fetchedChapterRefs.length
      ? `Fetched ${toolCtx.fetchedChapterRefs.length} chapter(s). If body text has cross-refs or missing connectors, call fetch_chapters_by_paths again first`
      : 'Reviewing tool results…';
    pushStep(
      steps,
      {
        title: 'Agent thinking',
        description: reviewDetail,
        status: 'in_progress',
        timestamp: new Date().toISOString(),
        reasoningEffort: toolEffort,
        kind: 'agent',
      },
      hooks.onSteps
    );
  }

  throwIfAborted(signal);
  hooks.onReasoningSummary?.({ active: false, text: null });
  completeAllInProgress(steps, { status: 'completed' }, hooks.onSteps);

  const tail = renderer.flush();
  if (tail) {
    streamedAnswer += tail;
    hooks.onChunk?.(tail);
  }

  const finalText = rewriteFinalAnswerArtifacts(
    streamedAnswer || '',
    buildLookupFromAssetStore(assetStore)
  );
  updateLastInProgress(steps, { status: 'completed', description: 'Answer ready' }, hooks.onSteps);
  agentTiming(
    'total',
    agentStartedAt,
    `mode=${mode} rounds=${rounds} retrieves=${retrieveCount} images=${assetStore.imageUrls.length} conversation=${conversationId || '-'}`
  );

  await persistConversationBlob({
    lastResponseId: previousResponseId,
  });

  gptLog.setConversationId(conversationId);
  const gptCallLogPath = await gptLog.flush();

  return {
    answer: finalText,
    thinkingSteps: steps,
    imageUrls: assetStore.imageUrls,
    pdfUrls: assetStore.pdfUrls,
    answerReasoningEffort: answerEffort,
    tokenUsage,
    responseId: previousResponseId,
    conversationId,
    gptCallLogPath,
  };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      const partial = rewriteFinalAnswerArtifacts(
        streamedAnswer || '',
        buildLookupFromAssetStore(assetStore)
      );
      return await buildAbortedResult(partial);
    }
    await gptLog.flush().catch(() => null);
    throw error;
  }
}
