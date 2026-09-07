import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';
import { DefaultAzureCredential } from '@azure/identity';
import { createSseStream } from '@azure/core-sse';
import type { IncomingMessage } from 'node:http';
import { config } from '../config';
import {
  SearchQueriesResponse,
  InitialQueryAndTocResponse,
  TOCChaptersResponse,
  AnswerabilityResponse,
  AnswerPattern,
  AnswerPatternResponse,
  ExtractedElements,
  ChapterClassification,
} from '../types';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Disable model reasoning on intermediate JSON steps (faster / cheaper). */
export const CHAT_REASONING_EFFORT = 'none' as const;
/** Final answer generation and chapter classification use light reasoning. */
export const FINAL_ANSWER_REASONING_EFFORT = 'low' as const;

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

function isAzureResponsesUrl(url: string): boolean {
  return /\/openai\/responses/i.test(url);
}

async function responsesJson<T>(
  messages: ChatMessage[],
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = CHAT_REASONING_EFFORT
): Promise<T> {
  const url = requireNonEmpty(config.azureOpenAI.endpoint, 'AZURE_OPENAI_ENDPOINT');
  const apiKey = requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      model: requireNonEmpty(config.azureOpenAI.deployment, 'AZURE_OPENAI_DEPLOYMENT_NAME'),
      input: messages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: m.content }] })),
      // Best-effort JSON output enforcement
      response_format: { type: 'json_object' },
      reasoning: { effort: reasoningEffort },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Responses API error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const data: any = await resp.json();
  // Try to extract text output across possible shapes
  const text =
    data?.output_text ||
    data?.output?.[0]?.content?.map((c: any) => c?.text).filter(Boolean).join('') ||
    data?.output?.[0]?.content?.[0]?.text;

  if (!text) {
    throw new Error('Azure Responses API returned empty text');
  }

  return JSON.parse(text) as T;
}

async function streamResponses(
  userQuery: string,
  systemPrompt: string,
  historyMessages: ChatMessage[],
  onChunk: (chunk: string) => void,
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = FINAL_ANSWER_REASONING_EFFORT
): Promise<string> {
  const url = requireNonEmpty(config.azureOpenAI.endpoint, 'AZURE_OPENAI_ENDPOINT');
  const apiKey = requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      model: requireNonEmpty(config.azureOpenAI.deployment, 'AZURE_OPENAI_DEPLOYMENT_NAME'),
      stream: true,
      reasoning: { effort: reasoningEffort },
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        ...historyMessages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: m.content }] })),
        { role: 'user', content: [{ type: 'input_text', text: userQuery }] },
      ],
    }),
  });

  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Responses API stream error: ${resp.status} ${resp.statusText} ${txt}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullAnswer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE format: lines with "data: ..."
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const evt = JSON.parse(payload);
        // Prefer true deltas. Cumulative fields like output_text dump the whole answer at once.
        const deltaText =
          (typeof evt?.delta === 'string' && evt.delta) ||
          (typeof evt?.delta?.text === 'string' && evt.delta.text) ||
          evt?.delta?.content?.[0]?.text ||
          evt?.choices?.[0]?.delta?.content;

        if (typeof deltaText === 'string' && deltaText.length > 0) {
          fullAnswer += deltaText;
          onChunk(deltaText);
        }
      } catch {
        // ignore non-JSON chunks
      }
    }
  }

  return fullAnswer;
}

type FinalAnswerArtifact = {
  type: 'image' | 'pdf';
  title: string;
  url: string;
};

type FinalAnswerAssetLookup = {
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

function chapterTitleMatchesReference(chapterTitle: string, reference: string): boolean {
  const chapter = normalizeAssetTitle(chapterTitle);
  const ref = normalizeAssetTitle(reference);
  if (!chapter || !ref) return false;
  if (chapter === ref) return true;
  if (chapter.includes(ref) || ref.includes(chapter)) return true;
  const compact = (value: string) => value.replace(/[^a-z0-9]+/g, '');
  const compactChapter = compact(chapter);
  const compactRef = compact(ref);
  return compactChapter.includes(compactRef) || compactRef.includes(compactChapter);
}

function addPdfAliases(map: Map<string, string>, title: string, url: string): void {
  if (!title || !url) return;
  const variants = new Set<string>([
    title,
    sanitizePdfLinkLabel(title),
    title.replace(/[\[\]]/g, ' '),
  ]);
  const codeMatch = title.match(/\b([A-Z]{1,4}\d{2,5})\b/i);
  if (codeMatch) {
    variants.add(codeMatch[1]);
    variants.add(`FAILURE CODE ${codeMatch[1]}`);
    variants.add(`FAILURE CODE [${codeMatch[1]}]`);
    variants.add(`FAILURE CODE (${codeMatch[1]})`);
  }
  if (/check electric equipment/i.test(title)) {
    variants.add('Electrical equipment');
    variants.add('CHECK ELECTRIC EQUIPMENT');
  }
  if (/electrical equipment/i.test(title)) {
    variants.add('CHECK ELECTRIC EQUIPMENT');
  }
  for (const variant of variants) {
    const normalized = normalizeAssetTitle(variant);
    if (normalized) map.set(normalized, url);
  }
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

function addImageAliases(map: Map<string, string>, title: string, url: string): void {
  const normalized = normalizeAssetTitle(title);
  if (normalized) map.set(normalized, url);

  const withoutExt = title.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '');
  if (withoutExt !== title) {
    map.set(normalizeAssetTitle(withoutExt), url);
  }

  const spaced = withoutExt.replace(/[_-]+/g, ' ').replace(/\./g, ' ');
  if (spaced !== withoutExt) {
    map.set(normalizeAssetTitle(spaced), url);
  }

  const underscored = title.replace(/\s+/g, '_');
  if (underscored !== title) {
    map.set(normalizeAssetTitle(underscored), url);
  }
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

function extractFinalAnswerAssetLookup(contextText: string): FinalAnswerAssetLookup {
  const imageByTitle = new Map<string, string>();
  const imageUrlToBasename = new Map<string, string>();
  const pdfByTitle = new Map<string, string>();
  const pdfLinkTitles: Array<{ label: string; url: string }> = [];
  const pdfByRefId = new Map<string, string>();
  let pendingPdfTitle = '';

  let pendingImageTitle = '';
  let pendingImageBasename = '';

  function registerImageUrl(url: string): void {
    const titles = new Set<string>();
    if (pendingImageTitle) titles.add(pendingImageTitle);
    if (pendingImageBasename) titles.add(pendingImageBasename);
    for (const title of titles) {
      addImageAliases(imageByTitle, title, url);
    }
    const canonicalName = pendingImageBasename || pendingImageTitle;
    if (canonicalName) {
      imageUrlToBasename.set(url, canonicalName);
    }
  }

  function registerPdf(title: string, url: string): void {
    if (!title || !url) return;
    addPdfAliases(pdfByTitle, title, url);
    pdfLinkTitles.push({ label: title, url });
    const sanitized = sanitizePdfLinkLabel(title);
    if (sanitized !== title) pdfLinkTitles.push({ label: sanitized, url });
  }

  for (const rawLine of contextText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const pdfTitleMatch = line.match(/^pdf_title:\s*(.+)$/i);
    if (pdfTitleMatch) {
      pendingPdfTitle = pdfTitleMatch[1].trim();
      continue;
    }

    const pdfUrlMatch = line.match(/^PDF_CITATION_URL:\s*(.+)$/);
    if (pdfUrlMatch) {
      registerPdf(pendingPdfTitle, pdfUrlMatch[1].trim());
      continue;
    }

    const pdfMarkdownMatch = line.match(/^PDF_CITATION_MARKDOWN:\s*\[(.+)\]\(<([^>]+)>\)$/);
    if (pdfMarkdownMatch) {
      registerPdf(pdfMarkdownMatch[1].trim(), pdfMarkdownMatch[2].trim());
      continue;
    }

    const captionMatch = line.match(/^[-*]\s*Caption:\s*(.+)$/) || line.match(/^Caption:\s*(.+)$/);
    if (captionMatch) {
      pendingImageTitle = captionMatch[1].trim();
      continue;
    }

    const imageNameMatch = line.match(/^[-*]\s*Image:\s*(.+)$/) || line.match(/^Image:\s*(.+)$/);
    if (imageNameMatch) {
      pendingImageBasename = imageNameMatch[1].trim();
      if (!pendingImageTitle) {
        pendingImageTitle = pendingImageBasename;
      }
      continue;
    }

    const imageUrlMatch = line.match(/^IMAGE_URL:\s*(.+)$/);
    if (imageUrlMatch) {
      registerImageUrl(imageUrlMatch[1].trim());
      continue;
    }

    const imagePathListMatch = line.match(/^[-*]\s*(https?:\/\/\S+)$/);
    if (imagePathListMatch && pendingImageTitle) {
      registerImageUrl(imagePathListMatch[1].trim());
      continue;
    }
  }

  return { imageByTitle, imageUrlToBasename, pdfByTitle, pdfLinkTitles, pdfByRefId };
}

function rewriteFinalAnswerArtifacts(answerText: string, lookup: FinalAnswerAssetLookup): string {
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

function extractFinalAnswerArtifacts(answerText: string): FinalAnswerArtifact[] {
  const artifacts: FinalAnswerArtifact[] = [];
  const seen = new Set<string>();

  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of answerText.matchAll(imageRegex)) {
    const title = (match[1] || '').trim();
    const url = (match[2] || '').trim();
    if (!url) continue;
    const key = `image|${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ type: 'image', title, url });
  }

  let searchFrom = 0;
  while (searchFrom < answerText.length) {
    const open = answerText.indexOf('[', searchFrom);
    if (open < 0) break;
    const parsed = findPdfMarkdownLink(answerText, open);
    if (!parsed) {
      searchFrom = open + 1;
      continue;
    }
    searchFrom = parsed.end;
    const title = parsed.title.trim();
    const url = parsed.url.trim();
    if (!url || /^https?:\/\//i.test(url) === false) continue;
    if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i.test(url)) continue;
    const key = `pdf|${title}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ type: 'pdf', title, url });
  }

  return artifacts;
}

function logFinalAnswer(answerText: string, artifacts: FinalAnswerArtifact[]) {
  if (!answerText.trim()) return;

  const images = artifacts.filter((a) => a.type === 'image');
  const pdfs = artifacts.filter((a) => a.type === 'pdf');
  const unresolved = (answerText.match(/\[\[\s*IMG\s*:/gi) || []).length;

  console.log(
    `[Answer] ${answerText.length} chars | images=${images.length} | pdf links=${pdfs.length}` +
      (unresolved > 0 ? ` | UNRESOLVED image tokens=${unresolved}` : '')
  );
  if (images.length > 0) {
    console.log(`[Answer] images: ${images.map((a) => a.title).slice(0, 8).join(', ')}${images.length > 8 ? ` (+${images.length - 8} more)` : ''}`);
  }
  if (process.env.LOG_FULL_ANSWER === 'true') {
    console.log(answerText);
  }
}

export type MultiErrorCodeDetection = {
  is_multi_error_codes: boolean;
  error_codes: string[];
  reason: string;
};

type AnswerLanguage = 'ja' | 'en';

interface AnswerLanguageResponse {
  language: AnswerLanguage;
  reason: string;
}

function hasConnectorContext(combinedContext: string): boolean {
  return /(?:^|\n)EXTRACTED_CONNECTORS:\s*(?!\n)\S/.test(combinedContext) || /\(CONNECTOR\)/.test(combinedContext);
}

function buildConnectorSectionPrompt(
  multiError: { isMulti: boolean; codes?: string[] } = { isMulti: false },
  patterns: AnswerPattern[] = []
): string {
  const codes = Array.isArray(multiError.codes) ? multiError.codes.filter(Boolean) : [];
  const isFaultDiagnosis = patterns.some((pattern) => pattern === 'single_fault' || pattern === 'multi_fault')
    || multiError.isMulti;
  const faultDiagnosisImageRule = isFaultDiagnosis
    ? `
   - FAULT DIAGNOSIS (MANDATORY): This is troubleshooting / error-code diagnosis. You MUST include the connector 3D layout diagram (コネクタ立体配置図, 立体配置図, connector layout, connector location, 3D diagram) immediately after the connector table whenever any CONNECTOR Document Ref lists such an image file name. Never omit this image for fault diagnosis. Include every layout image needed to cover all connector rows in the table.`
    : '';
  const perCodeRule = multiError.isMulti && codes.length >= 2
    ? `
   - MULTI-CODE: output one connector subsection per error code, "### {CODE}", each with its OWN table in the format above AND its own 3D layout image(s) immediately after that table. Add a "共通のコネクタ" subsection only for connectors that appear in MAIN \`context:\` for ALL listed codes.
   - For each "### {CODE}" table, include only connector numbers that appear in that code's MAIN diagnostic \`context:\` (the chapter body that discusses that code). Do not merge in connectors that belong only to another code.
   - Error codes in this answer: ${codes.join(', ')}.`
    : `
   - SINGLE-CODE / non-multi: the table may include only connector numbers that appear in MAIN \`context:\` for the error code(s) or diagnostic procedure being answered.`;

  return `

CONNECTOR SECTION (MANDATORY - the Context contains connector information):
   - Output a section "## Related Connector Information" just before "## Required Tools". This is mandatory whenever the Context has "EXTRACTED_CONNECTORS:" or any Document Ref labeled (CONNECTOR), for ANY kind of question. Never omit it.
   - The table MUST have exactly these 5 columns, in this order, with this exact header. No extra, missing, renamed, reordered, merged, or translated columns:
| Connector No. | Connector Type | Number of pins | Installation position | Address |
|---|---|---|---|---|
   - Connector No. source (CRITICAL, applies to both single-code and multi-code answers):
     - A table row is allowed ONLY if that Connector No. appears in the \`context:\` field (chapter body text) of a MAIN Document Ref that discusses the relevant error code(s) or diagnostic procedure.
     - FORBIDDEN as a source of Connector No.: \`image_explanation\`, Caption, OCR, label_list, md_anchor_quotes, available_images, 3D layout / location drawings, and callouts printed on diagrams (e.g. an "E12" arrow on a figure).
     - Do NOT dump every row from a Connector List / Layout catalog. CONNECTOR Document Refs (and their \`context:\` tables) may be used only to fill Type / pins / Installation position / Address for connector numbers already selected from MAIN \`context:\`.
     - EXTRACTED_CONNECTORS is a hint only. Drop any hinted ID that does not also appear in MAIN \`context:\`.
   - One row per allowed connector. Fill unknown Type/pins/position/Address cells with "不明（提示された資料に記載なし）". If MAIN \`context:\` names no connector numbers, do not invent rows from images or from the full connector catalog; write "本文にコネクタ番号の記載なし" instead of a fabricated table.
   - Do NOT put links, citations, or images inside the table. Put citations in the text around the table, using ONLY Document Refs labeled (CONNECTOR).
   - IMMEDIATELY after the table, insert the 3D layout diagram image(s) with [[IMG:<file name>]] tokens, one token per line.
     - Use ONLY file names from Document Refs labeled (CONNECTOR); never from error-code or troubleshooting chapters.
     - Pick images whose caption/OCR indicates a layout/location view (コネクタ立体配置図, 立体配置図, connector layout, connector location, 3D diagram) AND that mention the same connector number as a table row.
     - Insert TWO OR MORE images when several are needed to cover all rows (e.g., a "(1)(2)(3)" series or different mounting locations).
     - If a CONNECTOR Document Ref lists any image file name, you MUST insert at least one image here.
     - A wiring/circuit diagram (回路図, 配線図, wiring diagram, circuit diagram, schematic) is NOT a valid substitute. If only those exist, insert no image and write: "立体配置図は提示された資料内で確認できません（回路図/配線図は代替として使用しません）".${faultDiagnosisImageRule}${perCodeRule}
   - If the Context includes a non-empty "EXTRACTED_COMPONENTS:" line, also output "## Related Component Information" listing each component with its location/mounting info and citations, placed after the connector section.
`;
}

function buildFinalAnswerSystemPromptBase(combinedContext: string): string {
  return `You are an assistant supporting a mechanical engineer. Your task is to provide comprehensive and accurate answers by integrating the provided documents (text and images).

Answer Creation Rules:
0. Language (CRITICAL / ABSOLUTE HIGHEST PRIORITY): Always write the entire answer in the same language as the user's question, regardless of the document language. This applies to the summary, headings, bullets, tables, connector labels, citations text around links, and all explanatory text. If the user's question mixes languages, follow the dominant language of the question. Do not switch to the document language unless the user explicitly asks for it. Never default to Japanese just because the documents are Japanese.
1. Summary (CRITICAL): Begin every answer with a 3-4 sentence summary that tells the user the overall conclusion, what to do first, and what kind of answer follows.
2. Completeness: Reproduce every procedure step, numeric value (torque, clearance, part number), pass/fail criterion, and explicit condition found in MAIN Document Refs. Also reproduce connector facts from CONNECTOR Document Refs when connector information is required. Do not shorten or summarize them away. From SUB Document Refs, include supporting procedures, specs, criteria, and explanations when they help answer the question; keep the amount proportional to need (key steps and values, not an unnecessary full dump of every SUB chapter).
3. Safety: Clearly mark warnings (▼) and cautions (!) at relevant steps.
4. No Hallucination: Do not write facts that are not explicitly in the provided Context.
5. No Chapter Mixing: Do not mix procedures from different chapters into one step, and only insert images that belong to the SAME Document Ref block as the text you are describing.
5b. Document Ref roles (CRITICAL) — follow CHAPTER_CLASSIFICATION_JSON and the (MAIN) / (SUB) / (CONNECTOR) labels on each Document Ref:
   - MAIN: Primary source for the answer body (procedures, specifications, explanations, images).
   - SUB: Supporting / referenced chapters. You MAY and SHOULD write SUB content into the answer when it is needed to complete the procedure, explain a cross-reference, or supply specs the user needs. Prefer a concise, useful excerpt (the relevant steps, tables, values, and warnings) rather than pasting the entire SUB chapter. Always attach that SUB ref's PDF citation token next to the SUB-derived content. If a MAIN passage says "〜を参照" / "see ...", expand the needed SUB details in place (not link-only) and still include the matching SUB PDF token. Unused SUB refs that were not quoted may be listed briefly at the end under "Related documents" / "関連資料".
   - CONNECTOR: You MAY and SHOULD write connector information in the answer body (tables, pin counts, installation position, 3D layout images) using CONNECTOR refs.
6. Structure: Choose natural headings that match the question and the Context. Do not force a fixed structure beyond what the ANSWER MODE and CONNECTOR SECTION rules below require.
7. Readability: Use Markdown tables for specification values, pin assignments, inspection steps with criteria, and parts lists with torque/clearance. Keep paragraphs short; prefer headings, bullets, and tables over walls of text.
8. Citations:
   - Cite with \`[[PDF:<ref_id>]]\` using the PDF_CITATION_TOKEN / PDF_CITATION_ID from the SAME Document Ref (e.g. [[PDF:shop-1]]). The backend inserts the real URL.
   - FORBIDDEN: writing any http(s) URL, SAS query string, or copying a long markdown link. Never invent, shorten, or re-encode a URL, and never use "#", "javascript:", or "localhost".
   - Place one citation token at the end of each procedure step or each short paragraph ONLY when that step's evidence is in that same Document Ref. Do not stamp the enclosing error-code chapter onto a step that is a cross-reference to another chapter.
   - MULTI-CODE (CRITICAL): Inside "### {CODE}", procedure citations that are not cross-refs MUST be that code's own MAIN PDF token (e.g. FAILURE CODE [CA441] steps use that code's [[PDF:shop-N]], never another code's token).
   - Each citation must come from the Document Ref that actually contains the evidence. If a sentence combines several refs, attach one token per ref.
   - If a Document Ref has no PDF_CITATION_TOKEN, write its title as plain text.
   - No links inside tables, except a "参照" / "参考" / "Reference" column.
   - Never output raw "[shop-N]" tags (use [[PDF:shop-N]] instead), decorative markers ("cite", "★", "☆", "■"), or an image file name as a citation.
9. Cross-chapter References: When a MAIN step says "〜を参照", "refer to ...", "see ...", or names another chapter (e.g. CHECKS BEFORE TROUBLESHOOTING, CHECK ELECTRIC EQUIPMENT, RELATED INFORMATION FOR TROUBLESHOOTING), include the needed content from that chapter's Document Ref (usually SUB) at an appropriate length, and cite it with that chapter's own [[PDF:shop-N]] token. Do NOT replace it with the parent FAILURE CODE chapter token. Match by title (ignore punctuation / extra brackets). If no Document Ref matches, leave the chapter name as plain text.
10. Images - you MUST NOT write image URLs; the backend inserts them:
    - Insert an image by writing \`[[IMG:<file name>]]\` on its own line, using a file name that literally appears in an "Image:" line or the "available_images" list of the SAME Document Ref.
    - FORBIDDEN: \`![name.jpg](...)\`, \`!name.jpg\`, or a bare \`name.jpg\` as a paragraph. Never invent a file name.
    - Place the token right after the sentence or step it illustrates; never collect images at the end.
    - Coverage: insert a token for every procedure step, inspection item, connector, component, and figure reference that has a matching file name in a MAIN, CONNECTOR, or SUB Document Ref whose content you are actually using. Prefer completeness for MAIN/CONNECTOR; for SUB, insert images only when they illustrate the SUB excerpt you included.
    - Do not put tokens inside tables, and do not mention the file name in the prose.
11. Required Tools: Output a "## Required Tools" table at the end when the Context lists tools or the question involves assembly, disassembly, maintenance, or diagnostics.

Context:
${combinedContext}`;
}

function buildPatternSpecificPrompt(pattern: AnswerPattern): string {
  switch (pattern) {
    case 'single_fault':
      return `

ANSWER MODE - Single Fault / One Error Code:
   - Use the structure: Overview → Preconditions → Procedure → Decision/Diagnosis → Verification.
   - Reproduce the FULL sequence of steps, criteria, numeric values, and decision branches from the Context.
   - When connector information is present, always include the connector 3D layout diagram (立体配置図) after the connector table.
`;
    case 'assembly':
      return `

ANSWER MODE - Assembly / Disassembly:
   - Provide a detailed step-by-step procedure for removal, installation, or assembly.
   - Place an image after each removal point, installation point, or critical sub-step.
`;
    case 'multi_fault':
      return `

ANSWER MODE - Multiple Fault Codes:
   - Start with the common suspected components and the first inspection points, then a shared inspection procedure if one exists.
   - Then handle each error code in its own "### {CODE}" subsection. Never infer commonality across codes: an item belongs to a common section only if the Context says it applies to ALL codes.
   - For each error-code subsection that has connector information, always include the connector 3D layout diagram (立体配置図) after that code's connector table.
`;
    case 'maintenance':
      return `

ANSWER MODE - Periodic Maintenance:
   - Immediately after the opening 3-4 sentence summary, output a compact list (or table) of the maintenance items to be performed. Do not put this list at the end.
   - Never answer with only that list. After the list, for each maintenance item give the step-by-step procedure, warnings, tools, and torque/clearance values from the Context.
   - Use tables for intervals, checks, and criteria.
`;
    case 'general':
    default:
      return `

ANSWER MODE - General / Specification:
   - Answer directly and naturally. Do not force diagnostic or tool sections when the question is only about specifications, features, usage, or general explanations.
`;
  }
}

function buildFinalAnswerSystemPromptByPatterns(
  combinedContext: string,
  patterns: AnswerPattern[],
  answerLanguage: AnswerLanguage
): string {
  const uniquePatterns = Array.from(new Set<AnswerPattern>(patterns.length > 0 ? patterns : ['general'] as AnswerPattern[]));
  const languageRule = answerLanguage === 'ja'
    ? `

Language Reinforcement:
- The user's question is Japanese. Keep all response text in Japanese.`
    : `

Language Reinforcement:
- The user's question is English. Keep all response text in English.`;
  return buildFinalAnswerSystemPromptBase(combinedContext)
    + languageRule
    + uniquePatterns.map(buildPatternSpecificPrompt).join('')
    + (hasConnectorContext(combinedContext) ? buildConnectorSectionPrompt() : '');
}

function buildManualAnswerGuidance(): string {
  return `

ANSWER MODE - Manual Integration:
   - When both shop manual and operation and maintenance manual evidence are present, synthesize one integrated answer instead of separate per-source sections.
   - If only one source contains the needed information, answer from that source.
`;
}

function buildFinalAnswerSystemPromptSingle(combinedContext: string): string {
  return buildFinalAnswerSystemPromptBase(combinedContext);
}

function buildFinalAnswerSystemPromptMulti(
  combinedContext: string,
  answerLanguage: AnswerLanguage
): string {
  const useJapanese = answerLanguage === 'ja';
  const sections = useJapanese
    ? {
        summary: '## 概要',
        commonInspection: '## 共通の点検項目',
        perCodeDiagnosis: '## 各エラーコード別の診断',
        commonComponents: '## 共通のコンポーネント',
        perCodeComponents: '## 各エラーコード別のコンポーネント',
        commonConnectors: '## 共通のコネクタ',
        perCodeConnectors: '## 各エラーコード別のコネクタ',
        requiredTools: '## Required Tools',
      }
    : {
        summary: '## Summary',
        commonInspection: '## Common Inspection Items',
        perCodeDiagnosis: '## Diagnosis by Error Code',
        commonComponents: '## Common Components',
        perCodeComponents: '## Components by Error Code',
        commonConnectors: '## Common Connector Information',
        perCodeConnectors: '## Connector Information by Error Code',
        requiredTools: '## Required Tools',
      };

  return (
    buildFinalAnswerSystemPromptBase(combinedContext) +
    `\n\n13. Multiple Error Codes (CRITICAL WHEN PRESENT):\n` +
    `   - You MUST produce a MULTI-CODE answer using the exact section headings and ordering below.\n` +
    `   - Structure for multi-code answers (use these exact section headings, in this order):\n` +
    `     1) ${sections.summary} (brief summary listing all error codes and what they share)\n` +
    `     2) ${sections.commonInspection} (inspection items that apply to ALL listed error codes; use a table: ${useJapanese ? '項目 | 手順 | 判定基準 | 参考' : 'Item | Procedure | Criteria | Reference'})\n` +
    `     3) ${sections.perCodeDiagnosis} — for EACH error code, a subsection "### {CODE}" containing its specific cause/diagnosis/action (with citations) and its specific tables.\n` +
    `     4) ${sections.commonComponents} (components shared across codes) — if applicable. Include a table: ${useJapanese ? '部品 | 役割 | 備考 | 参考' : 'Component | Role | Notes | Reference'}.\n` +
    `     5) ${sections.perCodeComponents} — per-code component info only when distinct from the common ones.\n` +
    `     6) ${sections.commonConnectors} (connectors shared across codes) — if applicable. Use the Connector table format defined in rule 11. Images from CONNECTOR refs only.\n` +
    `     7) ${sections.perCodeConnectors} — per-code connector info only when distinct.\n` +
    `     8) ${sections.requiredTools} (unchanged)\n` +
    `   - User question priority (CRITICAL):\n` +
    `     - Even in multi-code mode, the user may ask a very specific actionable question (e.g., "If harness/connector failure is suspected, what should I do?").\n` +
    `     - In that case, you MUST answer that explicit question FIRST, at the very beginning of "${sections.summary}", before you present any template-like common/per-code structure.\n` +
    `     - The first 3-8 lines of "${sections.summary}" must be a direct, actionable response (what to check, what order, pass/fail criteria when available) based ONLY on the provided Context, with inline citations.\n` +
    `     - After that direct response, continue the rest of the multi-code structure normally.\n` +
    `   - Common vs per-code separation (CRITICAL):\n` +
    `     - You may place an item in a 共通 section ONLY if the context explicitly states that it applies to ALL listed error codes.\n` +
    `     - If you cannot confirm an item is common to ALL codes, do NOT put it in a 共通 section. Put it under the relevant per-code section(s) instead.\n` +
    `     - If there are no confirmed common items, write "${useJapanese ? '共通項目: なし' : 'No common items'}" and continue with per-code sections.\n` +
    `     - NEVER infer or guess commonality across codes.\n` +
    `   - Detail level (CRITICAL): Each per-code diagnostic subsection must be as detailed as a single-error-code answer: include full steps, criteria, values, and citations.\n` +
    buildManualAnswerGuidance()
  );
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
3. Be as specific as possible and include low-level paths whenever they are relevant.
4. Do NOT return titles. Return path values only.
5. Be helpful but not exhaustive. This is the INITIAL path selection.
6. Maintenance (OMM / 取扱説明書): If the query is about maintenance, メンテナンス, periodic maintenance, or 定期点検, and a Maintenance/Periodic Maintenance parent exists, also include its child maintenance item/detail paths, not just the schedule/interval parent.
7. If no TOC is provided, return "chapters": [].

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
    ]);

    const queries = Array.isArray(response?.queries) && response.queries.length > 0
      ? response.queries.map((q) => String(q || '').trim()).filter(Boolean)
      : [userQuery];
    const chapters = hasToc && Array.isArray(response?.chapters)
      ? response.chapters.map((c) => String(c || '').trim()).filter(Boolean)
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

export async function selectTOCChaptersInitial(
  queries: string[],
  userQuery: string,
  tocContent: string
): Promise<TOCChaptersResponse> {
  const combined = await generateSearchQueriesAndInitialToc(userQuery, tocContent, []);
  // Prefer chapters from the combined call; queries arg is retained for API compatibility.
  void queries;
  return { chapters: combined.chapters };
}

export async function generateSearchQueries(userQuery: string, chatHistory: any[] = []): Promise<SearchQueriesResponse> {
  const combined = await generateSearchQueriesAndInitialToc(userQuery, '', chatHistory);
  return { queries: combined.queries, has_codes: combined.has_codes };
}

async function chatJson<T>(
  messages: ChatMessage[],
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = CHAT_REASONING_EFFORT
): Promise<T> {
  // Prefer Foundry inference endpoint; fallback to Azure OpenAI Responses API if configured.
  if (config.aiInference.endpoint) {
    const endpoint = requireNonEmpty(getChatEndpoint(), 'AZURE_AI_INFERENCE_ENDPOINT');
    const model = requireNonEmpty(getChatModel(), 'AZURE_OPENAI_DEPLOYMENT');
    const client = getInferenceClient(endpoint);
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
    return JSON.parse(content) as T;
  }

  if (config.azureOpenAI.endpoint && isAzureResponsesUrl(config.azureOpenAI.endpoint)) {
    return responsesJson<T>(messages, reasoningEffort);
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
2. Select up to 30 most relevant paths.
3. Prefer leaf-level / deepest / most specific paths over parent paths.
4. You MUST be exhaustive, not conservative. If a relevant low-level path exists in the TOC, include it.
5. Do NOT return titles. Return path values only.
6. Do not re-select a TOC path or title that already appears in Already Searched Chapters. If a previously searched parent is already covered, still include a child path only when that child itself was not searched and is needed.
7. Fault codes: For each error code in the queries, include ALL TOC paths that contain that error code, except those already searched.
8. Connectors: If connectors are present, include the connector list/layout path(s) AND ALL related 3D layout diagram paths in the TOC series. Do NOT stop at (1) or (2).
   - Match chapter titles that mention connector list and layout, connector layout, connector location, 3D立体配置図, or 3D layout diagram.
   - If the TOC series has multiple numbered entries such as (1), (2), and (3), include the whole series when they are connector layout/location or 3D diagram chapters.
9. Inspections: If the query is diagnosis/inspection oriented, include prerequisite paths such as pre-diagnostic inspection and electrical inspection when present.
10. Components: If components are present, include paths that likely describe the location or explanation of those components.
11. Maintenance (OMM / 取扱説明書): If the query is about maintenance, メンテナンス, periodic maintenance, or 定期点検, and the TOC contains a "Maintenance" or "Periodic Maintenance" section, do NOT stop at the schedule/interval parent path. Also include the child / lower-level paths that describe specific maintenance items, procedures, inspection details, and adjustment/replacement steps under that maintenance tree.
12. Explicit referenced titles: If a search query is itself a chapter title (or a close match to one TOC path), include that exact path. Do not substitute a sibling or parent (e.g. do not replace TEST ENGINE OIL PRESSURE with TEST ENGINE RELATED PARTS).
13. Return JSON only.

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
    ]);

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

export async function judgeAnswerability(
  userQuery: string,
  queries: string[],
  searchResults: any[]
): Promise<AnswerabilityResponse> {
  try {
    // Build context from search results
    const context = searchResults.slice(0, 10).map((r, i) => 
      `Chapter ${i + 1} (${r.TOC}):\n${r.content}`
    ).join('\n\n');
    
    return await chatJson<AnswerabilityResponse>([
      {
        role: 'system',
        content:
          'You are a document relevance judge. Determine if the provided document excerpts contain enough information to answer the user question. Output JSON format: {"answerable": true/false, "reason": "explanation"}',
      },
      {
        role: 'user',
        content: `User Query: ${userQuery}\n\nQueries: ${JSON.stringify(queries)}\n\nDocument Excerpts:\n${context}`,
      },
    ]);
  } catch (error) {
    console.error('Error judging answerability:', error);
    return { answerable: false, reason: 'Error occurred' };
  }
}

export async function extractElements(
  userQuery: string,
  textContext: string,
  chatHistory: any[] = []
): Promise<ExtractedElements> {
  try {
    // Build chat history context
    const historyContext = chatHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
    
    const response = await chatJson<ExtractedElements>([
      {
        role: 'system',
        content:
`You are an expert in analyzing technical documents in Japanese and English. Based only on the user query and the provided Document Content, determine whether additional search is needed and extract the information required for that search. Also decide whether the user is asking about multiple error codes.

## Output Format

Return a JSON object with all fields:

{
"error_codes": [],
"connectors": [],
"reference_chapters": [],
"diagnostic_chapters": [],
"components": [],
"reasoning": "",
"needs_followup": false,
"is_multi_error_codes": false,
"multi_error_codes": [],
"multi_error_reason": ""
}

## Extraction Rules

* Focus only on the user query: "${userQuery}".
* Do not invent information that is not explicitly stated in the Document Content.
* If the provided content is TOC-like or chapter-list-like, prefer extracting chapter titles exactly as they appear instead of rewriting them.
* When Retrieved Chapter Content contains "see", "refer to", "for details, see", or "〜を参照", extract those destination chapter titles into reference_chapters even if they also appear in the TOC. Do not skip them just because they are mentioned in the already-retrieved body text.
* error_codes: Extract explicit error or failure codes only when sufficient information about them has not already been found in the Document Content.
* connectors: Extract connector IDs when the user query is about error codes, fault diagnosis, troubleshooting, inspection, wiring, or connectors.
  - Primary source: chapter BODY text in Retrieved Chapter Content (diagnostic/troubleshooting chapters). Extract every connector ID explicitly mentioned in prose or tables there.
  - Common ID formats: E08, E12, J1, VE03, AC01, T01 (letter(s) + digits). Even when the word "connector"/"コネクタ" is absent, treat such IDs as connectors when they appear in diagnostic procedure text or connector-related table rows.
  - Also include connector IDs the user explicitly names in the query when the query is connector/diagnostic related.
  - FORBIDDEN sources: image captions, OCR, figure callouts, 3D layout diagram labels, connector-list catalog chapter titles, and copying an entire connector catalog.
  - Do NOT include connector list/layout or 3D layout diagram chapter names in this field; those belong in reference_chapters only when diagnostic follow-up is needed.
* reference_chapters: Extract chapter or section titles explicitly referenced by phrases such as "see", "refer to", "for details, see", or "〜を参照". Include titles such as TEST ENGINE OIL PRESSURE, CHECKS BEFORE TROUBLESHOOTING, and CHECK ELECTRIC EQUIPMENT when they are named as a reference. For fault diagnosis, also include connector list/layout and 3D layout diagram chapter titles when diagnostic chapters mention connectors or when connector IDs were found in chapter body text. Do NOT include unrelated connector chapters for weight, maintenance, assembly/disassembly, or specification queries.
* diagnostic_chapters: Extract chapter titles that are explicitly related to troubleshooting, diagnosis, or inspection.
* components: Extract up to two primary components involved.
* reasoning: Briefly explain what information is available and what is missing.

## needs_followup Rules

* If the user query is not related to troubleshooting, diagnosis, inspection, or a check procedure, set needs_followup to false.
* If the query is related to troubleshooting, diagnosis, inspection, or a check procedure, set needs_followup to true when either:

  * the current Document Content is insufficient, or
  * any value is extracted into error_codes, connectors, reference_chapters, or diagnostic_chapters.

## Multiple error-code Rules
* Decide if the query is about diagnosing TWO OR MORE distinct error codes.
* Use only information present in the User Query, Chat History, and Document Content / extracted error_codes.
* Do NOT invent error codes.
* Normalize codes (trim spaces, keep original casing) and deduplicate.
* Set is_multi_error_codes true only for two or more distinct codes that the user is diagnosing together.
* multi_error_codes: the list of those codes when is_multi_error_codes is true; otherwise [].
* multi_error_reason: short explanation of the multi-code decision.

Return JSON only.`,
      },
      {
        role: 'user',
        content: `User Query: ${userQuery}

Chat History:
${historyContext}

Document Content / TOC:
${textContext}`,
      },
    ]);

    const errorCodes = Array.isArray(response?.error_codes)
      ? response.error_codes.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    const multiCodesRaw = Array.isArray(response?.multi_error_codes)
      ? response.multi_error_codes.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    const multiCodes = Array.from(new Set(multiCodesRaw.length > 0 ? multiCodesRaw : errorCodes));
    const isMulti = !!response?.is_multi_error_codes && multiCodes.length >= 2;

    return {
      error_codes: errorCodes,
      connectors: Array.isArray(response?.connectors) ? response.connectors : [],
      reference_chapters: Array.isArray(response?.reference_chapters) ? response.reference_chapters : [],
      diagnostic_chapters: Array.isArray(response?.diagnostic_chapters) ? response.diagnostic_chapters : [],
      components: Array.isArray(response?.components) ? response.components : [],
      reasoning: typeof response?.reasoning === 'string' ? response.reasoning : '',
      needs_followup: !!response?.needs_followup,
      is_multi_error_codes: isMulti,
      multi_error_codes: isMulti ? multiCodes : [],
      multi_error_reason: typeof response?.multi_error_reason === 'string'
        ? response.multi_error_reason
        : (isMulti ? 'multiple error codes detected' : 'single or no error code'),
    };
  } catch (error) {
    console.error('Error extracting elements:', error);
    return {
      error_codes: [],
      connectors: [],
      reference_chapters: [],
      diagnostic_chapters: [],
      components: [],
      reasoning: 'Error occurred',
      needs_followup: false,
      is_multi_error_codes: false,
      multi_error_codes: [],
      multi_error_reason: 'fallback: extraction failed',
    };
  }
}

export async function detectMultiErrorCodes(
  userQuery: string,
  extractedErrorCodes: string[] = [],
  chatHistory: any[] = []
): Promise<MultiErrorCodeDetection> {
  // Kept for compatibility. Prefer extractElements(), which now includes multi-error detection.
  void userQuery;
  void chatHistory;
  const unique = Array.from(new Set((extractedErrorCodes || []).filter(Boolean)));
  return {
    is_multi_error_codes: unique.length >= 2,
    error_codes: unique,
    reason: unique.length >= 2
      ? 'fallback: derived from extracted error codes (merged into extractElements)'
      : 'fallback: fewer than two extracted error codes',
  };
}

export async function classifyChapters(
  userQuery: string,
  chapterList: any[],
  referenceChapters: string[] = []
): Promise<ChapterClassification> {
  try {
    const referencedTitles = referenceChapters.map((title) => String(title || '').trim()).filter(Boolean);
    return await chatJson<ChapterClassification>([
      {
        role: 'system',
        content: 'You are an expert in classifying technical documents. Prefer IGNORE when a chapter is not clearly relevant to the user question, except for explicitly referenced chapters and connector-related chapters.',
      },
      {
        role: 'user',
        content: `Classify each chapter based on how useful it is for answering the user's question.

User Question

${userQuery}

Explicitly referenced chapters (from MAIN text "see" / "refer to" / "〜を参照")
These MUST be SUB (or MAIN if they directly answer the question). Never IGNORE them to make room for other chapters.
Match loosely: "Electrical equipment" matches CHECK ELECTRIC EQUIPMENT; "CHECKS BEFORE TROUBLESHOOTING" matches that TOC title.

${JSON.stringify(referencedTitles, null, 2)}

Chapter List

${JSON.stringify(chapterList, null, 2)}

Categories
MAIN: Chapters containing direct answers, procedures, specifications, locations, or keywords from the user question.
SUB: Chapters that support, explain, or are explicitly referenced by MAIN chapters. Maximum 10 chapters. Fill SUB first with explicitly referenced chapters, then other supporting chapters.
CONNECTOR: Relevant connector lists, connector tables, wiring/layout diagrams, or connector location chapters. Use only when connector relevance is explicit. Prefer CONNECTOR LIST AND LAYOUT and 3D layout / location chapters over generic circuit diagrams when slots are limited.
IGNORE: Chapters unrelated to the user question or only loosely related.
Rules
Classify chapters that directly answer "how", "where", or specification questions as MAIN.
Chapters containing error codes, component names, or other keywords from the user question should be MAIN only when they clearly help answer the user question.
If multiple chapters contain the same information, classify the most detailed one as MAIN.
Any chapter explicitly referenced by another relevant chapter, or listed in Explicitly referenced chapters, must be at least SUB. Do not drop them because SUB is full — drop loosely related chapters instead.
Use chapter content, image_captions, and image_ocr_texts as classification evidence.
Treat IDs such as E08, J1, or VE03 as connector IDs when relevant.
When connectors are relevant, include the applicable connector list/table and corresponding layout or location chapters in CONNECTOR.
If related connector layout chapters are numbered, such as "(1)", "(2)", and "(3)", include all available entries in the series.
If none of the chapters clearly match the user question, put all chapters into IGNORE rather than forcing them into MAIN, SUB, or CONNECTOR.
If a chapter is not clearly useful for the answer, choose IGNORE — except explicitly referenced chapters and connector list/layout chapters.
Every chapter index must appear in exactly one category.
Output Format

Return JSON only, using index numbers:

{
"main": [0, 1],
"connector": [4],
"sub": [2],
"ignore": [3]
}`,
      },
    ], FINAL_ANSWER_REASONING_EFFORT);
  } catch (error) {
    console.error('Error classifying chapters:', error);
    return { main: [], connector: [], sub: [], ignore: [] };
  }
}

export async function classifyAnswerPatterns(
  userQuery: string,
  chatHistory: any[] = [],
  extractedElements: ExtractedElements | null = null,
  multiError: { isMulti: boolean; codes?: string[] } = { isMulti: false }
): Promise<AnswerPatternResponse> {
  const historyContext = chatHistory.slice(-4).map((m) => `${m.role}: ${m.content}`).join('\n');
  const extractedContext = extractedElements
    ? JSON.stringify(
        {
          error_codes: extractedElements.error_codes || [],
          connectors: extractedElements.connectors || [],
          components: extractedElements.components || [],
          reference_chapters: extractedElements.reference_chapters || [],
          diagnostic_chapters: extractedElements.diagnostic_chapters || [],
          needs_followup: extractedElements.needs_followup,
        },
        null,
        2
      )
    : 'null';

  try {
    const response = await chatJson<AnswerPatternResponse>([
      {
        role: 'system',
        content:
          'You are an expert at classifying how a user wants the final answer to be structured. Return one or more answer patterns from this allowed list: single_fault, assembly, multi_fault, maintenance, general. Choose all patterns that apply. Return JSON only.',
      },
      {
        role: 'user',
        content: `User Query: ${userQuery}

Recent Chat History:
${historyContext}

Extracted Elements:
${extractedContext}

Multi Error Context:
${JSON.stringify(multiError)}

## Pattern Guidance
- single_fault: one fault code or one troubleshooting target, diagnose a single issue.
- assembly: disassembly / assembly / removal / installation / teardown / reassembly / procedure-focused questions.
- multi_fault: multiple error codes, shared symptoms, shared inspection points, or questions asking where to inspect first across several faults.
- maintenance: periodic maintenance, inspection interval, service interval, replacement schedule, routine checks.
- general: specification, usage, explanation, location lookup, or non-diagnostic questions.

## Output Format
{
  "patterns": ["single_fault", "assembly"],
  "reason": "short explanation"
}

Return JSON only.`,
      },
    ]);

    const unique = Array.from(new Set((response.patterns || []).filter(Boolean)));
    return {
      patterns: unique.length > 0 ? unique : ['general'],
      reason: response.reason || '',
    };
  } catch (error) {
    console.error('Error classifying answer patterns:', error);

    const q = userQuery.toLowerCase();
    const codes = Array.isArray(multiError?.codes) ? multiError.codes : [];
    const patterns: AnswerPattern[] = [];

    if (multiError?.isMulti || codes.length >= 2 || /[,、\/]/.test(userQuery) && /(error|fault|code|エラー|故障|異常)/i.test(userQuery)) {
      patterns.push('multi_fault');
    }
    if (/(分解|組立|組み立て|脱着|取り外し|取り付け|disassembl|assemble|remove|install|replacement|交換手順)/i.test(userQuery)) {
      patterns.push('assembly');
    }
    if (/(定期|日常|periodic|maintenance|点検周期|service interval|交換時期)/i.test(userQuery)) {
      patterns.push('maintenance');
    }
    if ((/(error|fault|code|故障|診断|点検|トラブル|troubleshoot|inspection)/i.test(userQuery) || (extractedElements?.error_codes || []).length > 0) && !patterns.includes('multi_fault') && !/(分解|組立|組み立て|脱着|取り外し|取り付け|disassembl|assemble|remove|install)/i.test(userQuery)) {
      patterns.push('single_fault');
    }
    if (patterns.length === 0) {
      patterns.push('general');
    }

    return {
      patterns: Array.from(new Set(patterns)),
      reason: 'fallback: pattern classification failed',
    };
  }
}

function buildMultiErrorAnswerPrompt(answerLanguage: AnswerLanguage): string {
  const useJapanese = answerLanguage === 'ja';
  const headings = useJapanese
    ? {
        summary: '## 概要',
        commonInspection: '## 共通の点検項目',
        perCodeDiagnosis: '## 各エラーコード別の診断',
        commonComponents: '## 共通のコンポーネント',
        perCodeComponents: '## 各エラーコード別のコンポーネント',
        commonConnectors: '## 共通のコネクタ',
        perCodeConnectors: '## 各エラーコード別のコネクタ',
        requiredTools: '## Required Tools',
      }
    : {
        summary: '## Summary',
        commonInspection: '## Common Inspection Items',
        perCodeDiagnosis: '## Diagnosis by Error Code',
        commonComponents: '## Common Components',
        perCodeComponents: '## Components by Error Code',
        commonConnectors: '## Common Connector Information',
        perCodeConnectors: '## Connector Information by Error Code',
        requiredTools: '## Required Tools',
      };

  return `

MULTIPLE ERROR CODES (MANDATORY STRUCTURE):
   - Use exactly these section headings, in this order:
     1) ${headings.summary} — list all error codes and what they share.
     2) ${headings.commonInspection} — items that apply to ALL codes. Table: ${useJapanese ? '項目 | 手順 | 判定基準 | 参考' : 'Item | Procedure | Criteria | Reference'}.
     3) ${headings.perCodeDiagnosis} — one "### {CODE}" subsection per code, each as detailed as a single-code answer (full steps, criteria, values). Citations in that subsection must be that code's MAIN [[PDF:shop-N]] token except when a step cross-references another chapter, in which case use that chapter's token.
     4) ${headings.commonConnectors} — only connector numbers that appear in MAIN \`context:\` for ALL codes. Never take extra IDs from image Caption/OCR or from a full connector-list catalog (see the CONNECTOR SECTION rules).
     5) ${headings.perCodeConnectors} — one "### {CODE}" subsection per code that has a MULTI_ERROR_CONNECTOR_<CODE> block, each with its own connector table AND its own 3D layout image(s) right after the table.
     6) ${headings.commonComponents} — table: ${useJapanese ? '部品 | 役割 | 備考 | 参考' : 'Component | Role | Notes | Reference'}.
     7) ${headings.perCodeComponents} — only when distinct from the common ones.
     8) ${headings.requiredTools}
   - Context blocks: MULTI_ERROR_CONNECTOR_COMMON holds connectors shared by all codes; MULTI_ERROR_CONNECTOR_<CODE> holds connectors for one code. A connector from a <CODE> block must stay in that code's subsection.
   - Common vs per-code: place an item in a common section ONLY if the Context explicitly says it applies to ALL codes. Never infer commonality. If there are none, write "${useJapanese ? '共通項目: なし' : 'No common items'}" and continue.
   - If the user asked a specific actionable question (e.g. "what should I do if a harness fault is suspected?"), answer it directly in the first 3-8 lines of ${headings.summary}, then continue with the structure above.
`;
}

function buildFinalAnswerSystemPromptForRequest(
  combinedContext: string,
  answerLanguage: AnswerLanguage,
  patterns: AnswerPattern[] = ['general'],
  multiError: { isMulti: boolean; codes?: string[] } = { isMulti: false },
  manualMode: boolean = false
): string {
  const uniquePatterns = Array.from(new Set<AnswerPattern>(patterns.length > 0 ? patterns : ['general'] as AnswerPattern[]));
  let prompt = buildFinalAnswerSystemPromptBase(combinedContext) + uniquePatterns.map(buildPatternSpecificPrompt).join('');
  prompt += answerLanguage === 'ja'
    ? `\n\nLanguage Reinforcement: The user asked in Japanese, so the entire answer must remain in Japanese.`
    : `\n\nLanguage Reinforcement: The user asked in English, so the entire answer must remain in English.`;
  if (manualMode) {
    prompt += buildManualAnswerGuidance();
  }
  if (multiError?.isMulti) {
    prompt += buildMultiErrorAnswerPrompt(answerLanguage);
  }
  // Connector rules depend on the Context, not on the classified pattern, so a
  // fault-code question never loses its connector table because of misclassification.
  if (hasConnectorContext(combinedContext)) {
    prompt += buildConnectorSectionPrompt(multiError, uniquePatterns);
  }
  return prompt;
}

async function classifyAnswerLanguage(userQuery: string, chatHistory: any[] = []): Promise<AnswerLanguage> {
  const trimmed = `${userQuery}\n${chatHistory.slice(-2).map((m) => m.content || '').join('\n')}`.trim();
  return /[ぁ-んァ-ヶ一-龯]/.test(trimmed) ? 'ja' : 'en';
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

export const __testRenderImageReferences = renderImageReferences;

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
function createStreamingAssetRenderer(
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

export async function streamFinalAnswer(
  userQuery: string,
  combinedContext: string,
  chatHistory: any[] = [],
  patterns: AnswerPattern[] = ['general'],
  multiError: { isMulti: boolean; codes?: string[] } = { isMulti: false },
  manualMode: boolean = false,
  onChunk: (chunk: string) => void,
  imageUrls?: string[],
  imageSasUrlMap?: Map<string, string>,
  pdfTokenMap?: Map<string, string>,
  reasoningEffort: typeof CHAT_REASONING_EFFORT | typeof FINAL_ANSWER_REASONING_EFFORT = FINAL_ANSWER_REASONING_EFFORT,
  streamHooks?: {
    onModelFirstToken?: (msFromAnswerStart: number) => void;
    onHoldChange?: (holding: boolean) => void;
  }
): Promise<string> {
  try {
    let fullAnswer = '';
    let modelFirstTokenReported = false;
    let answerCallStartedAt = 0;
    const noteModelFirstToken = () => {
      if (modelFirstTokenReported) return;
      modelFirstTokenReported = true;
      const started = answerCallStartedAt || Date.now();
      streamHooks?.onModelFirstToken?.(Math.max(0, Date.now() - started));
    };
    const historyMessages = chatHistory.slice(-4).map(m => ({
      role: m.role,
      content: m.content,
    }));
    const assetLookup = extractFinalAnswerAssetLookup(combinedContext);
    if (pdfTokenMap) {
      for (const [refId, markdown] of pdfTokenMap) {
        assetLookup.pdfByRefId.set(refId.toLowerCase(), markdown);
        const parsed = markdown.match(/^\[([^\]]+)\]\(<([^>]+)>\)$/) || markdown.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (parsed) {
          const title = parsed[1].trim();
          const url = parsed[2].trim();
          addPdfAliases(assetLookup.pdfByTitle, title, url);
          assetLookup.pdfLinkTitles.push({ label: title, url });
        }
      }
    }
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      for (const url of imageUrls) {
        try {
          const urlWithoutParams = url.split('?')[0];
          const decoded = decodeURIComponent(urlWithoutParams);
          const basename = decoded.split('/').pop() || '';
          if (basename) {
            assetLookup.imageUrlToBasename.set(url, basename);
            addImageAliases(assetLookup.imageByTitle, basename, url);
          }
        } catch {
          // ignore malformed URLs
        }
      }
    }
    const answerLanguage = await classifyAnswerLanguage(userQuery, chatHistory);
    
    const systemPrompt = buildFinalAnswerSystemPromptForRequest(combinedContext, answerLanguage, patterns, multiError, manualMode);

    if (config.aiInference.endpoint) {
      const endpoint = requireNonEmpty(getChatEndpoint(), 'AZURE_AI_INFERENCE_ENDPOINT');
      const model = requireNonEmpty(getChatModel(), 'AZURE_OPENAI_DEPLOYMENT');
      const client = getInferenceClient(endpoint);
      answerCallStartedAt = Date.now();
      const response = await client
        .path('/chat/completions')
        .post({
          body: {
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...historyMessages,
              { role: 'user', content: userQuery },
            ],
            stream: true,
            reasoning_effort: reasoningEffort,
          } as any,
        })
        .asNodeStream();

      const stream = response.body;
      if (!stream) {
        throw new Error('The response stream is undefined');
      }
      if (response.status !== '200') {
        let errorBody = '';
        try {
          for await (const chunk of stream as any) {
            errorBody += chunk.toString();
          }
        } catch {}
        throw new Error(`Chat completion request failed with status ${response.status}: ${errorBody}`);
      }

      const assetRenderer = createStreamingAssetRenderer(
        imageSasUrlMap,
        pdfTokenMap,
        streamHooks?.onHoldChange
      );
      const emitChunk = (text: string) => {
        const ready = assetRenderer.feed(text);
        if (ready) onChunk(ready);
      };

      const sses = createSseStream(stream as IncomingMessage);
      for await (const event of sses) {
        if (event.data === '[DONE]') {
          break;
        }
        const payload = JSON.parse(event.data);
        for (const choice of payload.choices ?? []) {
          const content = choice.delta?.content ?? '';
          if (content) {
            noteModelFirstToken();
            fullAnswer += content;
            emitChunk(content);
          }
        }
      }
      const tail = assetRenderer.flush();
      if (tail) onChunk(tail);

      const rewrittenAnswer = renderImageReferences(
        rewriteFinalAnswerArtifacts(fullAnswer, assetLookup),
        imageSasUrlMap
      );
      logFinalAnswer(rewrittenAnswer, extractFinalAnswerArtifacts(rewrittenAnswer));
      return rewrittenAnswer;
    }

    if (config.azureOpenAI.endpoint && isAzureResponsesUrl(config.azureOpenAI.endpoint)) {
      const assetRenderer = createStreamingAssetRenderer(
        imageSasUrlMap,
        pdfTokenMap,
        streamHooks?.onHoldChange
      );
      answerCallStartedAt = Date.now();
      const fullAnswerFromResponses = await streamResponses(
        userQuery,
        systemPrompt,
        historyMessages as any,
        (text: string) => {
          noteModelFirstToken();
          const ready = assetRenderer.feed(text);
          if (ready) onChunk(ready);
        },
        reasoningEffort
      );
      const tail = assetRenderer.flush();
      if (tail) onChunk(tail);

      const rewrittenAnswer = renderImageReferences(
        rewriteFinalAnswerArtifacts(fullAnswerFromResponses, assetLookup),
        imageSasUrlMap
      );
      logFinalAnswer(rewrittenAnswer, extractFinalAnswerArtifacts(rewrittenAnswer));
      return rewrittenAnswer;
    }

    throw new Error('No chat endpoint configured for streaming.');
  } catch (error) {
    console.error('Error streaming final answer:', error);
    onChunk('\n\nAn error occurred while generating the answer.');
    return '';
  }
}
