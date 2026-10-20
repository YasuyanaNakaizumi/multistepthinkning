import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from '../config';
import {
  InitialQueryAndTocResponse,
  TOCChaptersResponse,
} from '../types';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Disable model reasoning on intermediate JSON steps (faster / cheaper). */
export const CHAT_REASONING_EFFORT = 'none' as const;
/** Fast-mode agent: light reasoning with summary. */
export const FAST_REASONING_EFFORT = 'low' as const;
/** Thinking-mode agent: medium reasoning with summary. */
export const FINAL_ANSWER_REASONING_EFFORT = 'medium' as const;

export type AgentReasoningEffort =
  | typeof CHAT_REASONING_EFFORT
  | typeof FAST_REASONING_EFFORT
  | typeof FINAL_ANSWER_REASONING_EFFORT;

function getInferenceClient(endpoint: string) {
  if (config.aiInference.authMode === 'entra_id') {
    return ModelClient(endpoint, new DefaultAzureCredential());
  }
  return ModelClient(endpoint, new AzureKeyCredential(config.aiInference.apiKey));
}

function getChatEndpoint(): string {
  // For Azure Foundry, chat is exposed via the Inference endpoint.
  // Prefer AZURE_AI_INFERENCE_ENDPOINT.
  return config.aiInference.endpoint || config.azureOpenAI.endpoint;
}

function getChatModel(): string {
  // We keep AZURE_OPENAI_DEPLOYMENT as the chat model name for compatibility.
  return config.azureOpenAI.deployment;
}

function requireNonEmpty(value: string, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing or empty`);
  }
  return value;
}

/** Truncate long strings for terminal GPT I/O logs (TOC / chapter text etc.). */
export function clipForLog(value: unknown, max = 100): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…(+${oneLine.length - max} chars)`;
}

export function clipDeepForLog(value: unknown, max = 100): unknown {
  if (typeof value === 'string') return clipForLog(value, max);
  if (Array.isArray(value)) return value.map((v) => clipDeepForLog(v, max));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clipDeepForLog(v, max);
    }
    return out;
  }
  return value;
}

/** Log GPT request/response to the terminal (long string fields clipped to 100 chars). */
export function logGptExchange(label: string, request: unknown, response?: unknown): void {
  console.log(`[GPT] ▶ ${label}`);
  try {
    console.log(`[GPT]   request: ${JSON.stringify(clipDeepForLog(request))}`);
  } catch {
    console.log(`[GPT]   request: ${clipForLog(request)}`);
  }
  if (arguments.length >= 3) {
    try {
      console.log(`[GPT]   response: ${JSON.stringify(clipDeepForLog(response))}`);
    } catch {
      console.log(`[GPT]   response: ${clipForLog(response)}`);
    }
  }
}

function isAzureResponsesUrl(url: string): boolean {
  return /\/openai\/responses/i.test(url);
}

async function responsesJson<T>(
  messages: ChatMessage[],
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = CHAT_REASONING_EFFORT,
  logLabel = 'responsesJson'
): Promise<T> {
  const url = requireNonEmpty(config.azureOpenAI.endpoint, 'AZURE_OPENAI_ENDPOINT');
  const apiKey = requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY');

  const requestBody = {
    model: requireNonEmpty(config.azureOpenAI.deployment, 'AZURE_OPENAI_DEPLOYMENT_NAME'),
    input: messages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: m.content }] })),
    response_format: { type: 'json_object' },
    reasoning: { effort: reasoningEffort },
  };
  logGptExchange(logLabel, requestBody);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Responses API error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const data: any = await resp.json();
  const text =
    data?.output_text ||
    data?.output?.[0]?.content?.map((c: any) => c?.text).filter(Boolean).join('') ||
    data?.output?.[0]?.content?.[0]?.text;

  if (!text) {
    throw new Error('Azure Responses API returned empty text');
  }

  const parsed = JSON.parse(text) as T;
  console.log(`[GPT]   response (${logLabel}): ${JSON.stringify(clipDeepForLog(parsed))}`);
  return parsed;
}

export type FinalAnswerAssetLookup = {
  imageByTitle: Map<string, string>;
  imageUrlToBasename: Map<string, string>;
  pdfByTitle: Map<string, string>;
  pdfLinkTitles: Array<{ label: string; url: string }>;
  pdfByRefId: Map<string, string>;
};

function normalizeAssetTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sanitizePdfLinkLabel(title: string): string {
  return String(title || '').replace(/\[/g, '(').replace(/\]/g, ')');
}

function findPdfMarkdownLink(
  text: string,
  start: number
): { end: number; title: string; url: string } | null {
  if (text[start] !== '[') return null;
  if (start > 0 && text[start - 1] === '!') return null;
  // Image tokens are [[IMG:...]] — never treat them as PDF links.
  if (text[start + 1] === '[') return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') return null;
    if (i - start > 240) return null;
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch !== ']') continue;
    depth -= 1;
    if (depth !== 0 || text[i + 1] !== '(') continue;

    const title = text.slice(start + 1, i);
    if (!title.trim() || /\[\[?\s*IMG\s*:/i.test(title)) return null;
    const urlOpen = i + 2;
    if (text[urlOpen] === '<') {
      const urlClose = text.indexOf('>', urlOpen + 1);
      if (urlClose < 0 || text[urlClose + 1] !== ')') return null;
      return { end: urlClose + 2, title, url: text.slice(urlOpen + 1, urlClose) };
    }

    const urlClose = text.indexOf(')', urlOpen);
    if (urlClose < 0) return null;
    return { end: urlClose + 1, title, url: text.slice(urlOpen, urlClose) };
  }
  return null;
}

function skipAssetToken(text: string, start: number): number | null {
  const slice = text.slice(start, start + 12);
  if (!/^\[\[\s*(IMG|PDF)\s*:/i.test(slice) && !/^\[\s*(IMG|PDF)\s*:/i.test(slice)) return null;
  const close = text.indexOf(']]', start);
  if (close < 0) return null;
  return close + 2;
}

function rewritePdfMarkdownLinks(
  text: string,
  replacer: (title: string, url: string) => string
): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('[', index);
    if (open < 0) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, open);
    const imageEnd = skipAssetToken(text, open);
    if (imageEnd != null) {
      output += text.slice(open, imageEnd);
      index = imageEnd;
      continue;
    }
    const parsed = findPdfMarkdownLink(text, open);
    if (!parsed) {
      output += text[open];
      index = open + 1;
      continue;
    }
    output += replacer(parsed.title, parsed.url);
    index = parsed.end;
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linkifyKnownPdfTitles(
  answerText: string,
  pdfByTitle: Map<string, string>,
  pdfLinkTitles: Array<{ label: string; url: string }>
): string {
  const titles = Array.from(
    new Map(
      pdfLinkTitles
        .filter((item) => item.label.trim().length >= 8 && item.url)
        .map((item) => [item.label.trim(), item.url])
    ).entries()
  ).sort((a, b) => b[0].length - a[0].length);

  let rewritten = answerText;
  for (const [title, mappedUrl] of titles) {
    const url = pdfByTitle.get(normalizeAssetTitle(title)) || mappedUrl;
    if (!url) continue;
    const pattern = new RegExp(`(?<!\\[)${escapeRegExp(title)}(?!\\]\\()`, 'gi');
    rewritten = rewritten.replace(pattern, (match, offset: number, source: string) => {
      const before = source.slice(Math.max(0, offset - 2), offset);
      if (before.endsWith('](') || before.endsWith('[')) return match;
      return `[${sanitizePdfLinkLabel(match)}](<${url}>)`;
    });
  }
  return rewritten;
}

function findImageUrlByBasename(lookup: FinalAnswerAssetLookup, fileName: string): string | undefined {
  const normalized = normalizeAssetTitle(fileName);
  for (const [url, basename] of lookup.imageUrlToBasename) {
    if (normalizeAssetTitle(basename) === normalized) return url;
    const urlBasename = url.split('/').pop();
    if (urlBasename && normalizeAssetTitle(urlBasename) === normalized) return url;
  }
  return undefined;
}

export function rewriteFinalAnswerArtifacts(answerText: string, lookup: FinalAnswerAssetLookup): string {
  let rewritten = answerText;

  rewritten = rewritten.replace(/\[\[\s*PDF\s*:\s*(shop-\d+)\s*\]\]/gi, (match, refId) => {
    return lookup.pdfByRefId.get(String(refId).toLowerCase()) || match;
  });
  rewritten = rewritten.replace(/\[(shop-\d+)\]/gi, (match, refId) => {
    return lookup.pdfByRefId.get(String(refId).toLowerCase()) || match;
  });

  // Fix bare image filename references the model sometimes emits, e.g., "!diagram_page_4203_1.jpg".
  rewritten = rewritten.replace(/!([^\S\r\n]*)([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|gif|webp))/gi, (match, ws, fileName) => {
    const normalized = normalizeAssetTitle(fileName);
    const canonicalUrl = lookup.imageByTitle.get(normalized) || findImageUrlByBasename(lookup, fileName);
    if (canonicalUrl) {
      const canonicalTitle = lookup.imageUrlToBasename.get(canonicalUrl) || fileName;
      return `![${canonicalTitle}](${canonicalUrl})`;
    }
    return match;
  });

  rewritten = rewritten.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, titleRaw, urlRaw) => {
    const title = String(titleRaw || '').trim();
    const url = String(urlRaw || '').trim();
    const normalizedTitle = normalizeAssetTitle(title);
    const canonicalUrl = lookup.imageByTitle.get(normalizedTitle)
      || findImageUrlByBasename(lookup, title)
      || findImageUrlByBasename(lookup, url);
    if (canonicalUrl) {
      const canonicalTitle = lookup.imageUrlToBasename.get(canonicalUrl) || title;
      return `![${canonicalTitle}](${canonicalUrl})`;
    }
    if (lookup.imageUrlToBasename.has(url)) {
      const canonicalTitle = lookup.imageUrlToBasename.get(url)!;
      return `![${canonicalTitle}](${url})`;
    }
    return match;
  });

  rewritten = rewritePdfMarkdownLinks(rewritten, (titleRaw, urlRaw) => {
    const title = String(titleRaw || '').trim();
    const existing = String(urlRaw || '').trim();
    const canonicalUrl = lookup.pdfByTitle.get(normalizeAssetTitle(title));
    if (!canonicalUrl) {
      return title;
    }
    const label = sanitizePdfLinkLabel(title);
    if (canonicalUrl !== existing) {
      return `[${label}](<${canonicalUrl}>)`;
    }
    return `[${label}](<${existing}>)`;
  });

  rewritten = linkifyKnownPdfTitles(rewritten, lookup.pdfByTitle, lookup.pdfLinkTitles);

  return removeLinksFromTables(rewritten);
}

function removeLinksFromTables(answerText: string): string {
  return answerText.split(/\r?\n/).map((rawLine) => {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Keep textual/PDF citation links in tables (e.g., "参照" column), only strip images.
      return rawLine.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, text) => text);
    }
    return rawLine;
  }).join('\n');
}

export async function generateSearchQueriesAndInitialToc(
  userQuery: string,
  tocContent: string,
  chatHistory: any[] = []
): Promise<InitialQueryAndTocResponse> {
    const historyContext = chatHistory
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
  const hasToc = Boolean(tocContent && tocContent.trim());

  try {
    const response = await chatJson<InitialQueryAndTocResponse>([
      {
        role: 'system',
        content:
          `You prepare the first retrieval plan for a technical documentation search system.

## Task
In ONE response:
1) Generate effective search queries from the user question (and recent chat history).
2) If a Table of Contents is provided, select the most relevant TOC path values for the INITIAL search.

## What to Extract into queries
- error codes / fault codes (e.g., CA441)
- part numbers, TSI, PSN, serial-like identifiers
- component names, connector IDs (when explicitly mentioned)
- maintenance-related terms and periodic inspection terms when the question is about operation and maintenance manuals

## Conversation Context (IMPORTANT)
- If chat history is provided, you MUST use it to resolve omitted context in the current user query.
- Do NOT invent identifiers that do not appear in the user query or recent chat history.

## Query rules
- If no identifiers are found, return the original user query as a single query.
- Set has_codes true only when at least one error/fault code appears in the query or recent history.

## TOC path rules (only when TOC is provided)
1. Return the EXACT path strings as they appear in the TOC.
2. Prefer leaf-level / deepest / most specific paths over parent paths.
3. Select paths for the CURRENT User Query ONLY. Chat history may resolve omitted pronouns/context, but do NOT re-select chapters for previous topics (e.g. a prior fault code) unless the current query still asks about them.
4. Do NOT return titles. Return path values only.
5. Prefer FEWER paths — typically 3–8, hard maximum 8. Never dump broad related trees.
6. Match the asked action precisely:
   - Disassembly / 分解 → prefer DISASSEMBLE (or REMOVE when take-off is required). Do NOT also select INSTALL / ASSEMBLE / oil-change / sprocket / unrelated troubleshooting unless the query asks for them.
   - Assembly / 組立 → prefer ASSEMBLE (not disassemble).
   - Fault code / 故障コード → that code's diagnostic chapter(s), not unrelated assembly sections.
7. Skip generic SAFETY / PRECAUTIONS chapters unless the query is specifically about safety.
8. Maintenance (OMM): If the query is about maintenance / 定期点検 and a Maintenance parent exists, include the relevant child detail paths only (still within the max of 8).
9. If no TOC is provided, return "chapters": [].

## Output
Return JSON only:
{
  "queries": ["query1", "query2"],
  "has_codes": true,
  "chapters": ["path/from/toc", "another/path"]
}`,
      },
      {
        role: 'user',
        content: `User Query: ${userQuery}

Recent Chat History (most recent last):
${historyContext}

## Table of Contents
${hasToc ? tocContent : '(No TOC provided — return chapters as an empty array.)'}`,
      },
    ], CHAT_REASONING_EFFORT, 'generateSearchQueriesAndInitialToc');

    const queries = Array.isArray(response?.queries) && response.queries.length > 0
      ? response.queries.map((q) => String(q || '').trim()).filter(Boolean)
      : [userQuery];
    const chapters = hasToc && Array.isArray(response?.chapters)
      ? response.chapters.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 8)
      : [];

    return {
      queries,
      has_codes: !!response?.has_codes,
      chapters,
    };
  } catch (error) {
    console.error('Error generating search queries and initial TOC paths:', error);
    return { queries: [userQuery], has_codes: false, chapters: [] };
  }
}

async function chatJson<T>(
  messages: ChatMessage[],
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = CHAT_REASONING_EFFORT,
  logLabel = 'chatJson'
): Promise<T> {
  // Prefer Foundry inference endpoint; fallback to Azure OpenAI Responses API if configured.
  if (config.aiInference.endpoint) {
    const endpoint = requireNonEmpty(getChatEndpoint(), 'AZURE_AI_INFERENCE_ENDPOINT');
    const model = requireNonEmpty(getChatModel(), 'AZURE_OPENAI_DEPLOYMENT');
    const client = getInferenceClient(endpoint);
    logGptExchange(logLabel, { model, reasoning_effort: reasoningEffort, messages });
    const response = await client.path('/chat/completions').post({
      body: {
        model,
        messages,
        response_format: { type: 'json_object' },
        reasoning_effort: reasoningEffort,
      } as any,
    });

    if (isUnexpected(response)) {
      throw (response as any).body?.error || new Error('Inference chat/completions failed');
    }

    const content = (response as any).body?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Inference returned empty content');
    }
    const parsed = JSON.parse(content) as T;
    console.log(`[GPT]   response (${logLabel}): ${JSON.stringify(clipDeepForLog(parsed))}`);
    return parsed;
  }

  if (config.azureOpenAI.endpoint && isAzureResponsesUrl(config.azureOpenAI.endpoint)) {
    return responsesJson<T>(messages, reasoningEffort, logLabel);
  }

  throw new Error('No chat endpoint configured. Set AZURE_AI_INFERENCE_ENDPOINT or AZURE_OPENAI_ENDPOINT (Responses API URL).');
}

export async function getTextEmbedding(input: string): Promise<number[]> {
  const endpoint = requireNonEmpty(config.aiInference.endpoint, 'AZURE_AI_INFERENCE_ENDPOINT');
  const model = requireNonEmpty(config.aiInference.modelName, 'AZURE_AI_INFERENCE_MODEL_NAME');
  const client = getInferenceClient(endpoint);
  const response = await client.path('/embeddings').post({
    body: {
      model,
      input: [input],
    },
  });

  if (isUnexpected(response)) {
    throw (response as any).body?.error || new Error('Inference embeddings failed');
  }

  const embedding = (response as any).body?.data?.[0]?.embedding as number[] | undefined;
  if (!embedding || embedding.length === 0) {
    throw new Error('Embedding returned empty vector');
  }
  return embedding;
}

export type SearchedChapterRef = { title: string; path: string };

export async function selectTOCChapters(
  queries: string[],
  userQuery: string,
  tocContent: string,
  alreadySearchedChapters: SearchedChapterRef[] = []
): Promise<TOCChaptersResponse> {
  try {
    const alreadySearchedJson = JSON.stringify(
      alreadySearchedChapters
        .map((chapter) => ({
          title: (chapter.title || '').trim(),
          path: (chapter.path || '').trim(),
        }))
        .filter((chapter) => chapter.title || chapter.path),
      null,
      2
    );

    const response = await chatJson<TOCChaptersResponse>([
      {
        role: 'system',
        content:
          'You are an expert at finding relevant TOC path values in technical manuals. Prefer the deepest, most specific paths. Return only additional TOC paths that have not already been searched.',
      },
      {
        role: 'user',
        content:
          `Below is the Table of Contents of available manuals. Given the search queries, select the TOC path values that are most likely to contain the needed information.

## Already Searched Chapters
These chapters were already retrieved in the previous search. Their titles and paths are listed below.
Do NOT select the same items again. Extract ONLY the additional TOC paths that still need to be added.

${alreadySearchedJson}

## Rules
1. Return the EXACT path strings as they appear in the TOC (one path per line).
2. Select at most 8 most relevant ADDITIONAL paths (prefer fewer). Do NOT be exhaustive.
3. Prefer leaf-level / deepest / most specific paths over parent paths.
4. Do NOT return titles. Return path values only.
5. Do not re-select a TOC path or title that already appears in Already Searched Chapters.
6. Cross-refs: If a search query names a chapter (e.g. CHECKS BEFORE TROUBLESHOOTING, CHECK ELECTRIC EQUIPMENT), include that path only — not siblings or the whole RELATED INFORMATION tree.
7. Connectors: Prefer CONNECTOR LIST AND LAYOUT and CONNECTOR CONTACT IDENTIFICATION (and 3D layout diagrams under that series if present). Do NOT select full ELECTRICAL CIRCUIT DIAGRAM pages, FAILURE CODES TABLE, fuse tables, monitor menus, or unrelated E-mode/S-mode chapters unless a query explicitly asks for them.
8. Avoid broad dumps: skip circuit diagrams (1_7)…(7_7), abnormality record menus, and general testing chapters unless clearly required by a search query.
9. Return JSON only.

## Output Format
{
  "chapters": ["XXXXXXXXXXXXX", "XXXXXXXXXX"]
}

## Search Queries
${JSON.stringify(queries)}

## User Query
${userQuery}

## Table of Contents
${tocContent}`,
      },
    ], CHAT_REASONING_EFFORT, 'selectTOCChapters');

    const alreadyPaths = new Set(
      alreadySearchedChapters.map((chapter) => (chapter.path || '').trim()).filter(Boolean)
    );
    const alreadyTitles = new Set(
      alreadySearchedChapters.map((chapter) => (chapter.title || '').trim()).filter(Boolean)
    );
    return {
      chapters: (response.chapters || []).filter((chapter) => {
        const value = chapter.trim();
        return value && !alreadyPaths.has(value) && !alreadyTitles.has(value);
      }),
    };
  } catch (error) {
    console.error('Error selecting TOC chapters:', error);
    return { chapters: [] };
  }
}

const IMAGE_FILE_PATTERN = /[A-Za-z0-9_.\-()]+\.(?:jpg|jpeg|png|gif|webp)/;

/**
 * Converts every way the model may reference an image into a real Markdown image.
 * Images are always addressed by file name; the SAS URL comes from imageSasUrlMap.
 * Any reference that cannot be resolved is removed so the user never sees raw text
 * such as "!diagram_page_1670_1.jpg".
 */
function renderImageReferences(answerText: string, imageSasUrlMap?: Map<string, string>): string {
  const lookup = imageSasUrlMap ?? new Map<string, string>();
  const urlFor = (fileName: string): string | undefined => {
    const key = fileName.trim().toLowerCase();
    if (!key) return undefined;
    const direct = lookup.get(key);
    if (direct) return direct;
    const base = key.split('/').pop() || key;
    if (lookup.get(base)) return lookup.get(base);
    for (const [mapKey, url] of lookup) {
      if (mapKey === base || mapKey.endsWith(`/${base}`) || base.endsWith(mapKey)) return url;
    }
    return undefined;
  };
  const toMarkdown = (fileName: string, fallback: string): string => {
    const url = urlFor(fileName);
    return url ? `![${fileName}](${url})` : fallback;
  };

  let rendered = answerText;

  // 1. Canonical token, plus broken leftovers like [IMG:file.jpg]] after a PDF-link rewrite.
  rendered = rendered.replace(/\[\[\s*IMG\s*:\s*([^\]]+?)\s*\]\]/gi, (_m, name) => toMarkdown(String(name), _m));
  rendered = rendered.replace(/\[\s*IMG\s*:\s*([^\]]+?)\s*\]\]?/gi, (_m, name) => toMarkdown(String(name), _m));

  // 2. Markdown images the model produced anyway - re-point them at the real URL.
  rendered = rendered.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (match, alt, url) => {
    const fromAlt = String(alt).match(IMAGE_FILE_PATTERN)?.[0];
    const fromUrl = String(url).split('?')[0].split('/').pop();
    const fileName = (fromAlt && urlFor(fromAlt) && fromAlt)
      || (fromUrl && urlFor(fromUrl) && fromUrl)
      || '';
    if (fileName) return toMarkdown(fileName, match);
    return String(url).startsWith('http') ? match : '';
  });

  // 3. Bare references such as "!diagram_page_1670_1.jpg" or a filename alone on a line.
  rendered = rendered
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      const bare = trimmed.match(new RegExp(`^!?\\s*(${IMAGE_FILE_PATTERN.source})$`));
      if (bare) return toMarkdown(bare[1], '');
      return line.replace(new RegExp(`!\\s*(${IMAGE_FILE_PATTERN.source})`, 'g'), (m, name) =>
        toMarkdown(String(name), m)
      );
    })
    .join('\n');

  // Collapse blank runs introduced by removed references.
  return rendered.replace(/\n{3,}/g, '\n\n');
}

function expandPdfTokens(text: string, pdfTokenMap?: Map<string, string>): string {
  if (!pdfTokenMap || pdfTokenMap.size === 0) return text;
  const lookup = (refId: string) =>
    pdfTokenMap.get(refId.toLowerCase()) || pdfTokenMap.get(refId) || '';
  return text
    .replace(/\[\[\s*PDF\s*:\s*(shop-\d+)\s*\]\]/gi, (match, refId) => lookup(String(refId)) || match)
    .replace(/\[(shop-\d+)\]/gi, (match, refId) => lookup(String(refId)) || match)
    .replace(/\[----\]/g, '[📄 Document Reference]');
}

/**
 * Hold only incomplete asset tokens. Do NOT hold on a bare "[" — that caused
 * intermittent freezes whenever the model emitted "[" in normal prose.
 */
function incompleteAssetTokenStart(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '[') continue;
    const rest = text.slice(i);

    if (rest.startsWith('[[')) {
      if (rest.includes(']]')) continue;
      // Incomplete [[PDF:...]] / [[IMG:...]] (or short prefix of those tags)
      if (/^\[\[\s*(IMG|PDF)\s*:/i.test(rest)) return i;
      if (/^\[\[\s*(?:I(?:M(?:G)?)?|P(?:D(?:F)?)?)?:?\s*$/i.test(rest)) return i;
      // Very short unknown [[... — wait a bit, then give up at flush
      if (rest.length <= 10) return i;
      continue;
    }

    // Incomplete [shop-123] only (require at least "[s" so bare "[" is emitted)
    if (/^\[s(?:h(?:o(?:p(?:-\d*)?)?)?)?$/i.test(rest)) return i;
  }
  return -1;
}

/**
 * Streaming helper: buffers just enough text so an image/PDF token is never split
 * across two chunks, and expands tokens as soon as they are complete.
 */
export function createStreamingAssetRenderer(
  imageSasUrlMap?: Map<string, string>,
  pdfTokenMap?: Map<string, string>,
  onHoldChange?: (holding: boolean) => void
) {
  let buffer = '';
  let wasHolding = false;

  const expand = (text: string): string =>
    renderImageReferences(expandPdfTokens(text, pdfTokenMap), imageSasUrlMap);

  const setHolding = (holding: boolean) => {
    if (holding === wasHolding) return;
    wasHolding = holding;
    onHoldChange?.(holding);
  };

  return {
    feed(chunk: string): string {
      buffer += chunk;
      const holdFrom = incompleteAssetTokenStart(buffer);
      if (holdFrom < 0) {
        const ready = buffer;
        buffer = '';
        setHolding(false);
        return expand(ready);
      }
      const ready = buffer.slice(0, holdFrom);
      buffer = buffer.slice(holdFrom);
      setHolding(buffer.length > 0);
      return ready ? expand(ready) : '';
    },
    flush(): string {
      const rest = buffer;
      buffer = '';
      setHolding(false);
      return rest ? expand(rest) : '';
    },
    isHolding(): boolean {
      return wasHolding;
    },
  };
}
