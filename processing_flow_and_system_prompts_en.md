# Processing Flow and System Prompts (English)

This document summarizes:

- The backend multi-step processing flow executed per user query.
- The system prompts used at each GPT step (as implemented in `backend/src/services/openai.ts`).

The implementation described here corresponds to the TypeScript backend:

- `backend/src/services/multiStepReasoning.ts`
- `backend/src/services/openai.ts`

---

## 0) High-level Architecture

- **Frontend** (Vite/React)
  - Sends requests to backend endpoints.
  - Displays streaming responses via SSE.

- **Backend** (Node/Express)
  - Orchestrates a multi-step reasoning pipeline.
  - Calls Azure AI Search to retrieve document chunks.
  - Calls an LLM (Azure Foundry Inference endpoint or Azure OpenAI Responses API) for structured intermediate steps and final answer generation.
  - Generates SAS URLs for PDFs/images stored in Azure Blob Storage.

---

## 1) Request Entry Points

- `POST /api/chat`
  - Returns a non-streaming “initial response” object containing:
    - `thinkingSteps`
    - `imageUrls`
    - `pdfUrls`
    - `followupQuestions`

- `POST /api/chat/stream`
  - Server-Sent Events (SSE) streaming for the final answer.
  - Uses the same pipeline, then streams the final answer tokens.

Orchestration class:

- `MultiStepReasoningService` in `backend/src/services/multiStepReasoning.ts`

---

## 2) Multi-Step Pipeline (Backend)

The pipeline is executed by:

- `MultiStepReasoningService.run(query, selectedPdfs, chatHistory)`

### Flow Diagram (HTML)

<table>
  <tbody>
    <tr><td><strong>User request</strong><br/>POST <code>/api/chat</code> or <code>/api/chat/stream</code></td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>MultiStepReasoningService.run</strong></td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 1</strong>: <code>generateSearchQueries</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 2</strong>: <code>selectTOCChaptersInitial</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 3</strong>: <code>searchByTOCFilter</code> (Azure AI Search)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 4</strong>: <code>judgeAnswerability</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td>
      <strong>Branch</strong>:
      <ul>
        <li><strong>If answerable = true</strong> &rarr; proceed to Step 5a</li>
        <li><strong>If answerable = false</strong> &rarr; Step 4b: <code>hybridSearch</code> (Azure AI Search hybrid), then proceed to Step 5a</li>
      </ul>
    </td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 5a</strong>: <code>extractElements</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 5a2</strong>: <code>detectMultiErrorCodes</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td>
      <strong>Branch</strong>: <code>needs_followup?</code>
      <ul>
        <li><strong>Yes</strong> &rarr; Step 5b: <code>selectTOCChapters</code> (GPT, JSON) &rarr; Additional <code>searchByTOCFilter</code> (Azure AI Search) &rarr; Step 5c</li>
        <li><strong>No</strong> &rarr; proceed directly to Step 5c</li>
      </ul>
    </td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 5c</strong>: <code>classifyChapters</code> (GPT, JSON)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 6</strong>: <code>buildContext</code> (backend deterministic)<br/>SAS URLs + Document Ref blocks</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Step 7</strong>: <code>streamFinalAnswer</code> (GPT streaming)</td></tr>
    <tr><td style="text-align:center">&darr;</td></tr>
    <tr><td><strong>Frontend</strong> renders markdown (citations + images)</td></tr>
  </tbody>
</table>

### Step 1: Generate Search Queries (GPT, JSON)

- **Function**: `generateSearchQueries(userQuery, chatHistory)`
- **Purpose**:
  - Extract effective Azure AI Search queries.
  - Extract identifiers (error codes, part numbers, etc.).
- **System prompt (source)**: `backend/src/services/openai.ts`
  - Starts with: `You are a search query extraction assistant.`
- **User prompt**:
  - Includes the current `userQuery` and (when available) a condensed `chatHistory` so the model can generate search queries consistent with the ongoing conversation.
- **Output (JSON)**:
  - `{ "queries": ["..."], "has_codes": true/false }`

### Step 2: Select Relevant Chapters — Initial (GPT, JSON)

- **Function**: `selectTOCChaptersInitial(queries, userQuery, tocContent)`
- **Purpose**:
  - Select a small set of relevant chapter titles from the TOC.
- **System prompt**:
  - `You are a technical manual chapter selection assistant. Select the most relevant chapter titles from the TOC for the user question.`
- **User prompt**:
  - Includes:
    - the `userQuery`
    - the generated `queries`
    - the TOC markdown content (`tocContent`) so the model can select **exact** chapter titles.
- **Output (JSON)**:
  - `{ "chapters": ["<exact chapter title>", ...] }`

### Step 3: Search by TOC Filter (Azure AI Search)

- **Function**: `searchByTOCFilter(tocChapters, selectedPdfs)`
- **Purpose**:
  - Fetch chunks whose `TOC` field matches selected chapter titles.
- **GPT**: Not used.

### Step 4: Judge Answerability (GPT, JSON)

- **Function**: `judgeAnswerability(userQuery, queries, searchResults)`
- **Purpose**:
  - Determine whether the initial retrieved context is sufficient.
- **System prompt**:
  - `You are a document relevance judge. Determine if the provided document excerpts contain enough information to answer the user question. Output JSON format: {"answerable": true/false, "reason": "explanation"}`
- **User prompt**:
  - Includes:
    - the `userQuery`
    - the generated `queries`
    - a compact representation of the retrieved chunks (titles/TOC + excerpts) so the model can judge coverage.
- **Output (JSON)**:
  - `{ "answerable": true/false, "reason": "..." }`

### Step 4b: Hybrid Search Fallback (Azure AI Search + Embeddings)

- **When**: Step 4 judged `answerable=false`.
- **Function**: `hybridSearch(query, selectedPdfs, topK)`
- **Purpose**:
  - Perform hybrid text + vector search to broaden retrieval.
- **GPT**: Not used.

### Step 5a: Extract Elements (GPT, JSON)

- **Function**: `extractElements(userQuery, textContext, chatHistory)`
- **Purpose**:
  - Extract items that drive follow-up search:
    - `error_codes`
    - `connectors`
    - `reference_chapters` (explicit “see/refer to”)
    - `diagnostic_chapters`
    - `components`
  - Decide whether additional search is needed: `needs_followup`.
- **System prompt**:
  - Starts with: `You are an expert in analyzing technical documents (Japanese + English). Your goal is to decide whether additional search is needed AND extract elements that should drive that search.`
  - Includes extra rules to prioritize connector location/layout/3D diagram discovery.
- **User prompt**:
  - Includes:
    - the `userQuery`
    - a text-only `textContext` assembled from the current retrieval results
    - (when available) `chatHistory`
- **Output (JSON)**:
  - `{ error_codes: [], connectors: [], reference_chapters: [], diagnostic_chapters: [], components: [], reasoning: "...", needs_followup: true/false }`

### Step 5a2: Detect Multiple Error Codes (GPT, JSON)

- **Function**: `detectMultiErrorCodes(userQuery, extractedErrorCodes, chatHistory)`
- **Purpose**:
  - Decide if the user is asking about two or more distinct error codes.
- **System prompt**:
  - Starts with: `You are an assistant that detects whether the user is asking about multiple error codes.`
- **User prompt**:
  - Includes:
    - the `userQuery`
    - the `extractedErrorCodes` from the previous extraction step
    - (when available) `chatHistory`
- **Output (JSON)**:
  - `{ "is_multi_error_codes": true/false, "error_codes": ["..."], "reason": "..." }`

### Step 5b: Additional Search (GPT for TOC selection + Azure AI Search)

- **When**: `elements.needs_followup === true`
- **Flow**:
  - Create `additionalQueries` from extracted elements.
  - Reload TOC markdown and select chapters using GPT.
  - Run `searchByTOCFilter` again.
- **Chapter selection function**: `selectTOCChapters(additionalQueries, userQuery, tocContent)`
- **System prompt**:
  - `You are an expert at finding relevant chapters in technical manuals.`
- **User prompt**:
  - Includes:
    - the original `userQuery`
    - the derived `additionalQueries` (error codes / connector names / referenced chapters, etc.)
    - the TOC markdown content (`tocContent`) so the model can return **exact** chapter titles.
- **Output (JSON)**:
  - `{ "chapters": ["<exact chapter title>", ...] }`

### Step 5c: Chapter Classification (GPT, JSON)

- **Function**: `classifyChapters(userQuery, chapterList)`
- **Purpose**:
  - Classify retrieved chapters into:
    - MAIN
    - CONNECTOR
    - SUB
    - IGNORE
- **System prompt**:
  - `You are an expert in classifying technical documents.`
- **User prompt**:
  - Includes:
    - the `userQuery`
    - a normalized `chapterList` with per-chapter metadata (e.g., title/TOC and optionally image-related signals such as `image_captions` / `image_ocr_texts`)
    - detailed classification rules, including:
      - connector list/layout pairing rules
      - numbered series inclusion rules (1)(2)(3)...
      - cross-chapter reference handling (referenced chapters must be at least SUB)
- **Output (JSON)**:
  - `{ main: [idx...], connector: [idx...], sub: [idx...], ignore: [idx...] }`

### Step 6: Build Context (Backend deterministic)

- **Function**: `MultiStepReasoningService.buildContext(classifiedResults)`
- **Purpose**:
  - Build a single `combinedContext` string made of multiple `Document Ref` blocks.
  - Precompute SAS URLs:
    - Chapter PDF links (TOC PDF)
    - Cropped images / same-page images
- **Key properties**:
  - Each ref is assigned an id: `shop-1`, `shop-2`, ...
  - Each Document Ref block includes:
    - `pdf_title`
    - `PDF_CITATION_URL`
    - `PDF_CITATION_MARKDOWN`
    - chunk info
    - text context
    - image URLs (as `IMAGE_URL` and `image_paths_list`)

### Step 7: Stream Final Answer (GPT, streaming)

- **Function**: `streamFinalAnswer(userQuery, combinedContext, chatHistory, multiError, onChunk)`
- **Purpose**:
  - Generate the final answer in Markdown.
  - Enforce strict citation and image rules.
- **System prompt builder**:
  - `buildFinalAnswerSystemPromptSingle(combinedContext)`
  - `buildFinalAnswerSystemPromptMulti(combinedContext)`
- **User prompt**:
  - Includes:
    - the `userQuery`
    - (when available) `chatHistory`
    - any precomputed structured flags (e.g., multi-error-code mode)
  - The evidence itself is provided in the **system prompt** via `combinedContext` (Document Ref blocks containing `PDF_CITATION_MARKDOWN`, text excerpts, and `IMAGE_URL`).

#### Final answer system prompt — important rules (summary)

The final prompt starts with:

- `You are an assistant supporting a mechanical engineer...`

And enforces:

- **Citations for every claim** using `PDF_CITATION_MARKDOWN`.
- **Citation provenance**: citations must come from the same Document Ref that supports the sentence.
- **Citation placement**: place citations at the end of the sentence they support.
- **Cross-chapter reference linking**: when text says “refer to / see / 〜を参照”, link to the referenced chapter’s `PDF_CITATION_MARKDOWN` if present.
- **Connector section behavior**:
  - Output `## Related Connector Information` when `EXTRACTED_CONNECTORS` exists.
  - Also output it when there is at least one `(CONNECTOR)` Document Ref block, even if extraction missed connectors.
  - Connector section citations must come only from `(CONNECTOR)` refs.
  - Insert connector layout/location images immediately after the connector table.
  - **Do not substitute wiring/circuit diagrams** for 3D layout/location diagrams.

---

## 3) System Prompt Inventory (By Function)

Below is a quick reference list of the system prompts used in `backend/src/services/openai.ts`.

### `generateSearchQueries` (system)

- Starts with: `You are a search query extraction assistant.`

### `selectTOCChaptersInitial` (system)

- `You are a technical manual chapter selection assistant. Select the most relevant chapter titles from the TOC for the user question.`

### `selectTOCChapters` (system)

- `You are an expert at finding relevant chapters in technical manuals.`

### `judgeAnswerability` (system)

- `You are a document relevance judge... Output JSON format: {"answerable": true/false, "reason": "explanation"}`

### `extractElements` (system)

- Starts with: `You are an expert in analyzing technical documents (Japanese + English)...`

### `detectMultiErrorCodes` (system)

- Starts with: `You are an assistant that detects whether the user is asking about multiple error codes.`

### `classifyChapters` (system)

- `You are an expert in classifying technical documents.`

### Final Answer (system)

- Built by: `buildFinalAnswerSystemPromptBase(combinedContext)`
- Used by:
  - `buildFinalAnswerSystemPromptSingle`
  - `buildFinalAnswerSystemPromptMulti`

---

## 3b) User Prompt Inventory (By Function)

Below is a quick reference of what each function typically places into the **user prompt** (message content) when calling the model.

### `generateSearchQueries` (user)

- Includes: `userQuery`, plus a condensed `chatHistory` when present.

### `selectTOCChaptersInitial` (user)

- Includes: `userQuery`, `queries`, and the TOC markdown (`tocContent`).

### `selectTOCChapters` (user)

- Includes: `userQuery`, `additionalQueries`, and the TOC markdown (`tocContent`).

### `judgeAnswerability` (user)

- Includes: `userQuery`, `queries`, and summarized retrieval results (excerpts/metadata).

### `extractElements` (user)

- Includes: `userQuery`, `textContext` (text-only context from retrieved chunks), and `chatHistory` when present.

### `detectMultiErrorCodes` (user)

- Includes: `userQuery`, `extractedErrorCodes`, and `chatHistory` when present.

### `classifyChapters` (user)

- Includes: `userQuery` and a `chapterList` array of candidate chapters with metadata, plus explicit classification rules and required JSON output shape.

### Final Answer (user)

- Includes: `userQuery` and (optionally) `chatHistory`.
- Note: The bulk of the evidence (`combinedContext` with `PDF_CITATION_MARKDOWN` and `IMAGE_URL`) is embedded in the **system prompt** rather than the user prompt.

---

## 4) Notes / Operational Implications

- If the retrieved context does not contain connector 3D layout/location diagrams, the final answer prompt is instructed to **avoid substituting wiring/circuit diagrams** and instead explicitly state that the 3D layout diagram is not available in the provided materials.
- Incorrect citation/link placement is mitigated by enforcing:
  - per-sentence provenance,
  - per-sentence placement,
  - multi-ref citations when mixing evidence.

---

## 5) Related Reference Documents (existing)

- `processing_flow.md` (Japanese, detailed)
- `prompts_usage.md` (Japanese, prompt usage mapping)
- `prompts_dump.md` (English, exact prompt strings snapshot; may require updates after code changes)
- `link_generation.md` (Japanese, link/SAS/image insertion design)
