import { config } from '../config';
import { SearchResult, SelectedDocument } from '../types';
import { searchByTOCFilter, searchByTOCTitleFilter } from './azureSearch';
import { createSasUrl, buildTOCPdfBlobName } from './azureBlob';
import {
  fetchTocByDocumentNumber,
  FlatTocEntry,
  buildTocContent,
} from './cosmosToc';
import { loadTOCMarkdown, flattenImageExplanations } from './tocLoader';
import { SearchedChapterRef, CHAT_REASONING_EFFORT } from './openai';

export type AgentMode = 'thinking' | 'fast';

export interface AgentToolContext {
  mode: AgentMode;
  selectedDocuments: SelectedDocument[];
  selectedDocumentNumbers: string[];
  chatHistory: Array<{ role: string; content: string }>;
  /** Latest user message for this turn (may not yet be in chatHistory). */
  currentQuery?: string;
  assetStore: AgentAssetStore;
  chapterCap: number;
  contentCharCap: number;
  /** Titles/paths already retrieved this turn (and optionally prior turns). */
  fetchedChapterRefs: SearchedChapterRef[];
  /** In-memory TOC for this agent turn (avoids reloading Cosmos on 2nd select/fetch). */
  tocCache?: TocCacheState;
  /** Paths from the latest select_toc_bookmarks call (fetch may reuse if paths omitted). */
  lastSelectedPaths?: string[];
  /** Emit detailed progress for the Thinking Process UI. */
  onProgress?: (event: {
    title: string;
    description: string;
    status?: 'in_progress' | 'completed' | 'error';
    reasoningEffort?: string;
  }) => void;
  /** Abort when the client presses Stop. */
  signal?: AbortSignal;
}

export interface TocCacheState {
  documentKey: string;
  documentNumbers: string[];
  entriesByDoc: Map<string, FlatTocEntry[]>;
  markdownByDoc: Map<string, string>;
  allEntries: FlatTocEntry[];
  tocContent: string;
  entryCount: number;
  truncated: boolean;
}

/** Cap images registered per chapter (names still listed; SAS deferred beyond this cap). */
const IMAGE_SAS_CAP_FAST = 8;
const IMAGE_SAS_CAP_THINKING = 40;

function agentTiming(phase: string, startedAt: number, extra?: string): void {
  const ms = Math.max(0, Date.now() - startedAt);
  console.log(`[AgentTiming] ${phase}: ${ms}ms${extra ? ` | ${extra}` : ''}`);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    })
  );
  return results;
}

export class AgentAssetStore {
  imageSasUrlMap = new Map<string, string>();
  imageUrls: string[] = [];
  refLinkMap = new Map<string, string>();
  pdfUrls: Array<{ title: string; url: string }> = [];
  private nextRef = 1;
  private imageInflight = new Map<string, Promise<string>>();
  private pdfBlobByRef = new Map<string, { title: string; blobPath: string }>();
  private imageBlobByName = new Map<string, string>();

  allocateRefId(): string {
    const id = `shop-${this.nextRef}`;
    this.nextRef += 1;
    return id;
  }

  /** Restore citation maps from a prior turn (Conversation continuation). */
  async hydratePersisted(params: {
    pdfRefs?: Array<{ refId: string; title: string; blobPath: string }>;
    imageRefs?: Array<{ fileName: string; blobPath: string }>;
  }): Promise<void> {
    let maxRef = this.nextRef - 1;
    for (const ref of params.pdfRefs || []) {
      const refId = String(ref.refId || '').trim();
      const blobPath = String(ref.blobPath || '').trim();
      if (!refId || !blobPath) continue;
      const title = String(ref.title || refId).trim() || refId;
      try {
        const sasPdfUrl = await createSasUrl(blobPath);
        this.pdfBlobByRef.set(refId, { title, blobPath });
        this.refLinkMap.set(
          refId,
          `[${title.replace(/\[/g, '(').replace(/\]/g, ')')}](<${sasPdfUrl}>)`
        );
        if (!this.pdfUrls.some((p) => p.url === sasPdfUrl)) {
          this.pdfUrls.push({ title, url: sasPdfUrl });
        }
        const m = /^shop-(\d+)$/i.exec(refId);
        if (m) maxRef = Math.max(maxRef, Number(m[1]));
      } catch (error) {
        console.warn(
          `[AgentAssetStore] hydrate PDF ${refId} failed:`,
          (error as Error).message
        );
      }
    }
    this.nextRef = Math.max(this.nextRef, maxRef + 1);

    for (const img of params.imageRefs || []) {
      const fileName = String(img.fileName || '').trim();
      const blobPath = String(img.blobPath || '').trim();
      if (!fileName || !blobPath) continue;
      const key = fileName.toLowerCase();
      try {
        const sas = await createSasUrl(blobPath);
        this.imageBlobByName.set(key, blobPath);
        if (!this.imageSasUrlMap.has(key)) {
          this.imageSasUrlMap.set(key, sas);
          this.imageUrls.push(sas);
        }
      } catch (error) {
        console.warn(
          `[AgentAssetStore] hydrate image ${fileName} failed:`,
          (error as Error).message
        );
      }
    }
  }

  exportPersisted(): {
    pdfRefs: Array<{ refId: string; title: string; blobPath: string }>;
    imageRefs: Array<{ fileName: string; blobPath: string }>;
  } {
    const pdfRefs = [...this.pdfBlobByRef.entries()].map(([refId, meta]) => ({
      refId,
      title: meta.title,
      blobPath: meta.blobPath,
    }));
    const imageRefs = [...this.imageBlobByName.entries()].map(([fileName, blobPath]) => ({
      fileName,
      blobPath,
    }));
    return { pdfRefs, imageRefs };
  }

  async registerImage(blobPath: string): Promise<string> {
    const fileName = blobPath.split('/').pop() || blobPath;
    const key = fileName.toLowerCase();
    this.imageBlobByName.set(key, blobPath);
    if (this.imageSasUrlMap.has(key)) return fileName;
    const inflight = this.imageInflight.get(key);
    if (inflight) {
      await inflight;
      return fileName;
    }
    const promise = (async () => {
      const sas = await createSasUrl(blobPath);
      if (!this.imageSasUrlMap.has(key)) {
        this.imageSasUrlMap.set(key, sas);
        this.imageUrls.push(sas);
      }
      return fileName;
    })().finally(() => this.imageInflight.delete(key));
    this.imageInflight.set(key, promise);
    await promise;
    return fileName;
  }

  async registerPdf(result: SearchResult, refId: string): Promise<void> {
    const pdfBlobPath = await buildTOCPdfBlobName(result);
    if (!pdfBlobPath) return;
    const sasPdfUrl = await createSasUrl(pdfBlobPath);
    const title = result.TOC || result.documentTitle || refId;
    this.pdfBlobByRef.set(refId, { title, blobPath: pdfBlobPath });
    this.refLinkMap.set(
      refId,
      `[${title.replace(/\[/g, '(').replace(/\]/g, ')')}](<${sasPdfUrl}>)`
    );
    this.pdfUrls.push({ title, url: sasPdfUrl });
  }
}

function isOmmDocument(document: SelectedDocument | undefined): boolean {
  if (!document) return false;
  const value = String(document.documentType || '').toLowerCase();
  return value.includes('operation and maintenance manual') || value.includes('operationandmaintenancemanual') || value.includes('omm');
}

function splitShopOmm(
  selectedDocuments: SelectedDocument[],
  selectedDocumentNumbers: string[]
): { shop: string[]; omm: string[] } {
  if (selectedDocuments.length > 0) {
    return {
      shop: selectedDocuments.filter((d) => !isOmmDocument(d)).map((d) => d.documentNumber),
      omm: selectedDocuments.filter((d) => isOmmDocument(d)).map((d) => d.documentNumber),
    };
  }
  return { shop: selectedDocumentNumbers, omm: [] };
}

function truncateText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text || '';
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

async function loadTocForDocs(documentNumbers: string[]): Promise<{
  entriesByDoc: Map<string, FlatTocEntry[]>;
  allEntries: FlatTocEntry[];
  markdownByDoc: Map<string, string>;
}> {
  const entriesByDoc = new Map<string, FlatTocEntry[]>();
  const markdownByDoc = new Map<string, string>();
  const allEntries: FlatTocEntry[] = [];

  await Promise.all(
    documentNumbers.map(async (docNum) => {
      try {
        const entries = await fetchTocByDocumentNumber(docNum);
        entriesByDoc.set(docNum, entries);
        allEntries.push(...entries);
      } catch (error) {
        console.warn(`[agentTools] Cosmos TOC failed for ${docNum}:`, (error as Error).message);
        entriesByDoc.set(docNum, []);
      }
    })
  );

  if (!allEntries.length) {
    for (const docNum of documentNumbers) {
      const md = loadTOCMarkdown([docNum]);
      if (md.trim()) markdownByDoc.set(docNum, md);
    }
  }
  return { entriesByDoc, allEntries, markdownByDoc };
}

async function searchPathsForDocs(
  requests: Array<{ documentNumber: string; paths: string[] }>,
  selectedDocuments: SelectedDocument[],
  useTitleFilter: boolean
): Promise<SearchResult[]> {
  const { shop, omm } = splitShopOmm(
    selectedDocuments,
    requests.map((r) => r.documentNumber)
  );
  const shopPaths = requests
    .filter((r) => shop.includes(r.documentNumber))
    .flatMap((r) => r.paths);
  const ommPaths = requests
    .filter((r) => omm.includes(r.documentNumber))
    .flatMap((r) => r.paths);
  const shopDocs = requests.filter((r) => shop.includes(r.documentNumber)).map((r) => r.documentNumber);
  const ommDocs = requests.filter((r) => omm.includes(r.documentNumber)).map((r) => r.documentNumber);

  const searches: Array<Promise<SearchResult[]>> = [];
  if (shopDocs.length && shopPaths.length) {
    searches.push(
      useTitleFilter
        ? searchByTOCTitleFilter(shopPaths, shopDocs, config.azureSearch.indexName)
        : searchByTOCFilter(shopPaths, shopDocs, config.azureSearch.indexName)
    );
  }
  if (ommDocs.length && ommPaths.length) {
    searches.push(
      useTitleFilter
        ? searchByTOCTitleFilter(ommPaths, ommDocs, config.azureSearch.indexNameOmm)
        : searchByTOCFilter(ommPaths, ommDocs, config.azureSearch.indexNameOmm)
    );
  }
  if (!searches.length && requests.length) {
    const allPaths = requests.flatMap((r) => r.paths);
    const allDocs = requests.map((r) => r.documentNumber);
    searches.push(
      useTitleFilter
        ? searchByTOCTitleFilter(allPaths, allDocs, config.azureSearch.indexName)
        : searchByTOCFilter(allPaths, allDocs, config.azureSearch.indexName)
    );
  }

  const batches = await Promise.all(searches);
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const batch of batches) {
    for (const hit of batch) {
      const key = hit.id || `${hit.documentNumber}|${hit.path}|${hit.start_page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }
  return merged;
}

export const AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    name: 'get_toc_bookmarks',
    description:
      'Retrieve the complete manual bookmark/TOC list for the selected documents and return it to the main agent. Call this only when no usable TOC is already available in the conversation. Skip it on follow-up turns if a prior TOC result is still present — go straight to fetch_chapters_by_paths. This tool only loads the TOC; it does not select paths, call another GPT, or fetch chapter text.',
    parameters: {
      type: 'object',
      properties: {
        documentNumbers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of selected document numbers. Empty = all selected.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'fetch_chapters_by_paths',
    description:
      'Fetch chapter text and image explanations for exact TOC tree paths chosen by the main agent from the current or previously loaded TOC in this conversation. Do not require a fresh get_toc_bookmarks when a prior TOC is still available. This tool performs no TOC selection and calls no inner GPT. Returns context, image_explanation, [[PDF:shop-N]].',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exact TOC path strings. If omitted, the tool selects paths from the TOC using query/focus and fetches them immediately.',
        },
        documentNumbers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of selected document numbers. Empty = all selected / TOC cache docs.',
        },
        followUp: {
          type: 'boolean',
          description:
            'True when this is an additional/follow-up fetch (stricter chapter cap). Default: true if chapters were already fetched this turn.',
        },
      },
      additionalProperties: false,
      required: ['paths'],
    },
  },
];

function resolveDocNumbers(raw: unknown, ctx: AgentToolContext): string[] {
  const fromArg = Array.isArray(raw)
    ? raw.map((v) => String(v).trim()).filter(Boolean)
    : [];
  if (fromArg.length) {
    const allowed = new Set(ctx.selectedDocumentNumbers);
    const filtered = fromArg.filter((d) => allowed.has(d));
    return filtered.length ? filtered : ctx.selectedDocumentNumbers;
  }
  return ctx.selectedDocumentNumbers;
}

function buildTocContentForSelection(
  documentNumbers: string[],
  entriesByDoc: Map<string, FlatTocEntry[]>,
  markdownByDoc: Map<string, string>
): { content: string; entryCount: number; truncated: boolean } {
  // Full TOC — no char/entry budget.
  const parts: string[] = [];
  let entryCount = 0;

  for (const documentNumber of documentNumbers) {
    const markdown = markdownByDoc.get(documentNumber) || '';
    const entries = entriesByDoc.get(documentNumber) || [];
    if (entries.length) {
      entryCount += entries.length;
      parts.push(`# ${documentNumber}\n${buildTocContent(entries)}`);
    } else if (markdown.trim()) {
      entryCount += 1;
      parts.push(`## Document ${documentNumber}\n${markdown}`);
    }
  }

  return { content: parts.join('\n\n'), entryCount, truncated: false };
}

function groupPathsByDocument(
  paths: string[],
  documentNumbers: string[],
  entriesByDoc: Map<string, FlatTocEntry[]>
): Array<{ documentNumber: string; paths: string[] }> {
  const requests: Array<{ documentNumber: string; paths: string[] }> = [];
  const unmatched: string[] = [];

  for (const path of paths) {
    let matched = false;
    for (const documentNumber of documentNumbers) {
      const entries = entriesByDoc.get(documentNumber) || [];
      if (entries.some((e) => e.path === path || e.title === path || e.path.endsWith(path))) {
        let row = requests.find((r) => r.documentNumber === documentNumber);
        if (!row) {
          row = { documentNumber, paths: [] };
          requests.push(row);
        }
        if (!row.paths.includes(path)) row.paths.push(path);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(path);
  }

  if (unmatched.length) {
    for (const documentNumber of documentNumbers) {
      let row = requests.find((r) => r.documentNumber === documentNumber);
      if (!row) {
        row = { documentNumber, paths: [] };
        requests.push(row);
      }
      for (const path of unmatched) {
        if (!row.paths.includes(path)) row.paths.push(path);
      }
    }
  }

  return requests.filter((r) => r.paths.length > 0);
}

function toAlreadySearchedRefs(
  alreadyHave: string[],
  fetchedChapterRefs: SearchedChapterRef[]
): SearchedChapterRef[] {
  const merged: SearchedChapterRef[] = [...fetchedChapterRefs];
  const seen = new Set(
    merged.flatMap((r) => [r.path, r.title].map((v) => String(v || '').trim()).filter(Boolean))
  );
  for (const raw of alreadyHave) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push({ title: value, path: value });
  }
  return merged;
}

async function materializeChapters(
  results: SearchResult[],
  ctx: AgentToolContext
): Promise<{ chapters: Array<Record<string, unknown>>; truncated: boolean }> {
  let list = results;
  const truncated = list.length > ctx.chapterCap;
  if (truncated) list = list.slice(0, ctx.chapterCap);

  const imagePayloadCap = ctx.mode === 'fast' ? IMAGE_SAS_CAP_FAST : IMAGE_SAS_CAP_THINKING;
  const startedAt = Date.now();

  const prepared = list.map((result) => {
    const refId = ctx.assetStore.allocateRefId();
    const explanationMeta: Array<{
      caption: string;
      ocr: string;
      page?: unknown;
      step?: unknown;
      cropped?: string;
    }> = [];
    const imagePaths: string[] = [];

    if (result.image_content) {
      for (const exp of flattenImageExplanations(result.image_content) as any[]) {
        const cropped = exp?.cropped_image_path ? String(exp.cropped_image_path) : '';
        if (cropped) imagePaths.push(cropped);
        explanationMeta.push({
          caption: exp?.caption || '',
          ocr: truncateText(String(exp?.ocr_text || ''), 800),
          page: exp?.page_number,
          step: exp?.procedure_step_number,
          cropped: cropped || undefined,
        });
      }
    }
    for (const path of result.same_page_paths || []) {
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(path)) imagePaths.push(path);
    }

    // Fast: only register / expose a bounded set so retrieve + answer context stay lean.
    const uniquePaths = Array.from(new Set(imagePaths)).slice(0, imagePayloadCap);
    return { result, refId, explanationMeta, imagePaths: uniquePaths };
  });

  await mapPool(prepared, 8, async (row) => {
    await ctx.assetStore.registerPdf(row.result, row.refId);
  });

  const allImagePaths = Array.from(new Set(prepared.flatMap((row) => row.imagePaths)));
  await mapPool(allImagePaths, 12, async (path) => {
    await ctx.assetStore.registerImage(path);
  });
  agentTiming(
    'materialize_sas',
    startedAt,
    `chapters=${prepared.length} images=${allImagePaths.length} mode=${ctx.mode}`
  );

  const allowedNames = new Set(
    allImagePaths.map((p) => (p.split('/').pop() || p).toLowerCase())
  );

  const chapters: Array<Record<string, unknown>> = prepared.map((row) => {
    const imageNames: string[] = row.imagePaths.map((p) => p.split('/').pop() || p);
    const explanations: Array<Record<string, unknown>> = row.explanationMeta
      .filter((exp) => {
        if (!exp.cropped) return true;
        const name = (exp.cropped.split('/').pop() || exp.cropped).toLowerCase();
        return allowedNames.has(name);
      })
      .map((exp) => ({
        caption: exp.caption,
        image: exp.cropped ? exp.cropped.split('/').pop() || exp.cropped : '',
        ocr: exp.ocr,
        page: exp.page,
        step: exp.step,
      }));

    return {
      ref_id: row.refId,
      documentNumber: row.result.documentNumber,
      title: row.result.TOC,
      path: row.result.path,
      pages: `${row.result.start_page}-${row.result.end_page}`,
      PDF_CITATION_TOKEN: `[[PDF:${row.refId}]]`,
      context: truncateText(row.result.content || '', ctx.contentCharCap),
      image_explanation: explanations,
      available_images: Array.from(new Set(imageNames)),
    };
  });

  return { chapters, truncated };
}

function keepExactPaths(selectedPaths: string[], entries: FlatTocEntry[]): string[] {
  if (!entries.length) {
    return selectedPaths.map((p) => p.trim()).filter(Boolean);
  }
  const exactPathSet = new Set(entries.map((entry) => entry.path));
  return selectedPaths.map((path) => path.trim()).filter((path) => exactPathSet.has(path));
}

/** Split focus text into search-term list for follow-up TOC selection. */
function parseFollowUpSearchTerms(focus: string, userQuery: string): string[] {
  const raw = String(focus || '').trim();
  const fromFocus = raw
    .split(/[\n,，、;；|/]+/)
    .map((t) => t.trim())
    // Drop noisy / too-generic fragments from auto-extracted focus.
    .filter((t) => t.length >= 3 && t.length <= 80)
    .filter((t) => !/^(related information|electrical equipment|checked with|check that|check the)/i.test(t));

  const terms: string[] = [];
  for (const t of fromFocus) {
    if (terms.length >= 8) break;
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
  }

  const hay = terms.join('\n');
  const wantsConnectors = /\b(?:CE|CN|AMP|DT|DRC)[- ]?\d{1,4}\b|コネクタ|connector/i.test(
    `${hay}\n${raw}\n${userQuery}`
  );
  if (wantsConnectors) {
    for (const extra of ['CONNECTOR LIST AND LAYOUT', 'CONNECTOR CONTACT IDENTIFICATION']) {
      if (terms.length >= 8) break;
      if (!terms.some((x) => x.toLowerCase() === extra.toLowerCase())) terms.push(extra);
    }
  }

  return terms.length ? terms : [userQuery].filter(Boolean).slice(0, 1);
}

/**
 * Load TOC for the given docs into ctx.tocCache (reuse when same document set).
 */
async function ensureTocLoaded(
  documentNumbers: string[],
  ctx: AgentToolContext
): Promise<TocCacheState> {
  const key = [...documentNumbers].sort().join('|');
  if (ctx.tocCache && ctx.tocCache.documentKey === key) {
    return ctx.tocCache;
  }

  ctx.onProgress?.({
    title: 'Loading TOC',
    description: `Documents: ${documentNumbers.join(', ')}`,
    status: 'in_progress',
  });

  const tocLoadStarted = Date.now();
  const { entriesByDoc, markdownByDoc, allEntries } = await loadTocForDocs(documentNumbers);
  const tocBuilt = buildTocContentForSelection(documentNumbers, entriesByDoc, markdownByDoc);
  agentTiming(
    'toc_load',
    tocLoadStarted,
    `entries=${allEntries.length} sent=${tocBuilt.entryCount} chars=${tocBuilt.content.length} truncated=${tocBuilt.truncated} mode=${ctx.mode}`
  );

  const cache: TocCacheState = {
    documentKey: key,
    documentNumbers: [...documentNumbers],
    entriesByDoc,
    markdownByDoc,
    allEntries,
    tocContent: tocBuilt.content,
    entryCount: tocBuilt.entryCount,
    truncated: tocBuilt.truncated,
  };
  ctx.tocCache = cache;

  if (!cache.tocContent.trim() && !cache.allEntries.length) {
    ctx.onProgress?.({
      title: 'Loading TOC',
      description: 'No TOC available for selected documents.',
      status: 'error',
    });
    return cache;
  }

  const tocStats = documentNumbers
    .map((d) => {
      const n = (entriesByDoc.get(d) || []).length;
      const md = markdownByDoc.get(d)?.length || 0;
      return n ? `${d}: ${n} bookmarks` : md ? `${d}: markdown TOC (${md} chars)` : `${d}: (empty)`;
    })
    .join('\n');
  ctx.onProgress?.({
    title: 'Loading TOC',
    description: [
      tocStats,
      `TOC ready: ${cache.entryCount} entries / ${cache.tocContent.length} chars${cache.truncated ? ' (slimmed)' : ''}`,
    ].join('\n'),
    status: 'completed',
  });

  return cache;
}

/**
 * Tool A: expose the complete TOC to the main agent, then validate the
 * exact paths selected by the main agent. No inner GPT performs selection.
 */
async function selectTocBookmarks(args: any, ctx: AgentToolContext) {
  if (ctx.signal?.aborted) {
    return { ok: false, cancelled: true, error: 'User stopped generation', selectedPaths: [] };
  }
  const selectStartedAt = Date.now();
  const documentNumbers = resolveDocNumbers(args?.documentNumbers, ctx);
  if (!documentNumbers.length) {
    return { ok: false, error: 'No documents selected.', selectedPaths: [] };
  }

  const toc = await ensureTocLoaded(documentNumbers, ctx);
  if (!toc.tocContent.trim() && !toc.allEntries.length) {
    return {
      ok: false,
      error: 'No TOC available for selected documents.',
      selectedPaths: [],
    };
  }

  const rawPaths: string[] = Array.isArray(args?.paths)
    ? args.paths.map((p: unknown) => String(p).trim()).filter(Boolean)
    : [];
  if (!rawPaths.length) {
    ctx.onProgress?.({
      title: 'Loading complete TOC for main agent',
      description: `TOC: ${toc.entryCount} entries / ${toc.tocContent.length} chars. Main agent must choose exact paths.`,
      status: 'completed',
      reasoningEffort: CHAT_REASONING_EFFORT,
    });
    agentTiming('toc_exposed_to_main_agent', selectStartedAt, `entries=${toc.entryCount}`);
    return {
      ok: true,
      selectionMode: 'main_agent_pending',
      selectedPaths: [],
      pathCount: 0,
      tocContent: toc.tocContent,
      tocEntryCount: toc.entryCount,
      tocCached: true,
      hint: 'Choose exact paths from tocContent, then call select_toc_bookmarks again with paths.',
    };
  }

  const selectedPaths: string[] = Array.from(new Set<string>(rawPaths));
  const validPaths = keepExactPaths(selectedPaths, toc.allEntries);
  const invalidPaths = selectedPaths.filter((path) => !validPaths.includes(path));
  ctx.lastSelectedPaths = validPaths;
  ctx.onProgress?.({
    title: 'Main agent selected TOC bookmarks',
    description: [
      `Selected ${validPaths.length} path(s)`,
      validPaths.length ? validPaths.map((p, i) => `${i + 1}. ${p}`).join('\n') : '(none)',
      invalidPaths.length ? `Ignored invalid paths: ${invalidPaths.join(' · ')}` : null,
    ].filter(Boolean).join('\n'),
    status: 'completed',
    reasoningEffort: CHAT_REASONING_EFFORT,
  });
  agentTiming('main_agent_toc_selection', selectStartedAt, `paths=${validPaths.length}`);

  return {
    ok: true,
    selectionMode: 'main_agent',
    selectedPaths: validPaths,
    pathCount: validPaths.length,
    invalidPaths,
    tocCached: true,
    tocEntryCount: toc.entryCount,
    hint: validPaths.length
      ? 'Call fetch_chapters_by_paths with these selected paths.'
      : 'Choose exact paths from tocContent and call this tool again with paths.',
  };
}

/**
 * Tool A: load the complete TOC for the main agent.
 */
async function getTocBookmarks(args: any, ctx: AgentToolContext) {
  if (ctx.signal?.aborted) {
    return { ok: false, cancelled: true, error: 'User stopped generation' };
  }
  const documentNumbers = resolveDocNumbers(args?.documentNumbers, ctx);
  if (!documentNumbers.length) {
    return { ok: false, error: 'No documents selected.' };
  }
  const toc = await ensureTocLoaded(documentNumbers, ctx);
  if (!toc.tocContent.trim() && !toc.allEntries.length) {
    return { ok: false, error: 'No TOC available for selected documents.' };
  }
  ctx.onProgress?.({
    title: 'Loading TOC bookmarks',
    description: `TOC ready: ${toc.entryCount} entries / ${toc.tocContent.length} chars`,
    status: 'completed',
    reasoningEffort: CHAT_REASONING_EFFORT,
  });
  return {
    ok: true,
    tocContent: toc.tocContent,
    tocEntryCount: toc.entryCount,
    documentNumbers: toc.documentNumbers,
    tocCached: true,
    hint: 'Main agent: immediately call fetch_chapters_by_paths with exact tree paths from tocContent.',
  };
}

/**
 * Tool B: Azure Search + materialize chapter text/images for exact TOC paths.
 * Path selection is owned by the main agent; this function does no inner GPT selection.
 */
async function fetchChaptersByPaths(args: any, ctx: AgentToolContext) {
  if (ctx.signal?.aborted) {
    return {
      ok: false,
      cancelled: true,
      error: 'User stopped generation',
      chapters: [],
      selectedPaths: [],
    };
  }
  const fetchStartedAt = Date.now();
  const documentNumbers = resolveDocNumbers(args?.documentNumbers, ctx);
  if (!documentNumbers.length) {
    return { ok: false, error: 'No documents selected.', chapters: [], selectedPaths: [] };
  }

  const pathsFromArgs = Array.isArray(args?.paths)
    ? args.paths.map((p: unknown) => String(p).trim()).filter(Boolean)
    : [];
  let selectedPaths: string[] = pathsFromArgs;

  if (!selectedPaths.length) {
    return {
      ok: false,
      error: 'paths is required. Call get_toc_bookmarks first, then select exact tree paths.',
      chapters: [],
      selectedPaths: [],
    };
  }

  const followUpExplicit = typeof args?.followUp === 'boolean' ? args.followUp : undefined;
  const isFollowUp =
    followUpExplicit !== undefined
      ? followUpExplicit
      : ctx.mode === 'thinking' && ctx.fetchedChapterRefs.length > 0;

  const toc = await ensureTocLoaded(documentNumbers, ctx);
  if (toc.allEntries.length) {
    selectedPaths = keepExactPaths(selectedPaths, toc.allEntries);
  }

  const FOLLOWUP_PATH_CAP = 8;
  const INITIAL_PATH_CAP = ctx.mode === 'fast' ? 8 : 10;
  const pathCap = isFollowUp ? FOLLOWUP_PATH_CAP : INITIAL_PATH_CAP;
  if (selectedPaths.length > pathCap) {
    console.log(
      `[agentTools] fetch path cap: ${selectedPaths.length} → ${pathCap} followUp=${isFollowUp}`
    );
    selectedPaths = selectedPaths.slice(0, pathCap);
  }

  selectedPaths = Array.from(new Set(selectedPaths.map((p) => String(p).trim()).filter(Boolean)));
  if (!selectedPaths.length) {
    return {
      ok: true,
      selectedPaths: [],
      chapterCount: 0,
      truncated: false,
      chapters: [],
      hint: 'Paths did not match TOC entries. Re-run select_toc_bookmarks.',
    };
  }

  ctx.onProgress?.({
    title: 'Fetching chapter text',
    description: `Azure Search for ${selectedPaths.length} path(s) across ${documentNumbers.length} document(s)…`,
    status: 'in_progress',
  });

  const searchStarted = Date.now();
  const requests = groupPathsByDocument(selectedPaths, documentNumbers, toc.entriesByDoc);
  const useTitleFilter = toc.allEntries.length > 0;
  const results = await searchPathsForDocs(requests, ctx.selectedDocuments, useTitleFilter);
  agentTiming('fetch_azure_search', searchStarted, `hits=${results.length}`);

  const chapterCap = isFollowUp ? Math.min(ctx.chapterCap, 8) : ctx.chapterCap;
  const { chapters, truncated } = await materializeChapters(results, {
    ...ctx,
    chapterCap,
  });

  for (const ch of chapters) {
    const title = String(ch.title || '').trim();
    const path = String(ch.path || '').trim();
    if (!title && !path) continue;
    const exists = ctx.fetchedChapterRefs.some(
      (r) => (r.path && r.path === path) || (r.title && r.title === title)
    );
    if (!exists) {
      ctx.fetchedChapterRefs.push({ title, path });
    }
  }

  const chapterLines = chapters.length
    ? chapters
        .map((ch, i) => {
          const label = formatChapterLabel({
            documentNumber: String(ch.documentNumber || ''),
            title: String(ch.title || ''),
            path: String(ch.path || ''),
          });
          const pages = ch.pages ? ` [${ch.pages}]` : '';
          const imgs = Array.isArray(ch.available_images) ? ch.available_images.length : 0;
          const ctxLen = String(ch.context || '').length;
          return `${i + 1}. ${label}${pages} · text ${ctxLen} chars · images ${imgs} · ${ch.PDF_CITATION_TOKEN || ''}`;
        })
        .join('\n')
    : '(no hits)';

  ctx.onProgress?.({
    title: 'Fetching chapter text',
    description: [
      `Fetched ${chapters.length} chapter(s)${truncated ? ' (truncated)' : ''}`,
      chapterLines,
    ].join('\n'),
    status: 'completed',
  });

  agentTiming(
    'fetch_chapters_total',
    fetchStartedAt,
    `chapters=${chapters.length} followUp=${isFollowUp}`
  );

  return {
    ok: true,
    selectedPaths,
    followUp: isFollowUp,
    chapterCount: chapters.length,
    truncated,
    warning: truncated
      ? `Returned first ${chapterCap} chapters only. Narrow focus or call again for other chapters.`
      : undefined,
    chapters,
    citeHint:
      'Cite with [[PDF:shop-N]] only when the answer uses that chapter. Prefer sparse citations. When available_images / image_explanation illustrate the step you describe, insert [[IMG:exact-file-name]] on its own line right after that text. Never invent URLs or file names.',
  };
}

function formatChapterLabel(opts: {
  documentNumber?: string;
  title?: string;
  path?: string;
}): string {
  const doc = String(opts.documentNumber || '').trim();
  const title = String(opts.title || '').trim();
  const path = String(opts.path || '').trim();
  const leaf = path
    ? path
        .split(/[>/]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop() || path
    : '';
  const name = title || leaf || path || '(untitled)';
  return doc ? `${doc}: ${name}` : name;
}

function summarizeSelectedToc(result: any): string {
  if (!result?.ok) {
    return `TOC select failed: ${result?.error || 'unknown'}`;
  }
  const paths = Array.isArray(result?.selectedPaths) ? result.selectedPaths : [];
  if (!paths.length) {
    return `Selected 0 path(s) (mode=${result?.selectionMode || '?'})`;
  }
  return [
    `Selected ${paths.length} path(s) [${result?.selectionMode || '?'}]`,
    ...paths.map((p: string, i: number) => `${i + 1}. ${p}`),
  ].join('\n');
}

function summarizeFetchedChapters(result: any): string {
  const chapters = Array.isArray(result?.chapters) ? result.chapters : [];
  if (!result?.ok) {
    return `Fetch chapters failed: ${result?.error || 'unknown'}`;
  }
  const paths = Array.isArray(result?.selectedPaths) ? result.selectedPaths : [];
  const pathBlock = paths.length
    ? `Paths (${paths.length}):\n${paths.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}`
    : 'Paths: (none)';
  if (!chapters.length) {
    return [`Fetched 0 chapter(s)`, pathBlock].join('\n');
  }
  const lines = chapters.map((ch: any, i: number) => {
    const label = formatChapterLabel({
      documentNumber: ch?.documentNumber,
      title: ch?.title,
      path: ch?.path,
    });
    const pages = ch?.pages ? ` [${ch.pages}]` : '';
    const imgs = Array.isArray(ch?.available_images) ? ch.available_images.length : 0;
    const ctxLen = String(ch?.context || '').length;
    return `${i + 1}. ${label}${pages} · text ${ctxLen} chars · images ${imgs}`;
  });
  return [
    `Fetched ${chapters.length} chapter(s)${result?.truncated ? ' (truncated)' : ''}${result?.followUp ? ' [follow-up]' : ''}`,
    pathBlock,
    'Chapters:',
    ...lines,
  ].join('\n');
}

export async function executeAgentTool(
  name: string,
  rawArgs: string | Record<string, unknown>,
  ctx: AgentToolContext
): Promise<{ result: unknown; summary: string }> {
  if (ctx.signal?.aborted) {
    return {
      result: { ok: false, cancelled: true, error: 'User stopped generation' },
      summary: 'Cancelled',
    };
  }
  let args: any = {};
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
  } catch {
    return { result: { ok: false, error: 'Invalid JSON arguments' }, summary: 'Invalid arguments' };
  }

  switch (name) {
    case 'get_toc_bookmarks': {
      const result = await getTocBookmarks(args, ctx);
      return {
        result,
        summary: result?.ok
          ? `Retrieved TOC list (${result.tocEntryCount || 0} entries)`
          : `TOC retrieval failed: ${result?.error || 'unknown'}`,
      };
    }
    case 'select_toc_bookmarks': {
      const result = await selectTocBookmarks(args, ctx);
      return { result, summary: summarizeSelectedToc(result) };
    }
    case 'fetch_chapters_by_paths': {
      const result = await fetchChaptersByPaths(args, ctx);
      return { result, summary: summarizeFetchedChapters(result) };
    }
    default:
      return {
        result: { ok: false, error: `Unknown tool: ${name}` },
        summary: `Unknown tool: ${name}`,
      };
  }
}

export function summarizeToolArgs(name: string, rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs || '{}');
    if (name === 'get_toc_bookmarks') {
      const docs = Array.isArray(args.documentNumbers)
        ? args.documentNumbers.join(', ')
        : 'all selected';
      return `docs: ${docs} · complete TOC for main agent`;
    }
    if (name === 'select_toc_bookmarks') {
      const docs = Array.isArray(args.documentNumbers)
        ? args.documentNumbers.join(', ')
        : 'all selected';
      const parts = [`docs: ${docs}`];
      if (Array.isArray(args.paths) && args.paths.length) {
        parts.push(`main-agent paths (${args.paths.length}): ${args.paths.slice(0, 8).join(' · ')}`);
      } else {
        parts.push('return complete TOC to main agent');
      }
      if (args.query) parts.push(`query: ${String(args.query).trim()}`);
      if (args.focus) parts.push(`focus: ${String(args.focus).trim()}`);
      if (Array.isArray(args.alreadyHave) && args.alreadyHave.length) {
        parts.push(`alreadyHave: ${args.alreadyHave.slice(0, 8).join(' · ')}`);
      }
      return parts.join('\n');
    }
    if (name === 'fetch_chapters_by_paths') {
      const docs = Array.isArray(args.documentNumbers)
        ? args.documentNumbers.join(', ')
        : 'all selected';
      const parts = [`docs: ${docs}`];
      if (Array.isArray(args.paths) && args.paths.length) {
        parts.push(`paths (${args.paths.length}): ${args.paths.slice(0, 6).join(' · ')}`);
      } else {
        parts.push('paths: (reuse last select)');
      }
      if (typeof args.followUp === 'boolean') parts.push(`followUp: ${args.followUp}`);
      return parts.join('\n');
    }
  } catch {
    // ignore
  }
  return rawArgs.slice(0, 240);
}
