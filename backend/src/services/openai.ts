import ModelClient, { isUnexpected } from '@azure-rest/ai-inference';
import { AzureKeyCredential } from '@azure/core-auth';
import { DefaultAzureCredential } from '@azure/identity';
import { createSseStream } from '@azure/core-sse';
import type { IncomingMessage } from 'node:http';
import { config } from '../config';
import {
  SearchQueriesResponse,
  TOCChaptersResponse,
  AnswerabilityResponse,
  AnswerPattern,
  AnswerPatternResponse,
  ExtractedElements,
  ChapterClassification,
} from '../types';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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

async function responsesJson<T>(messages: ChatMessage[]): Promise<T> {
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

async function streamResponses(userQuery: string, systemPrompt: string, historyMessages: ChatMessage[], onChunk: (chunk: string) => void): Promise<string> {
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
        // Best-effort extraction across possible event shapes
        const deltaText =
          evt?.delta?.content?.[0]?.text ||
          evt?.response?.output_text ||
          evt?.output_text ||
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
};

function normalizeAssetTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
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

  for (const rawLine of contextText.split(/\r?\n/)) {
    const line = rawLine.trim();

    const pdfMarkdownMatch = line.match(/^PDF_CITATION_MARKDOWN:\s*\[([^\]]+)\]\(<([^>]+)>\)$/);
    if (pdfMarkdownMatch) {
      pdfByTitle.set(normalizeAssetTitle(pdfMarkdownMatch[1]), pdfMarkdownMatch[2]);
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

  return { imageByTitle, imageUrlToBasename, pdfByTitle };
}

function rewriteFinalAnswerArtifacts(answerText: string, lookup: FinalAnswerAssetLookup): string {
  let rewritten = answerText;

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

  rewritten = rewritten.replace(/\[([^\]]+)\]\((<[^>]+>|[^)]+)\)/g, (match, titleRaw, urlRaw) => {
    const title = String(titleRaw || '').trim();
    const normalizedTitle = normalizeAssetTitle(title);
    const canonicalUrl = lookup.pdfByTitle.get(normalizedTitle);
    if (!canonicalUrl) {
      // Drop links that do not correspond to a known Document Ref (e.g., # or localhost).
      return title;
    }

    const url = String(urlRaw || '').trim();
    const existing = url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url;
    if (canonicalUrl !== existing) {
      return `[${title}](<${canonicalUrl}>)`;
    }
    return match;
  });

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

  const linkRegex = /\[([^\]]+)\]\((<[^>]+>|[^)]+)\)/g;
  for (const match of answerText.matchAll(linkRegex)) {
    const title = (match[1] || '').trim();
    const rawUrl = (match[2] || '').trim();
    const url = rawUrl.startsWith('<') && rawUrl.endsWith('>') ? rawUrl.slice(1, -1) : rawUrl;
    if (!url) continue;
    if (/^https?:\/\//i.test(url) === false) continue;
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

export async function detectMultiErrorCodes(
  userQuery: string,
  extractedErrorCodes: string[] = [],
  chatHistory: any[] = []
): Promise<MultiErrorCodeDetection> {
  try {
    const historyContext = chatHistory
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    return await chatJson<MultiErrorCodeDetection>([
      {
        role: 'system',
        content: `You are an assistant that detects whether the user is asking about multiple error codes.

Rules:
1. Decide if the query is about diagnosing TWO OR MORE distinct error codes.
2. Use only information present in the User Query, Recent Chat History, and Extracted Error Codes.
3. Do NOT invent error codes.
4. Normalize codes (trim spaces, keep original casing) and deduplicate.
5. Return JSON only.

Output JSON format:
{
  "is_multi_error_codes": true,
  "error_codes": ["CA441", "CA442"],
  "reason": "..."
}`,
      },
      {
        role: 'user',
        content: `User Query:\n${userQuery}\n\nExtracted Error Codes (from previous step):\n${JSON.stringify(
          extractedErrorCodes
        )}\n\nRecent Chat History (most recent last):\n${historyContext}`,
      },
    ]);
  } catch (error) {
    console.error('Error detecting multi error codes:', error);
    const unique = Array.from(new Set((extractedErrorCodes || []).filter(Boolean)));
    return {
      is_multi_error_codes: unique.length >= 2,
      error_codes: unique,
      reason: 'fallback: detection failed',
    };
  }
}

function hasConnectorContext(combinedContext: string): boolean {
  return /(?:^|\n)EXTRACTED_CONNECTORS:\s*(?!\n)\S/.test(combinedContext) || /\(CONNECTOR\)/.test(combinedContext);
}

function buildConnectorSectionPrompt(multiError: { isMulti: boolean; codes?: string[] } = { isMulti: false }): string {
  const codes = Array.isArray(multiError.codes) ? multiError.codes.filter(Boolean) : [];
  const perCodeRule = multiError.isMulti && codes.length >= 2
    ? `
   - MULTI-CODE: output one connector subsection per error code, "### {CODE}", each with its OWN table in the format above AND its own 3D layout image(s) immediately after that table. Add a "共通のコネクタ" subsection only for connectors the Context explicitly states apply to ALL codes.
   - Error codes in this answer: ${codes.join(', ')}.`
    : '';

  return `

CONNECTOR SECTION (MANDATORY - the Context contains connector information):
   - Output a section "## Related Connector Information" just before "## Required Tools". This is mandatory whenever the Context has "EXTRACTED_CONNECTORS:" or any Document Ref labeled (CONNECTOR), for ANY kind of question. Never omit it.
   - The table MUST have exactly these 5 columns, in this order, with this exact header. No extra, missing, renamed, reordered, merged, or translated columns:
| Connector No. | Connector Type | Number of pins | Installation position | Address |
|---|---|---|---|---|
   - One row per connector. Fill unknown cells with "不明（提示された資料に記載なし）". Never drop a row just because fields are unknown; if no connector number is identifiable, still output at least one row.
   - Do NOT put links, citations, or images inside the table. Put citations in the text around the table, using ONLY Document Refs labeled (CONNECTOR).
   - IMMEDIATELY after the table, insert the 3D layout diagram image(s) with [[IMG:<file name>]] tokens, one token per line.
     - Use ONLY file names from Document Refs labeled (CONNECTOR); never from error-code or troubleshooting chapters.
     - Pick images whose caption/OCR indicates a layout/location view (コネクタ立体配置図, 立体配置図, connector layout, connector location, 3D diagram) AND that mention the same connector number as a table row.
     - Insert TWO OR MORE images when several are needed to cover all rows (e.g., a "(1)(2)(3)" series or different mounting locations).
     - If a CONNECTOR Document Ref lists any image file name, you MUST insert at least one image here.
     - A wiring/circuit diagram (回路図, 配線図, wiring diagram, circuit diagram, schematic) is NOT a valid substitute. If only those exist, insert no image and write: "立体配置図は提示された資料内で確認できません（回路図/配線図は代替として使用しません）".${perCodeRule}
   - If the Context includes a non-empty "EXTRACTED_COMPONENTS:" line, also output "## Related Component Information" listing each component with its location/mounting info and citations, placed after the connector section.
`;
}

function buildFinalAnswerSystemPromptBase(combinedContext: string): string {
  return `You are an assistant supporting a mechanical engineer. Your task is to provide comprehensive and accurate answers by integrating the provided documents (text and images).

Answer Creation Rules:
0. Language (CRITICAL / ABSOLUTE HIGHEST PRIORITY): Always write the entire answer in the same language as the user's question, regardless of the document language. This applies to the summary, headings, bullets, tables, connector labels, citations text around links, and all explanatory text. If the user's question mixes languages, follow the dominant language of the question. Do not switch to the document language unless the user explicitly asks for it. Never default to Japanese just because the documents are Japanese.
1. Summary (CRITICAL): Begin every answer with a 3-4 sentence summary that tells the user the overall conclusion, what to do first, and what kind of answer follows.
2. Completeness: Reproduce every procedure step, numeric value (torque, clearance, part number), pass/fail criterion, and explicit condition found in MAIN Document Refs. Also reproduce connector facts from CONNECTOR Document Refs when connector information is required. Do not shorten or summarize them away. Do NOT reproduce procedure text, tables, or explanations from SUB Document Refs.
3. Safety: Clearly mark warnings (▼) and cautions (!) at relevant steps.
4. No Hallucination: Do not write facts that are not explicitly in the provided Context.
5. No Chapter Mixing: Do not mix procedures from different chapters into one step, and only insert images that belong to the SAME Document Ref block as the text you are describing.
5b. Document Ref roles (CRITICAL) — follow CHAPTER_CLASSIFICATION_JSON and the (MAIN) / (SUB) / (CONNECTOR) labels on each Document Ref:
   - MAIN: Write the answer body from these refs (procedures, specifications, explanations, images).
   - SUB: Do NOT write SUB chapter content as answer prose, steps, tables, or images. For each SUB ref, display only its PDF_CITATION_MARKDOWN (the PDF link). If a MAIN passage says "〜を参照" / "see ...", turn that mention into the matching SUB PDF link. Unused SUB links may be listed at the end under a short "Related documents" / "関連資料" heading that contains links only.
   - CONNECTOR: You MAY and SHOULD write connector information in the answer body (tables, pin counts, installation position, 3D layout images) using CONNECTOR refs. CONNECTOR is not treated like SUB.
6. Structure: Choose natural headings that match the question and the Context. Do not force a fixed structure beyond what the ANSWER MODE and CONNECTOR SECTION rules below require.
7. Readability: Use Markdown tables for specification values, pin assignments, inspection steps with criteria, and parts lists with torque/clearance. Keep paragraphs short; prefer headings, bullets, and tables over walls of text.
8. Citations:
   - Cite with the "PDF_CITATION_MARKDOWN" strings from the Context, copied byte-for-byte. Never invent, shorten, or re-encode a URL, and never use "#", "javascript:", or "localhost".
   - Place one citation at the end of each procedure step or each short paragraph. That granularity is allowed and preferred. Do not cite after every sentence, and do not put a citation on every bullet in a tight list that is still one step.
   - Each citation must come from the Document Ref that actually contains the evidence. If a sentence combines several refs, attach one link per ref.
   - If a Document Ref has no PDF_CITATION_MARKDOWN, write its title as plain text.
   - No links inside tables, except a "参照" / "参考" / "Reference" column.
   - Never output raw "[shop-N]" tags, decorative markers ("cite", "★", "☆", "■"), or an image file name as a citation.
9. Cross-chapter References: When the Context text points to another chapter ("〜を参照", "refer to ...", "see ...", "故障コード[...]"), turn that mention into a link to the matching Document Ref's PDF_CITATION_MARKDOWN. Match by title, one link per mention, and leave it as plain text when no Document Ref matches.
10. Images - you MUST NOT write image URLs; the backend inserts them:
    - Insert an image by writing \`[[IMG:<file name>]]\` on its own line, using a file name that literally appears in an "Image:" line or the "available_images" list of the SAME Document Ref.
    - FORBIDDEN: \`![name.jpg](...)\`, \`!name.jpg\`, or a bare \`name.jpg\` as a paragraph. Never invent a file name.
    - Place the token right after the sentence or step it illustrates; never collect images at the end.
    - Coverage: insert a token for every procedure step, inspection item, connector, component, and figure reference that has a matching file name in a MAIN or CONNECTOR Document Ref. Prefer completeness. Do not insert images from SUB refs.
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
`;
    case 'maintenance':
      return `

ANSWER MODE - Periodic Maintenance:
   - Never answer with only a list of items. For each maintenance item give the step-by-step procedure, warnings, tools, and torque/clearance values from the Context.
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

export async function selectTOCChaptersInitial(
  queries: string[],
  userQuery: string,
  tocContent: string
): Promise<TOCChaptersResponse> {
  try {
    return await chatJson<TOCChaptersResponse>([
      {
        role: 'system',
        content:
          'Select the most relevant TOC path values for the user question. Prefer the deepest, most specific entries you can find.',
      },
      {
        role: 'user',
        content: `Select a SMALL set of relevant TOC path values for the user question.

## Rules
1. Return the EXACT path strings as they appear in the TOC (one path per line).
2. Prefer leaf-level / deepest / most specific paths over parent paths.
3. Be as specific as possible and include low-level paths whenever they are relevant.
4. Do NOT return titles. Return path values only.
5. Be helpful but not exhaustive. This is the INITIAL path selection.
6. Maintenance (OMM / 取扱説明書): If the query is about maintenance, メンテナンス, periodic maintenance, or 定期点検, and a Maintenance/Periodic Maintenance parent exists, also include its child maintenance item/detail paths, not just the schedule/interval parent.
6. Return JSON only.

## Output Format
{
  "chapters": ["XXXXXXXX", "XXXXXXXXX"]
}

## Search Queries
${JSON.stringify(queries)}

## User Query
${userQuery}

## Table of Contents
${tocContent}`,
      },
    ]);
  } catch (error) {
    console.error('Error selecting initial TOC chapters:', error);
    return { chapters: [] };
  }
}

async function chatJson<T>(messages: ChatMessage[]): Promise<T> {
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
      },
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
    return responsesJson<T>(messages);
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

export async function generateSearchQueries(userQuery: string, chatHistory: any[] = []): Promise<SearchQueriesResponse> {
  try {
    return await chatJson<SearchQueriesResponse>([
      {
        role: 'system',
        content:
          `Your goal is to generate effective search queries for a technical documentation search system.

## What to Extract
- error codes / fault codes (e.g., CA441)
- part numbers, TSI, PSN, serial-like identifiers
- component names, connector IDs (when explicitly mentioned)
- maintenance-related terms and periodic inspection terms when the question is about operation and maintenance manuals

## Conversation Context (IMPORTANT)
- If chat history is provided, you MUST use it to resolve omitted context in the current user query.
- Do NOT invent identifiers that do not appear in the user query or recent chat history.

## Output
- Output JSON format only: {"queries": ["query1", "query2"], "has_codes": true/false}
- If no identifiers are found, return the original user query as a single query.
`,
      },
      {
        role: 'user',
        content: `User Query: ${userQuery}\n\nRecent Chat History (most recent last):\n${chatHistory
          .slice(-6)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n')}`,
      },
    ]);
  } catch (error) {
    console.error('Error generating search queries:', error);
    return { queries: [userQuery], has_codes: false };
  }
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
12. Return JSON only.

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
    
    return await chatJson<ExtractedElements>([
      {
        role: 'system',
        content:
`You are an expert in analyzing technical documents in Japanese and English. Based only on the user query and the provided Document Content, determine whether additional search is needed and extract the information required for that search.

## Output Format

Return a JSON object with all fields:

{
"error_codes": [],
"connectors": [],
"reference_chapters": [],
"diagnostic_chapters": [],
"components": [],
"reasoning": "",
"needs_followup": false
}

## Extraction Rules

* Focus only on the user query: "${userQuery}".
* Do not invent information that is not explicitly stated in the Document Content.
* If the provided content is TOC-like or chapter-list-like, prefer extracting chapter titles exactly as they appear instead of rewriting them.
* error_codes: Extract explicit error or failure codes only when sufficient information about them has not already been found in the Document Content.
* connectors: Extract explicit connector IDs ONLY when the user query is explicitly about connectors, wiring, error codes, diagnostics, or inspection. Do NOT include connector list/layout or 3D layout diagram chapter names for unrelated queries such as weight, maintenance, assembly/disassembly, or specifications.
* reference_chapters: Extract chapter or section titles explicitly referenced by phrases such as "see", "refer to", "for details, see", or "〜を参照". Do NOT include connector list/layout or 3D layout diagram chapter(s) here unless the query is about connectors or diagnostics.
* diagnostic_chapters: Extract chapter titles that are explicitly related to troubleshooting, diagnosis, or inspection.
* components: Extract up to two primary components involved.
* reasoning: Briefly explain what information is available and what is missing.

## needs_followup Rules

* If the user query is not related to troubleshooting, diagnosis, inspection, or a check procedure, set needs_followup to false.
* If the query is related to troubleshooting, diagnosis, inspection, or a check procedure, set needs_followup to true when either:

  * the current Document Content is insufficient, or
  * any value is extracted into error_codes, connectors, reference_chapters, or diagnostic_chapters.

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
    };
  }
}

export async function classifyChapters(
  userQuery: string,
  chapterList: any[]
): Promise<ChapterClassification> {
  try {
    return await chatJson<ChapterClassification>([
      {
        role: 'system',
        content: 'You are an expert in classifying technical documents. Prefer IGNORE when a chapter is not clearly relevant to the user question.',
      },
      {
        role: 'user',
        content: `Classify each chapter based on how useful it is for answering the user's question.

User Question

${userQuery}

Chapter List

${JSON.stringify(chapterList, null, 2)}

Categories
MAIN: Chapters containing direct answers, procedures, specifications, locations, or keywords from the user question.
SUB: Chapters that support, explain, or are explicitly referenced by MAIN chapters. Maximum 5 chapters.
CONNECTOR: Relevant connector lists, connector tables, wiring/layout diagrams, or connector location chapters. Use only when connector relevance is explicit.
IGNORE: Chapters unrelated to the user question or only loosely related.
Rules
Classify chapters that directly answer "how", "where", or specification questions as MAIN.
Chapters containing error codes, component names, or other keywords from the user question should be MAIN only when they clearly help answer the user question.
If multiple chapters contain the same information, classify the most detailed one as MAIN.
Any chapter explicitly referenced by another relevant chapter must be at least SUB.
Use chapter content, image_captions, and image_ocr_texts as classification evidence.
Treat IDs such as E08, J1, or VE03 as connector IDs when relevant.
When connectors are relevant, include the applicable connector list/table and corresponding layout or location chapters in CONNECTOR.
If related connector layout chapters are numbered, such as "(1)", "(2)", and "(3)", include all available entries in the series.
If none of the chapters clearly match the user question, put all chapters into IGNORE rather than forcing them into MAIN, SUB, or CONNECTOR.
If a chapter is not clearly useful for the answer, choose IGNORE.
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
    ]);
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
     3) ${headings.perCodeDiagnosis} — one "### {CODE}" subsection per code, each as detailed as a single-code answer (full steps, criteria, values, citations).
     4) ${headings.commonConnectors} — connectors the Context states apply to ALL codes (see the CONNECTOR SECTION rules for the table and images).
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
    prompt += buildConnectorSectionPrompt(multiError);
  }
  return prompt;
}

async function classifyAnswerLanguage(userQuery: string, chatHistory: any[] = []): Promise<AnswerLanguage> {
  const historyContext = chatHistory.slice(-4).map((m) => `${m.role}: ${m.content}`).join('\n');

  try {
    const response = await chatJson<AnswerLanguageResponse>([
      {
        role: 'system',
        content:
          'You are a strict language classifier. Determine the language that should be used to answer the user question. Return JSON only with language set to "ja" or "en" and a short reason. Choose the language of the user question itself, not the document language.',
      },
      {
        role: 'user',
        content: `User Query:\n${userQuery}\n\nRecent Chat History:\n${historyContext}\n\nOutput JSON only in this format:\n{\n  "language": "ja" or "en",\n  "reason": "short explanation"\n}`,
      },
    ]);

    if (response?.language === 'ja' || response?.language === 'en') {
      return response.language;
    }
  } catch (error) {
    console.error('Error classifying answer language:', error);
  }

  const trimmed = userQuery.trim();
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
  const urlFor = (fileName: string): string | undefined => lookup.get(fileName.trim().toLowerCase());
  const toMarkdown = (fileName: string, fallback: string): string => {
    const url = urlFor(fileName);
    return url ? `![${fileName}](${url})` : fallback;
  };

  let rendered = answerText;

  // 1. Canonical token emitted by the model.
  rendered = rendered.replace(/\[\[\s*IMG\s*:\s*([^\]]+?)\s*\]\]/gi, (_m, name) => toMarkdown(String(name), ''));

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

/**
 * Streaming helper: buffers just enough text so an image token is never split
 * across two chunks, and renders tokens as soon as they are complete.
 */
function createStreamingImageRenderer(imageSasUrlMap?: Map<string, string>) {
  let buffer = '';

  return {
    // Emits only whole lines so a file name or [[IMG:...]] token is never split.
    feed(chunk: string): string {
      buffer += chunk;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline < 0) return '';
      const ready = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      return renderImageReferences(ready, imageSasUrlMap);
    },
    flush(): string {
      const rest = buffer;
      buffer = '';
      return rest ? renderImageReferences(rest, imageSasUrlMap) : '';
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
  imageSasUrlMap?: Map<string, string>
): Promise<string> {
  try {
    let fullAnswer = '';
    const historyMessages = chatHistory.slice(-4).map(m => ({
      role: m.role,
      content: m.content,
    }));
    const assetLookup = extractFinalAnswerAssetLookup(combinedContext);
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
          },
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

      const imageRenderer = createStreamingImageRenderer(imageSasUrlMap);
      const emitChunk = (text: string) => {
        const ready = imageRenderer.feed(text);
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
            fullAnswer += content;
            emitChunk(content);
          }
        }
      }
      const tail = imageRenderer.flush();
      if (tail) onChunk(tail);

      const rewrittenAnswer = renderImageReferences(
        rewriteFinalAnswerArtifacts(fullAnswer, assetLookup),
        imageSasUrlMap
      );
      logFinalAnswer(rewrittenAnswer, extractFinalAnswerArtifacts(rewrittenAnswer));
      return rewrittenAnswer;
    }

    if (config.azureOpenAI.endpoint && isAzureResponsesUrl(config.azureOpenAI.endpoint)) {
      const imageRenderer = createStreamingImageRenderer(imageSasUrlMap);
      const fullAnswerFromResponses = await streamResponses(
        userQuery,
        systemPrompt,
        historyMessages as any,
        (text: string) => {
          const ready = imageRenderer.feed(text);
          if (ready) onChunk(ready);
        }
      );
      const tail = imageRenderer.flush();
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
