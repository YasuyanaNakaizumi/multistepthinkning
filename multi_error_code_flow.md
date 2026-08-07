# Multi-Error-Code Flow (Implementation Details)

This document describes how the application detects multiple error codes and runs a dedicated answer-generation flow with a separately managed system prompt.

## Goal

- When the user query involves **two or more distinct error codes**, run a dedicated flow:
  - Detect multi-code using a GPT step.
  - Use a **separate system prompt definition** for answer generation (multi-code vs single-code).

## Where multi-error-code detection is done (GPT step)

Implemented in:
- `backend/src/services/multiStepReasoning.ts`
- Function: `MultiStepReasoningService.run(...)`

A new GPT step was added:
- **Step title**: `Detecting Multiple Error Codes`
- **When**: immediately after `Extracting Elements` and before `Additional Search`
- **What calls GPT**: `detectMultiErrorCodes(...)` in `backend/src/services/openai.ts`

### Step order (current)

1. Generating Search Queries (GPT)
2. Selecting Relevant Chapters (GPT)
3. Searching by TOC Filter (Azure AI Search)
4. Judging Answerability (GPT)
5. Extracting Elements (GPT)
6. Detecting Multiple Error Codes (GPT)  ← **NEW**
7. Additional Search (optional; uses GPT for TOC selection)
8. Chapter Classification (GPT)
9. Preparing Context (builds the final context string)

## What is passed into the multi-error detection GPT

Function:
- `detectMultiErrorCodes(userQuery, extractedErrorCodes, chatHistory)`

Inputs:
- **User Query**: the current user input
- **Extracted Error Codes**: from Step 5 `extractElements` (`elements.error_codes`)
- **Recent Chat History**: last ~6 messages (role/content), to avoid missing codes mentioned previously

Output JSON:
```json
{
  "is_multi_error_codes": true,
  "error_codes": ["CA441", "CA442"],
  "reason": "..."
}
```

The result is stored in `MultiStepReasoningService.lastMultiError`:
- `isMulti`: boolean
- `codes`: string[]
- `reason`: optional string

## How the detection result affects downstream processing

### 1) Context flags

When building `combinedContext` (in `buildContext(...)`):
- If `lastMultiError.isMulti === true` and `lastMultiError.codes.length >= 2`
  - `IS_MULTI_ERROR_CODES: true`
  - `MULTI_ERROR_CODES: <comma-separated codes>`
- Otherwise:
  - `IS_MULTI_ERROR_CODES: false`

This is included near the top of the context along with `EXTRACTED_ELEMENTS_JSON`.

### 2) Selecting the final-answer system prompt

Answer generation uses `streamFinalAnswer(...)`.

We changed the answer generator to select between **two separately managed system prompts**:
- **Single-code / normal** prompt: `buildFinalAnswerSystemPromptSingle(combinedContext)`
- **Multi-code** prompt: `buildFinalAnswerSystemPromptMulti(combinedContext)`

Implementation:
- `backend/src/services/openai.ts`
  - `buildFinalAnswerSystemPromptBase(combinedContext)`
  - `buildFinalAnswerSystemPromptSingle(combinedContext)`
  - `buildFinalAnswerSystemPromptMulti(combinedContext)`

`streamFinalAnswer(...)` now accepts a new argument:
- `multiError: { isMulti: boolean; codes?: string[] }`

The caller passes:
- `{ isMulti: this.lastMultiError.isMulti, codes: this.lastMultiError.codes }`

## Prompts used in this flow

### detectMultiErrorCodes (system prompt)

Defined in `backend/src/services/openai.ts`:

```text
You are an assistant that detects whether the user is asking about multiple error codes.

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
}
```

### streamFinalAnswer system prompts

- The **base** system prompt is defined in `buildFinalAnswerSystemPromptBase(combinedContext)`.
- The **multi-code flow** appends a dedicated multi-code section structure in `buildFinalAnswerSystemPromptMulti(combinedContext)`.

For exact prompt strings, see:
- `prompts_dump.md`

## Notes / Design rationale

- Previously, multi-code handling was inferred inside the single large answer prompt via context flags.
- Now, the app makes the decision explicitly via a dedicated GPT step and routes to a separately managed system prompt.
- This makes prompt maintenance easier and makes the flow behavior clearer.
