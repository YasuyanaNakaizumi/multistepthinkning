import { 
  generateSearchQueries, 
  selectTOCChapters,
  selectTOCChaptersInitial,
  judgeAnswerability, 
  extractElements, 
  detectMultiErrorCodes,
  classifyChapters,
  classifyAnswerPatterns,
  streamFinalAnswer 
} from './openai';
import { searchByTOCFilter, searchByTOCTitleFilter, hybridSearch } from './azureSearch';
import { createSasUrl, buildDirectBlobUrl, buildTOCPdfBlobName, blobExists, listBlobsByPrefix } from './azureBlob';
import { loadTOCMarkdown, flattenImageExplanations } from './tocLoader';
import { fetchTocByDocumentNumber, buildTocContent, FlatTocEntry } from './cosmosToc';
import { config } from '../config';
import { 
  SearchResult, 
  ThinkingStep, 
  MultiStepReasoningRequest,
  MultiStepReasoningResponse,
  SelectedDocument,
  ClassifiedResults,
  ChapterRef,
  ImageExplanation,
  AnswerPattern
} from '../types';

async function loadTOCsFromCosmos(documentNumbers: string[]): Promise<{ content: string; entries: FlatTocEntry[] }> {
  const entries: FlatTocEntry[] = [];
  const parts: string[] = [];

  for (const docNumber of documentNumbers) {
    try {
      const docEntries = await fetchTocByDocumentNumber(docNumber);
      if (docEntries.length > 0) {
        entries.push(...docEntries);
        parts.push(`# ${docNumber}\n${buildTocContent(docEntries)}`);
      }
    } catch (error) {
      console.warn(`Failed to load Cosmos TOC for ${docNumber}:`, (error as Error).message);
    }
  }

  return { content: parts.join('\n\n'), entries };
}

function keepExactPaths(selectedPaths: string[], entries: FlatTocEntry[]): string[] {
  const exactPathSet = new Set(entries.map((entry) => entry.path));
  return selectedPaths.map((path) => path.trim()).filter((path) => exactPathSet.has(path));
}

/** Trims a value so a single log line stays readable in the terminal. */
function short(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Renders a list as "a | b | c (+N more)" so long result sets stay on one line. */
function shortList(values: unknown[], limit = 5, itemMax = 46): string {
  if (values.length === 0) return 'none';
  const shown = values.slice(0, limit).map((v) => short(v, itemMax)).join(' | ');
  const rest = values.length - limit;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

function logStep(step: string, detail: string): void {
  console.log(`[Step] ${step}: ${detail}`);
}

function normalizeConnectorNo(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractConnectorTextFromImageExplanation(explanation: any): string {
  const parts: string[] = [];
  if (typeof explanation?.caption === 'string') parts.push(explanation.caption);
  if (typeof explanation?.ocr_text === 'string') parts.push(explanation.ocr_text);
  if (Array.isArray(explanation?.label_list)) parts.push(explanation.label_list.join(' '));
  if (Array.isArray(explanation?.md_anchor_quotes)) parts.push(explanation.md_anchor_quotes.join(' '));
  return parts.join(' ');
}

function imageExplanationMatchesConnectorNo(explanation: any, connectorNo: string): boolean {
  const normalizedConnectorNo = normalizeConnectorNo(connectorNo);
  if (!normalizedConnectorNo) return false;

  const normalizedText = normalizeConnectorNo(extractConnectorTextFromImageExplanation(explanation));
  if (!normalizedText) return false;

  const pattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(normalizedConnectorNo)}($|[^A-Z0-9])`);
  return pattern.test(normalizedText);
}

function filterImageExplanationsByConnectorNos(explanations: any[], connectorNos: string[]): any[] {
  const normalizedConnectorNos = Array.from(
    new Set((connectorNos || []).map((connectorNo) => normalizeConnectorNo(connectorNo)).filter(Boolean))
  );

  if (normalizedConnectorNos.length === 0) {
    return explanations;
  }

  return explanations.filter((explanation) =>
    normalizedConnectorNos.some((connectorNo) => imageExplanationMatchesConnectorNo(explanation, connectorNo))
  );
}

function normalizeContextSearchText(value: string): string {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownValue(value: string): string {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function extractConnectorEvidenceText(result: SearchResult): string {
  const parts: string[] = [result.TOC, result.content, result.documentTitle, result.documentNumber, result.fileName];
  if (result.image_content) {
    const explanations = flattenImageExplanations(result.image_content) as ImageExplanation[];
    for (const exp of explanations) {
      if (exp?.caption) parts.push(exp.caption);
      if (exp?.ocr_text) parts.push(exp.ocr_text);
      if (Array.isArray(exp?.label_list)) parts.push(exp.label_list.join(' '));
      if (Array.isArray(exp?.md_anchor_quotes)) parts.push(exp.md_anchor_quotes.join(' '));
    }
  }
  return normalizeContextSearchText(parts.filter(Boolean).join(' '));
}

function buildConnectorSectionForRefs(
  title: string,
  refs: ChapterRef[],
  refPdfUrlMap: Map<string, string>,
  includeImages: boolean = true
): string {
  const lines: string[] = [title];
  if (refs.length === 0) {
    lines.push('- なし');
    return lines.join('\n');
  }

  for (const ref of refs) {
    const result = ref.result;
    const pdfUrl = refPdfUrlMap.get(ref.ref_id) ?? '';
    lines.push(`- ${ref.ref_id}: ${escapeMarkdownValue(result.TOC)} | ${escapeMarkdownValue(result.documentNumber)} | pages ${result.start_page}-${result.end_page}${pdfUrl ? ` | ${pdfUrl}` : ''}`);
    if (includeImages && result.image_content) {
      const exps = filterImageExplanationsByConnectorNos(flattenImageExplanations(result.image_content), []);
      for (const exp of exps.slice(0, 5) as ImageExplanation[]) {
        lines.push(`  - image: ${escapeMarkdownValue(exp.caption || result.TOC)} | OCR: ${escapeMarkdownValue(exp.ocr_text)} | page ${exp.page_number}`);
      }
    }
  }

  return lines.join('\n');
}

function collectConnectorRefsForErrorCode(chapterRefs: ChapterRef[], errorCode: string): ChapterRef[] {
  const normalizedCode = normalizeConnectorNo(errorCode);
  if (!normalizedCode) return [];

  const connectorRefs = chapterRefs.filter((ref) => ref.is_connector);
  const matched = connectorRefs.filter((ref) => {
    const evidence = extractConnectorEvidenceText(ref.result);
    return evidence.includes(normalizedCode) || normalizeConnectorNo(ref.title).includes(normalizedCode);
  });

  return matched;
}

function isOperationAndMaintenanceManualDocument(document: SelectedDocument | undefined): boolean {
  const value = String(document?.documentType || '').toLowerCase();
  return value.includes('operation and maintenance manual') || value.includes('operationandmaintenancemanual');
}

export class MultiStepReasoningService {
  private thinkingSteps: ThinkingStep[] = [];
  private imageUrls: string[] = [];
  private pdfUrls: { title: string; url: string }[] = [];
  private imageSasUrlMap: Map<string, string> = new Map();
  private imageDirectoryCache: Map<string, string[]> = new Map();
  private refLinkMap: Map<string, string> = new Map();
  private refPdfUrlMap: Map<string, string> = new Map();
  private lastClassifiedResults: ClassifiedResults | null = null;
  private lastIgnoreChapters: { title: string; path?: string }[] = [];
  private lastElements: any = null;
  private lastMultiError: { isMulti: boolean; codes: string[]; reason?: string } = { isMulti: false, codes: [] };
  private lastAnswerPatterns: AnswerPattern[] = ['general'];
  private manualMode = false;
  private onStepUpdate: ((steps: ThinkingStep[]) => void) | null = null;

  private initThinkingSteps() {
    this.thinkingSteps = [
      { title: 'Generating Search Queries', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Selecting Relevant Paths', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Searching by Exact Path Filter', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Judging Answerability', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Extracting Elements', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Detecting Multiple Error Codes', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Additional Search', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Chapter Classification', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Classifying Answer Pattern(s)', description: '', status: 'pending', timestamp: new Date().toISOString() },
      { title: 'Preparing Context', description: '', status: 'pending', timestamp: new Date().toISOString() },
    ];

    if (this.onStepUpdate) {
      this.onStepUpdate(this.thinkingSteps);
    }
  }

  private setStep(index: number, patch: Partial<ThinkingStep>) {
    if (!this.thinkingSteps[index]) return;
    this.thinkingSteps[index] = {
      ...this.thinkingSteps[index],
      ...patch,
      timestamp: new Date().toISOString(),
    };

    if (this.onStepUpdate) {
      this.onStepUpdate(this.thinkingSteps);
    }
  }

  setProgressCallback(cb: ((steps: ThinkingStep[]) => void) | null) {
    this.onStepUpdate = cb;
  }

  getThinkingSteps(): ThinkingStep[] {
    return this.thinkingSteps;
  }

  getImageUrls(): string[] {
    return this.imageUrls;
  }

  getPdfUrls(): { title: string; url: string }[] {
    return this.pdfUrls;
  }

  private async findAllImageBlobsForResult(result: SearchResult): Promise<string[]> {
    const imageContent = (result as any).image_content as any;
    const explanations = flattenImageExplanations(imageContent);
    const knownImagePath = (explanations as ImageExplanation[])[0]?.cropped_image_path;
    const samePagePaths = ((result as any).same_page_paths || []) as string[];
    const samePageImage = samePagePaths.find((p) => /\.(jpg|jpeg|png|gif|webp)$/i.test(p));

    const documentId = (result as any).document_id as string | undefined;
    const documentNumber = (result as any).documentNumber as string | undefined;
    const fileNameField = (result as any).fileName as string | undefined;

    const dirs: string[] = [];
    if (knownImagePath && knownImagePath.includes('/')) {
      dirs.push(knownImagePath.replace(/›/g, '>').substring(0, knownImagePath.lastIndexOf('/')));
    }
    if (samePageImage && samePageImage.includes('/')) {
      const normalizedSamePageImage = samePageImage.replace(/›/g, '>');
      const dir = normalizedSamePageImage.substring(0, normalizedSamePageImage.lastIndexOf('/'));
      if (!dirs.includes(dir)) dirs.push(dir);
    }

    let documentFolder = '';
    let baseFile = '';
    if (documentId && documentNumber) {
      const lowerId = documentId.toLowerCase();
      const suffix = `_${documentNumber.toLowerCase()}`;
      documentFolder = lowerId.endsWith(suffix)
        ? lowerId.slice(0, lowerId.length - suffix.length)
        : lowerId;
      baseFile = fileNameField ? fileNameField.replace(/\.pdf$/i, '') : documentNumber;

      const chapterPaths = [result.path, result.TOC, (result as any).parent_path]
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.replace(/›/g, '>').trim());

      for (const chapterPath of chapterPaths) {
        const dir = `pdfs/processed/${documentFolder}/images/${baseFile}/${chapterPath}`;
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }

    const allBlobs: string[] = [];
    for (const dir of dirs) {
      const cached = this.imageDirectoryCache.get(dir);
      if (cached) {
        allBlobs.push(...cached);
        continue;
      }
      const list = await listBlobsByPrefix(`${dir}/`);
      const imageList = list.filter((p) => /\.(jpg|jpeg|png|gif|webp)$/i.test(p));
      this.imageDirectoryCache.set(dir, imageList);
      allBlobs.push(...imageList);
    }

    // Fallback: if no specific images were found, list the entire document image directory
    if (allBlobs.length === 0 && documentFolder && baseFile) {
      const baseDir = `pdfs/processed/${documentFolder}/images/${baseFile}`;
      const cached = this.imageDirectoryCache.get(baseDir);
      if (cached) {
        allBlobs.push(...cached);
      } else {
        const list = await listBlobsByPrefix(`${baseDir}/`);
        const imageList = list.filter((p) => /\.(jpg|jpeg|png|gif|webp)$/i.test(p));
        this.imageDirectoryCache.set(baseDir, imageList);
        allBlobs.push(...imageList);
      }
    }

    return Array.from(new Set(allBlobs));
  }

  /**
   * Registers an image blob and returns its file name.
   * The final answer only ever references images by file name; the SAS URL is
   * injected by the backend afterwards via imageSasUrlMap.
   */
  private async registerImageUrl(blobPath: string): Promise<string> {
    const fileName = blobPath.split('/').pop() || blobPath;
    const key = fileName.toLowerCase();
    if (this.imageSasUrlMap.has(key)) return fileName;
    const sasImageUrl = await createSasUrl(blobPath);
    this.imageSasUrlMap.set(key, sasImageUrl);
    this.imageUrls.push(sasImageUrl);
    return fileName;
  }

  private async resolveContentImageUrl(result: SearchResult, fileName: string): Promise<string | null> {
    const allBlobs = await this.findAllImageBlobsForResult(result);
    const matched = allBlobs.find(
      (b) => b.split('/').pop()?.toLowerCase() === fileName.toLowerCase()
    );
    if (matched) return createSasUrl(matched);

    // Fallback: a known image in the result already references this exact filename
    const imageContent = (result as any).image_content as any;
    const explanations = flattenImageExplanations(imageContent);
    const existing = (explanations as ImageExplanation[]).find(
      (e) => e.cropped_image_path && e.cropped_image_path.split('/').pop()?.toLowerCase() === fileName.toLowerCase()
    );
    if (existing?.cropped_image_path) return createSasUrl(existing.cropped_image_path);

    const samePagePaths = ((result as any).same_page_paths || []) as string[];
    const samePageMatch = samePagePaths.find((p) => p.split('/').pop()?.toLowerCase() === fileName.toLowerCase());
    if (samePageMatch) return createSasUrl(samePageMatch);

    // Try known image directory directly
    const knownImagePath = (explanations as ImageExplanation[])[0]?.cropped_image_path;
    if (knownImagePath) {
      const dir = knownImagePath.replace(/›/g, '>').substring(0, knownImagePath.lastIndexOf('/'));
      const candidate = `${dir}/${fileName}`;
      if (await blobExists(candidate)) return createSasUrl(candidate);
    }

    // Try derived chapter/base image directories
    const documentId = (result as any).document_id as string | undefined;
    const documentNumber = (result as any).documentNumber as string | undefined;
    const fileNameField = (result as any).fileName as string | undefined;
    if (documentId && documentNumber) {
      const lowerId = documentId.toLowerCase();
      const suffix = `_${documentNumber.toLowerCase()}`;
      const documentFolder = lowerId.endsWith(suffix) ? lowerId.slice(0, lowerId.length - suffix.length) : lowerId;
      const baseFile = fileNameField ? fileNameField.replace(/\.pdf$/i, '') : documentNumber;
      const chapterPaths = [result.path, result.TOC, (result as any).parent_path]
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.replace(/›/g, '>').trim());
      for (const chapterPath of chapterPaths) {
        const candidate = `pdfs/processed/${documentFolder}/images/${baseFile}/${chapterPath}/${fileName}`;
        if (await blobExists(candidate)) return createSasUrl(candidate);
      }
      const baseCandidate = `pdfs/processed/${documentFolder}/images/${baseFile}/${fileName}`;
      if (await blobExists(baseCandidate)) return createSasUrl(baseCandidate);
    }

    return null;
  }

  private addThinkingStep(title: string, description: string, status: ThinkingStep['status'] = 'completed') {
    this.thinkingSteps.push({
      title,
      description,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  private updateThinkingStep(index: number, status: ThinkingStep['status'], error?: string) {
    if (this.thinkingSteps[index]) {
      this.thinkingSteps[index].status = status;
      if (error) {
        this.thinkingSteps[index].error = error;
      }
    }
  }

  async processRequest(request: MultiStepReasoningRequest): Promise<MultiStepReasoningResponse> {
    this.manualMode = Array.isArray(request.selectedDocuments)
      ? request.selectedDocuments.some((document) => isOperationAndMaintenanceManualDocument(document))
      : false;
    const selectedDocuments = request.selectedDocuments || [];
    const selectedPdfs = request.selectedPdfs ||
      (selectedDocuments.length
        ? selectedDocuments.map((d) => d.documentNumber)
        : []);
    return this.run(request.query, selectedPdfs, selectedDocuments, request.chatHistory ?? []);
  }

  async run(query: string, selectedPdfs: string[], selectedDocuments: SelectedDocument[] = [], chatHistory: any[] = []): Promise<MultiStepReasoningResponse> {
    const requestStartedAt = Date.now();

    // Reset per-request state
    this.imageUrls = [];
    this.pdfUrls = [];
    this.imageSasUrlMap = new Map();
    this.imageDirectoryCache = new Map();
    this.refLinkMap = new Map();
    this.refPdfUrlMap = new Map();
    this.lastClassifiedResults = null;
    this.lastIgnoreChapters = [];
    this.lastElements = null;
    this.lastMultiError = { isMulti: false, codes: [] };
    this.lastAnswerPatterns = ['general'];
    this.manualMode = this.manualMode && selectedPdfs.length > 0;
    this.initThinkingSteps();

    const ommDocNumbers = selectedDocuments
      .filter((d) => isOperationAndMaintenanceManualDocument(d))
      .map((d) => d.documentNumber);
    const shopDocNumbers = selectedDocuments.length
      ? selectedDocuments.filter((d) => !isOperationAndMaintenanceManualDocument(d)).map((d) => d.documentNumber)
      : selectedPdfs;
    const hasOmm = ommDocNumbers.length > 0;
    const hasShop = shopDocNumbers.length > 0;

    const searchTocAcrossIndexes = async (tocTitles: string[], useTitleFilter: boolean): Promise<SearchResult[]> => {
      const results: SearchResult[] = [];
      if (hasShop) {
        const shopResults = useTitleFilter
          ? await searchByTOCTitleFilter(tocTitles, shopDocNumbers, config.azureSearch.indexName)
          : await searchByTOCFilter(tocTitles, shopDocNumbers, config.azureSearch.indexName);
        results.push(...shopResults);
      }
      if (hasOmm) {
        const ommResults = useTitleFilter
          ? await searchByTOCTitleFilter(tocTitles, ommDocNumbers, config.azureSearch.indexNameOmm)
          : await searchByTOCFilter(tocTitles, ommDocNumbers, config.azureSearch.indexNameOmm);
        results.push(...ommResults);
      }
      if (!hasShop && !hasOmm) {
        const fallbackResults = useTitleFilter
          ? await searchByTOCTitleFilter(tocTitles, selectedPdfs, config.azureSearch.indexName)
          : await searchByTOCFilter(tocTitles, selectedPdfs, config.azureSearch.indexName);
        results.push(...fallbackResults);
      }
      return results;
    };

    const hybridAcrossIndexes = async (q: string, top: number): Promise<SearchResult[]> => {
      const results: SearchResult[] = [];
      if (hasShop) {
        results.push(...(await hybridSearch(q, shopDocNumbers, top, config.azureSearch.indexName)));
      }
      if (hasOmm) {
        results.push(...(await hybridSearch(q, ommDocNumbers, top, config.azureSearch.indexNameOmm)));
      }
      if (!hasShop && !hasOmm) {
        results.push(...(await hybridSearch(q, selectedPdfs, top, config.azureSearch.indexName)));
      }
      return results;
    };

    // Validate config early to avoid confusing runtime errors
    if (!config.azureSearch.endpoint || !config.azureSearch.indexName || !config.azureSearch.apiKey) {
      this.setStep(2, {
        status: 'error',
        description:
          'Azure AI Search configuration is missing. Please set AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_INDEX_NAME (shop manual) / AZURE_SEARCH_INDEX_NAME_OMM (operation & maintenance manual) / AZURE_SEARCH_API_KEY.',
        error: 'Missing Azure AI Search configuration',
      });
      return {
        answer: '',
        thinkingSteps: this.thinkingSteps,
        imageUrls: [],
        pdfUrls: [],
        followupQuestions: [],
      };
    }

    // Step 1: Generate Search Queries
    this.setStep(0, { status: 'in_progress', description: 'Extracting search queries and identifiers from user query' });
    let queriesResult = { queries: [query], has_codes: false };
    try {
      queriesResult = await generateSearchQueries(query, chatHistory);
      logStep('1 search queries', `${queriesResult.queries.length} query(ies) | hasCodes=${queriesResult.has_codes} -> ${shortList(queriesResult.queries)}`);
      this.setStep(0, {
        status: 'completed',
        description: `Generated ${queriesResult.queries.length} query(ies): ${queriesResult.queries.slice(0, 3).join(', ')}${queriesResult.queries.length > 3 ? '...' : ''}. Has codes: ${queriesResult.has_codes}`,
      });
    } catch (error) {
      this.setStep(0, { status: 'error', description: 'Failed to generate search queries', error: (error as Error).message });
      throw error;
    }

    // Step 2: Select TOC Chapters
    this.setStep(1, { status: 'in_progress', description: 'Loading TOC from Cosmos DB and selecting relevant paths' });
    let tocChapters: string[] = [];
    let tocEntries: FlatTocEntry[] = [];
    try {
      const cosmosToc = await loadTOCsFromCosmos(selectedPdfs);
      let tocContent = cosmosToc.content;
      tocEntries = cosmosToc.entries;

      if (!tocContent) {
        // Fallback to legacy markdown TOC if Cosmos is empty/unavailable.
        tocContent = loadTOCMarkdown(selectedPdfs) || '';
      }

      if (!tocContent) {
        this.setStep(1, { status: 'completed', description: 'No TOC content found. Skipping chapter selection.' });
        tocChapters = [];
      } else {
        const chaptersResult = await selectTOCChaptersInitial(queriesResult.queries, query, tocContent);
        tocChapters = tocEntries.length > 0
          ? keepExactPaths(chaptersResult.chapters, tocEntries)
          : chaptersResult.chapters.map((chapter) => chapter.trim());
        logStep('2 TOC chapters (initial)', `${tocChapters.length} selected -> ${shortList(tocChapters)}`);
        this.setStep(1, {
          status: 'completed',
          description: `Selected ${tocChapters.length} path(s): ${tocChapters.slice(0, 5).join(', ')}${tocChapters.length > 5 ? '...' : ''}`,
        });
      }
    } catch (error) {
      this.setStep(1, { status: 'error', description: 'Failed to select paths from TOC', error: (error as Error).message });
      tocChapters = [];
    }

    // Step 3: Search by TOC / Path Filter
    this.setStep(2, { status: 'in_progress', description: 'Performing Azure AI Search with exact path filter' });
    let initialResults: SearchResult[] = [];
    try {
      if (tocChapters.length > 0) {
        initialResults = await searchTocAcrossIndexes(tocChapters, tocEntries.length > 0);
      }
      logStep('3 search (initial)', `${initialResults.length} hit(s) -> ${shortList(Array.from(new Set(initialResults.map((r) => r.TOC))))}`);
      this.setStep(2, { status: 'completed', description: `Found ${initialResults.length} result(s) from exact path filter search. Using document filter: ${selectedPdfs.includes('All Documents') ? 'All Documents' : selectedPdfs.join(', ')}` });
    } catch (error) {
      this.setStep(2, { status: 'error', description: 'Path filter search failed', error: (error as Error).message });
      initialResults = [];
    }

    // Step 4: Judge Answerability
    this.setStep(3, { status: 'in_progress', description: 'Determining if search results can answer the query' });
    let answerable = false;
    try {
      const judgment = await judgeAnswerability(query, queriesResult.queries, initialResults);
      answerable = judgment.answerable;
      logStep('4 answerable?', `${answerable} | ${short(judgment.reason, 110)}`);
      this.setStep(3, {
        status: 'completed',
        description: `Results are ${answerable ? 'sufficient' : 'insufficient'}. ${judgment.reason}`,
      });
    } catch (error) {
      this.setStep(3, { status: 'error', description: 'Answerability judgment failed', error: (error as Error).message });
      answerable = false;
    }

    // Fallback: Hybrid Search if not answerable
    if (!answerable) {
      this.setStep(2, { status: 'in_progress', description: 'Fallback: Performing hybrid vector + text search' });
      try {
        for (const q of queriesResult.queries) {
          const hybridResults = await hybridAcrossIndexes(q, 5);
          // Deduplicate by id
          const existingIds = new Set(initialResults.map(r => r.id));
          for (const result of hybridResults) {
            if (!existingIds.has(result.id)) {
              initialResults.push(result);
              existingIds.add(result.id);
            }
          }
        }
        this.setStep(2, { status: 'completed', description: `Hybrid search completed. Total results: ${initialResults.length}` });
      } catch (error) {
        this.setStep(2, { status: 'error', description: 'Hybrid search failed', error: (error as Error).message });
      }
    }

    // Step 5a: Extract Elements
    this.setStep(4, { status: 'in_progress', description: 'Analyzing documents for additional elements' });
    let elements: any;
    try {
      let extractTocContent = '';
      try {
        const cosmosToc = await loadTOCsFromCosmos(selectedPdfs);
        extractTocContent = cosmosToc.content;
      } catch {
        // ignore
      }
      if (!extractTocContent) {
        extractTocContent = loadTOCMarkdown(selectedPdfs) || '';
      }
      const retrievedChapterBodies = initialResults
        .map((result) => `Chapter: ${result.TOC || result.path || ''}\n${result.content || ''}`)
        .filter((block) => block.trim().length > 0)
        .join('\n\n');
      const textContext = [
        retrievedChapterBodies ? `## Retrieved Chapter Content\n${retrievedChapterBodies}` : '',
        extractTocContent ? `## Table of Contents\n${extractTocContent}` : '',
      ].filter(Boolean).join('\n\n');
      elements = await extractElements(query, textContext, chatHistory);
      logStep(
        '5 extracted elements',
        `codes=${shortList(elements.error_codes || [], 4, 12)} | connectors=${shortList(elements.connectors || [], 4, 12)} | ` +
          `refs=${(elements.reference_chapters || []).length} | components=${shortList(elements.components || [], 3, 20)} | followup=${!!elements.needs_followup}`
      );

      if (this.manualMode) {
        const referenceChapters = Array.isArray(elements?.reference_chapters) ? elements.reference_chapters : [];
        const filteredReferenceChapters = referenceChapters.filter(
          (c: any) => !/コネクタ|connector|立体配置図|3d layout|配線|wiring/i.test(String(c))
        );
        elements = {
          ...elements,
          error_codes: elements.error_codes || [],
          connectors: elements.connectors || [],
          reference_chapters: filteredReferenceChapters,
          diagnostic_chapters: elements.diagnostic_chapters || [],
          components: elements.components || [],
          needs_followup: !!elements?.needs_followup,
        };
      }

      const gptNeedsFollowup = !!elements?.needs_followup;

      // Heuristic safety net: failure codes / troubleshooting intent should trigger followup search
      const looksLikeFailureCode = /\b[A-Z]{1,3}\d{2,5}\b/.test(query);
      const looksDiagnostic = /(故障|異常|診断|点検|トラブル|エラー|failure\s*code|fault|diagnos|troubleshoot|inspection)/i.test(query);
      const heuristicForcesFollowup = looksLikeFailureCode || looksDiagnostic;
      if (heuristicForcesFollowup) {
        elements.needs_followup = true;
      }

      this.setStep(4, {
        status: 'completed',
        description: `Extracted elements. Error codes: ${elements.error_codes.length}, Connectors: ${elements.connectors.length}, References: ${elements.reference_chapters.length}. Needs followup: ${elements.needs_followup} (GPT=${gptNeedsFollowup}${heuristicForcesFollowup ? ', forced by heuristic' : ''})`,
      });

      this.lastElements = elements;
    } catch (error) {
      this.setStep(4, { status: 'error', description: 'Element extraction failed', error: (error as Error).message });
      elements = { needs_followup: false };
      this.lastElements = elements;
    }

    // Step 5a2: Detect Multiple Error Codes (GPT)
    this.setStep(5, { status: 'in_progress', description: 'Detecting whether the query includes multiple error codes' });
    try {
      const extractedCodes: string[] = Array.isArray(elements?.error_codes) ? elements.error_codes : [];
      const det = await detectMultiErrorCodes(query, extractedCodes, chatHistory);
      this.lastMultiError = {
        isMulti: !!det?.is_multi_error_codes,
        codes: Array.isArray(det?.error_codes) ? det.error_codes : [],
        reason: det?.reason,
      };
      logStep('6 multi error codes', `${this.lastMultiError.isMulti} | codes=${shortList(this.lastMultiError.codes || [], 6, 12)}`);
      this.setStep(5, {
        status: 'completed',
        description: `Multi-error-code: ${this.lastMultiError.isMulti}. Codes: ${(this.lastMultiError.codes || []).join(', ') || 'none'}`,
      });
    } catch (error) {
      this.lastMultiError = { isMulti: false, codes: [] };
      this.setStep(5, { status: 'error', description: 'Multi-error-code detection failed', error: (error as Error).message });
    }

    // Step 5b: Additional Search (if needed)
    let additionalResults: SearchResult[] = [];
    if (elements.needs_followup) {
      this.setStep(6, { status: 'in_progress', description: 'Performing additional TOC-based search from extracted elements' });
      try {
        const errorCodes: string[] = elements.error_codes || [];
        const connectors: string[] = elements.connectors || [];
        const referenceChapters: string[] = elements.reference_chapters || [];
        const diagnosticChapters: string[] = elements.diagnostic_chapters || [];
        const components: string[] = elements.components || [];

        const normalizedQuery = query.toLowerCase();
        const alreadyRetrievedChapterText = initialResults
          .map((result) => `${result.TOC || ''}\n${result.path || ''}`)
          .join('\n')
          .toLowerCase();

        const shouldKeepTerm = (term: string) => {
          const normalizedTerm = term.trim().toLowerCase();
          if (!normalizedTerm) return false;
          if (normalizedQuery.includes(normalizedTerm)) return false;
          // A mention inside retrieved BODY text is not enough: the referenced chapter
          // itself may still be missing. Only skip terms that match an already retrieved TOC/path.
          return !alreadyRetrievedChapterText.includes(normalizedTerm);
        };

        const filteredErrorCodes = Array.from(new Set(errorCodes))
          .map((code) => code.trim())
          .filter((code) => code.length > 0)
          .filter(shouldKeepTerm);

        const hasConnectorContext = filteredErrorCodes.length > 0 || connectors.length > 0 || diagnosticChapters.some((c) => /コネクタ|connector|配線|wiring|故障診断|troubleshoot|診断|diagnostic/i.test(String(c)));

        const filteredReferenceChapters = hasConnectorContext
          ? referenceChapters
          : referenceChapters.filter((c) => !/コネクタ|connector|立体配置図|3d layout|配線|wiring/i.test(String(c)));

        const connectorKeywords = hasConnectorContext
          ? ['connector list and layout', '3D立体配置図', 'connector layout', 'connector location', '3D layout diagram']
          : [];

        const tocSearchTerms = Array.from(new Set([
          ...filteredErrorCodes,
          ...connectors,
          ...filteredReferenceChapters,
          ...diagnosticChapters,
          ...components,
          ...connectorKeywords,
        ].map((value) => value.trim()).filter(Boolean))).filter(shouldKeepTerm);

        logStep('7 followup search terms', `${tocSearchTerms.length} term(s) -> ${shortList(tocSearchTerms)}`);

        let additionalTocContent = '';
        let additionalTocEntries: FlatTocEntry[] = [];
        try {
          const cosmosToc = await loadTOCsFromCosmos(selectedPdfs);
          additionalTocContent = cosmosToc.content;
          additionalTocEntries = cosmosToc.entries;
        } catch {
          // ignore
        }
        if (!additionalTocContent) {
          additionalTocContent = loadTOCMarkdown(selectedPdfs) || '';
        }

        if (additionalTocContent) {
          const alreadySearchedChapters = Array.from(
            new Map(
              initialResults
                .map((result) => ({
                  title: (result.TOC || '').trim(),
                  path: (result.path || '').trim(),
                }))
                .filter((chapter) => chapter.title || chapter.path)
                .map((chapter) => [chapter.path || chapter.title, chapter])
            ).values()
          );
          logStep(
            '7 already searched chapters',
            `${alreadySearchedChapters.length} chapter(s) -> ${shortList(alreadySearchedChapters.map((chapter) => chapter.path || chapter.title))}`
          );
          const chaptersResult = await selectTOCChapters(
            tocSearchTerms,
            query,
            additionalTocContent,
            alreadySearchedChapters
          );
          const alreadyPathSet = new Set(alreadySearchedChapters.map((chapter) => chapter.path).filter(Boolean));
          const selectedAdditionalPaths = (
            additionalTocEntries.length > 0
              ? keepExactPaths(chaptersResult.chapters, additionalTocEntries)
              : chaptersResult.chapters.map((chapter) => chapter.trim())
          ).filter((path) => path && !alreadyPathSet.has(path));
          const pathToTitle = new Map(
            additionalTocEntries.map((entry) => [entry.path, (entry.title || '').trim()])
          );
          const selectedAdditionalTitles = Array.from(
            new Set(
              selectedAdditionalPaths
                .map((path) => pathToTitle.get(path) || path)
                .map((title) => title.replace(/\s+/g, ' ').trim())
                .filter(Boolean)
            )
          );
          logStep(
            '7 TOC chapters (followup)',
            `${selectedAdditionalTitles.length} selected -> ${selectedAdditionalTitles.length > 0 ? selectedAdditionalTitles.join(' | ') : 'none'}`
          );
          if (selectedAdditionalPaths.length > 0) {
            additionalResults = await searchTocAcrossIndexes(selectedAdditionalPaths, additionalTocEntries.length > 0);
            additionalResults.forEach(r => r._search_type = 'additional_toc');
          }
        }
        const followupTocTitles = Array.from(
          new Set(
            additionalResults
              .map((result) => (result.TOC || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
        );
        logStep(
          '7 search (followup)',
          `${additionalResults.length} hit(s) -> ${followupTocTitles.length > 0 ? followupTocTitles.join(' | ') : 'none'}`
        );
        this.setStep(6, { status: 'completed', description: `Additional search completed. Found ${additionalResults.length} result(s)` });
      } catch (error) {
        this.setStep(6, { status: 'error', description: 'Additional search failed', error: (error as Error).message });
      }
    } else {
      this.setStep(6, { status: 'completed', description: 'Skipped additional search (needs_followup=false)' });
    }

    // Step 5c: Classify Chapters
    this.setStep(7, { status: 'in_progress', description: 'Classifying chapters into MAIN/SUB/CONNECTOR/IGNORE' });
    let classifiedResults: ClassifiedResults;
    try {
      const allResults = [...initialResults, ...additionalResults];
      const seenIds = new Set();
      const uniqueResults = allResults.filter(r => {
        if (seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return true;
      });

      const extractImageCaptions = (imageContent: any): string[] => {
        if (!imageContent) return [];
        const exps = flattenImageExplanations(imageContent) as ImageExplanation[];
        const captions = exps
          .map((e) => (e?.caption || '').trim())
          .filter(Boolean);
        return Array.from(new Set(captions)).slice(0, 20);
      };

      const extractImageOcrTexts = (imageContent: any): string[] => {
        if (!imageContent) return [];
        const exps = flattenImageExplanations(imageContent) as ImageExplanation[];
        const ocrs = exps
          .map((e) => (e?.ocr_text || '').trim())
          .filter(Boolean);
        return Array.from(new Set(ocrs)).slice(0, 20);
      };

      const chapterList = uniqueResults.map((r, idx) => ({
        index: idx,
        title: r.TOC,
        search_type: r._search_type || 'initial',
        content_excerpt: r.content.substring(0, 12000),
        image_captions: extractImageCaptions(r.image_content),
        image_ocr_texts: extractImageOcrTexts(r.image_content),
      }));

      const classification = await classifyChapters(
        query,
        chapterList,
        [...(elements.reference_chapters || []), ...(elements.diagnostic_chapters || [])]
      );

      const referenceHints = [
        ...(elements.reference_chapters || []),
        ...(elements.diagnostic_chapters || []),
        'CHECK ELECTRIC EQUIPMENT',
        'CHECKS BEFORE TROUBLESHOOTING',
        'Electrical equipment',
      ].map((title) => String(title || '').trim()).filter(Boolean);

      const normalizeTitleKey = (value: string) =>
        String(value || '')
          .toLowerCase()
          .replace(/electrical\s+equipment/g, 'electric equipment')
          .replace(/[^a-z0-9]+/g, '');
      const matchesReferencedChapter = (toc: string) => {
        const key = normalizeTitleKey(toc);
        if (!key) return false;
        return referenceHints.some((hint) => {
          const hintKey = normalizeTitleKey(hint);
          return hintKey.length >= 4 && (key.includes(hintKey) || hintKey.includes(key));
        });
      };
      const isConnectorPriorityChapter = (toc: string) =>
        /connector list|connector layout|connector location|立体配置|3d layout/i.test(toc);

      const used = new Set<number>([
        ...(classification.main || []),
        ...(classification.connector || []),
        ...(classification.sub || []),
      ]);
      const promotedSub: number[] = [];
      const promotedConnector: number[] = [];
      uniqueResults.forEach((result, index) => {
        if (used.has(index)) return;
        if (isConnectorPriorityChapter(result.TOC)) {
          promotedConnector.push(index);
          used.add(index);
          return;
        }
        if (matchesReferencedChapter(result.TOC)) {
          promotedSub.push(index);
          used.add(index);
        }
      });

      const subIndexes = Array.from(new Set([...promotedSub, ...(classification.sub || [])])).slice(0, 10);
      const connectorIndexes = Array.from(new Set([...(classification.connector || []), ...promotedConnector]));
      const mainIndexes = classification.main || [];
      const assigned = new Set([...mainIndexes, ...connectorIndexes, ...subIndexes]);
      const ignoreIndexes = uniqueResults.map((_, index) => index).filter((index) => !assigned.has(index));

      classifiedResults = {
        main: uniqueResults.filter((_, i) => mainIndexes.includes(i)),
        connector: uniqueResults.filter((_, i) => connectorIndexes.includes(i)),
        sub: uniqueResults.filter((_, i) => subIndexes.includes(i)),
      };

      logStep('8 chapter classification', `MAIN=${classifiedResults.main.length} CONNECTOR=${classifiedResults.connector.length} SUB=${classifiedResults.sub.length} IGNORE=${(classification.ignore || []).length}`);
      logStep('8 MAIN', shortList(classifiedResults.main.map((r) => r.TOC)));
      if (classifiedResults.connector.length > 0) {
        logStep('8 CONNECTOR', shortList(classifiedResults.connector.map((r) => r.TOC)));
      }
      logStep('8 SUB', shortList(classifiedResults.sub.map((r) => r.TOC)));

      this.lastClassifiedResults = classifiedResults;
      this.lastIgnoreChapters = ignoreIndexes
        .map((index) => uniqueResults[index])
        .filter(Boolean)
        .map((result) => ({ title: result.TOC, path: result.path }));

      this.setStep(7, {
        status: 'completed',
        description: `Classification completed. MAIN: ${classifiedResults.main.length}, CONNECTOR: ${classifiedResults.connector.length}, SUB: ${classifiedResults.sub.length}`,
      });
    } catch (error) {
      this.setStep(7, { status: 'error', description: 'Chapter classification failed', error: (error as Error).message });
      const allResults = [...initialResults, ...additionalResults];
      classifiedResults = {
        main: allResults,
        connector: [],
        sub: [],
      };

      this.lastClassifiedResults = classifiedResults;
      this.lastIgnoreChapters = [];
    }

    // Step 6b: Classify final answer pattern(s)
    this.setStep(8, { status: 'in_progress', description: 'Classifying final answer pattern(s)' });
    try {
      const patternResponse = await classifyAnswerPatterns(query, chatHistory, elements, this.lastMultiError);
      const rawPatterns = patternResponse.patterns && patternResponse.patterns.length > 0
        ? patternResponse.patterns
        : (['general'] as AnswerPattern[]);
      this.lastAnswerPatterns = this.manualMode
        ? rawPatterns.filter((pattern) => pattern === 'general' || pattern === 'maintenance').length > 0
          ? rawPatterns.filter((pattern) => pattern === 'general' || pattern === 'maintenance')
          : (['general'] as AnswerPattern[])
        : rawPatterns;
      logStep('9 answer patterns', `${this.lastAnswerPatterns.join(', ')} | ${short(patternResponse.reason, 90)}`);
      this.setStep(8, {
        status: 'completed',
        description: `Answer patterns: ${this.lastAnswerPatterns.join(', ')}`,
      });
    } catch (error) {
      this.lastAnswerPatterns = ['general'];
      this.setStep(8, { status: 'error', description: 'Answer pattern classification failed', error: (error as Error).message });
    }

    // Build context and prepare for streaming
    this.setStep(9, { status: 'in_progress', description: 'Building context for final answer generation' });
    try {
      const builtContext = await this.buildContext(classifiedResults);
      logStep(
        '10 context built',
        `${Math.round(builtContext.length / 1000)}k chars | refs=${classifiedResults.main.length + classifiedResults.connector.length + classifiedResults.sub.length} | ` +
          `images=${this.imageSasUrlMap.size} | pdf links=${this.pdfUrls.length} | connectorSection=${classifiedResults.connector.length > 0}`
      );
      this.setStep(9, { status: 'completed', description: 'Context prepared (SAS links + image refs ready)' });
    } catch (error) {
      this.setStep(9, { status: 'error', description: 'Context building failed', error: (error as Error).message });
    }

    // Step 7: Followups (simple heuristic)
    const followupQuestions = this.generateFollowupQuestions(query, elements);

    const elapsedMsToAnswerReady = Date.now() - requestStartedAt;
    this.addThinkingStep(
      'Answer Start Time',
      `回答開始まで ${elapsedMsToAnswerReady}ms かかりました。` +
        `（この時点で回答ストリーミング開始準備が完了しています）`
    );

    return {
      answer: '', // Will be streamed separately
      thinkingSteps: this.thinkingSteps,
      imageUrls: this.imageUrls,
      pdfUrls: this.pdfUrls,
      followupQuestions,
    };
  }

  private generateFollowupQuestions(query: string, elements: any): string[] {
    const qs: string[] = [];
    if (elements?.error_codes?.length) {
      qs.push(`エラーコード ${elements.error_codes[0]} の原因と点検手順は？`);
    }
    if (elements?.connectors?.length) {
      qs.push(`コネクタ ${elements.connectors[0]} のピン配置・配線図は？`);
    }
    if (elements?.components?.length) {
      qs.push(`${elements.components[0]} の取り外し/取り付け手順は？`);
    }
    if (qs.length < 3) {
      qs.push(`${query} に関連する注意事項（警告・注意）は？`);
    }
    return Array.from(new Set(qs)).slice(0, 5);
  }

  private async buildContext(classifiedResults: ClassifiedResults): Promise<string> {
    const allResults = [...classifiedResults.main, ...classifiedResults.connector, ...classifiedResults.sub];
    const chapterRefs: ChapterRef[] = [];
    this.refLinkMap = new Map();
    this.refPdfUrlMap = new Map();
    const debugUrls = {
      pdfCitationUrls: [] as Array<{ refId: string; title: string; url: string }>,
      imageUrls: [] as Array<{ refId: string; title: string; source: string; url: string }>,
    };

    // Build chapter refs and pre-compute SAS URLs
    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i];
      const refId = `shop-${i + 1}`;
      const isMain = classifiedResults.main.includes(result);
      const isConnector = classifiedResults.connector.includes(result);

      chapterRefs.push({
        ref_id: refId,
        title: result.TOC,
        result,
        is_main: isMain,
        is_connector: isConnector,
      });

      // Pre-compute PDF SAS URL
      const pdfBlobPath = await buildTOCPdfBlobName(result);
      if (pdfBlobPath) {
        const sasPdfUrl = await createSasUrl(pdfBlobPath);
        // Use angle brackets to keep markdown links valid even when URL contains ')'
        this.refLinkMap.set(refId, `[${result.TOC.replace(/\[/g, '(').replace(/\]/g, ')')}](<${sasPdfUrl}>)`);
        this.refPdfUrlMap.set(refId, sasPdfUrl);
        this.pdfUrls.push({ title: result.TOC, url: sasPdfUrl });
        debugUrls.pdfCitationUrls.push({ refId, title: result.TOC, url: sasPdfUrl });
      }

      // Process image content
      if (result.image_content) {
        const explanations = flattenImageExplanations(result.image_content);
        for (const exp of explanations as ImageExplanation[]) {
          if (exp.cropped_image_path) {
            const sasImageUrl = await createSasUrl(exp.cropped_image_path);
            this.imageUrls.push(sasImageUrl);
            debugUrls.imageUrls.push({
              refId,
              title: exp.caption || result.TOC,
              source: 'cropped_image_path',
              url: sasImageUrl,
            });
          }
        }

        const imageSamePagePaths = (result.same_page_paths || []).filter((p) =>
          /\.(jpg|jpeg|png|gif|webp)$/i.test(p) || p.includes('/images/')
        );
        for (const path of imageSamePagePaths) {
          const sasImageUrl = await createSasUrl(path);
          this.imageUrls.push(sasImageUrl);
          debugUrls.imageUrls.push({
            refId,
            title: result.TOC,
            source: 'same_page_paths',
            url: sasImageUrl,
          });
        }
      }

    }

    // Build combined context
    let combinedContext = '';
    const extractedConnectorNos = Array.isArray(this.lastElements?.connectors)
      ? this.lastElements.connectors.map((connectorNo: string) => String(connectorNo)).filter(Boolean)
      : [];

    // Provide extracted elements up-front for answer formatting (connector/component tables)
    if (this.lastElements) {
      combinedContext += `EXTRACTED_ELEMENTS_JSON: ${JSON.stringify(this.lastElements)}\n`;
      if (Array.isArray(this.lastElements.connectors) && this.lastElements.connectors.length > 0) {
        combinedContext += `EXTRACTED_CONNECTORS: ${this.lastElements.connectors.join(', ')}\n`;
      }
      if (Array.isArray(this.lastElements.components) && this.lastElements.components.length > 0) {
        combinedContext += `EXTRACTED_COMPONENTS: ${this.lastElements.components.join(', ')}\n`;
      }
      if (this.lastMultiError?.isMulti && Array.isArray(this.lastMultiError.codes) && this.lastMultiError.codes.length >= 2) {
        combinedContext += `IS_MULTI_ERROR_CODES: true\n`;
        combinedContext += `MULTI_ERROR_CODES: ${this.lastMultiError.codes.join(', ')}\n`;
      } else {
        combinedContext += `IS_MULTI_ERROR_CODES: false\n`;
      }
      combinedContext += `---\n`;
    }

    combinedContext += `CHAPTER_CLASSIFICATION_JSON: ${JSON.stringify(
      {
        main: chapterRefs
          .filter((ref) => ref.is_main)
          .map((ref) => ({ ref_id: ref.ref_id, title: ref.title })),
        sub: chapterRefs
          .filter((ref) => !ref.is_main && !ref.is_connector)
          .map((ref) => ({ ref_id: ref.ref_id, title: ref.title })),
        connector: chapterRefs
          .filter((ref) => ref.is_connector)
          .map((ref) => ({ ref_id: ref.ref_id, title: ref.title })),
        ignore: this.lastIgnoreChapters.map((chapter) => ({
          title: chapter.title,
          path: chapter.path,
        })),
      },
      null,
      2
    )}\n---\n`;

    if (this.lastMultiError?.isMulti && Array.isArray(this.lastMultiError.codes) && this.lastMultiError.codes.length >= 2) {
      const connectorRefs = chapterRefs.filter((ref) => ref.is_connector);
      combinedContext += `MULTI_ERROR_CONNECTOR_COMMON:\n`;
      combinedContext += `${buildConnectorSectionForRefs('Common connector refs', connectorRefs, this.refPdfUrlMap)}\n\n`;

      for (const code of this.lastMultiError.codes) {
        const codeSpecificConnectorRefs = collectConnectorRefsForErrorCode(chapterRefs, code);
        combinedContext += `MULTI_ERROR_CONNECTOR_${code}:\n`;
        if (codeSpecificConnectorRefs.length > 0) {
          combinedContext += `${buildConnectorSectionForRefs(`Connector refs for ${code}`, codeSpecificConnectorRefs, this.refPdfUrlMap)}\n\n`;
        } else {
          combinedContext += `- No connector chapter explicitly matched ${code}. Reuse the common connector refs above if needed.\n\n`;
        }
      }
      combinedContext += `---\n`;
    }

    for (const ref of chapterRefs) {
      const result = ref.result;
      const typeLabel = ref.is_main ? 'MAIN' : ref.is_connector ? 'CONNECTOR' : 'SUB';
      
      const citationUrl = this.refPdfUrlMap.get(ref.ref_id) ?? '';

      combinedContext += `--- Document Ref: [${ref.ref_id}] (${typeLabel}) ---\n`;
      combinedContext += `pdf_title: ${ref.title}\n`;
      if (citationUrl) {
        // PDF-only citation URL. IMPORTANT: must NOT be used for images.
        combinedContext += `PDF_CITATION_URL: ${citationUrl}\n`;
        combinedContext += `PDF_CITATION_MARKDOWN: [${ref.title.replace(/\[/g, '(').replace(/\]/g, ')')}](<${citationUrl}>)\n`;
      }
      combinedContext += `chunk_info: pages ${result.start_page}-${result.end_page}\n`;
      combinedContext += `context (chapter body text; connector table Connector No. must come from MAIN context, not from image_explanation): ${result.content}\n`;

      if (result.image_content) {
        const explanations = flattenImageExplanations(result.image_content);
        const selectedExplanations = filterImageExplanationsByConnectorNos(explanations, extractedConnectorNos);
        combinedContext += `image_explanation (insert these with [[IMG:<file name>]]; never write a URL):\n`;
        for (const exp of selectedExplanations as ImageExplanation[]) {
          const imageName = exp.cropped_image_path
            ? await this.registerImageUrl(exp.cropped_image_path)
            : '';
          combinedContext += `  - Caption: ${exp.caption}\n`;
          if (imageName) {
            combinedContext += `    Image: ${imageName}\n`;
          }
          combinedContext += `    OCR: ${exp.ocr_text}\n`;
          combinedContext += `    Page: ${exp.page_number}\n`;
          combinedContext += `    Step: ${exp.procedure_step_number}\n`;
        }
      }

      // Every image available for this chapter, referenced by file name only.
      const chapterImageNames = new Set<string>();
      const imageSamePagePaths = (result.same_page_paths || []).filter((p) =>
        /\.(jpg|jpeg|png|gif|webp)$/i.test(p)
      );
      for (const path of imageSamePagePaths) {
        chapterImageNames.add(await this.registerImageUrl(path));
      }
      for (const blobPath of await this.findAllImageBlobsForResult(result)) {
        chapterImageNames.add(await this.registerImageUrl(blobPath));
      }
      if (chapterImageNames.size > 0) {
        combinedContext += `available_images (file names you may insert with [[IMG:<file name>]]):\n`;
        for (const imageName of chapterImageNames) {
          combinedContext += `  - ${imageName}\n`;
        }
      }

      combinedContext += `--- End of Document Ref: [${ref.ref_id}] ---\n\n`;
    }

    return combinedContext;
  }

  getRefLinkMap(): Map<string, string> {
    return this.refLinkMap;
  }

  async streamAnswer(
    query: string,
    classifiedResults: ClassifiedResults,
    chatHistory: any[],
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const effectiveResults = this.lastClassifiedResults ?? classifiedResults;
    const combinedContext = await this.buildContext(effectiveResults);
    return await streamFinalAnswer(
      query,
      combinedContext,
      chatHistory,
      this.lastAnswerPatterns,
      { isMulti: this.lastMultiError.isMulti, codes: this.lastMultiError.codes },
      this.manualMode,
      onChunk,
      this.imageUrls,
      this.imageSasUrlMap
    );
  }
}
