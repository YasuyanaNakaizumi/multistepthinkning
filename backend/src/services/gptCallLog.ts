import fs from 'fs';
import path from 'path';
import { clipDeepForLog } from './openai';

export type GptCallLogEntry = {
  step: number;
  label: string;
  at: string;
  /** Request body sent to Azure (tools may be abbreviated; long strings truncated). */
  request: unknown;
  /** Raw Responses API body (stream: response.completed.response). Long strings truncated. */
  response: unknown;
};

export type GptCallLogDocument = {
  version: 1;
  query: string;
  mode: string;
  chatSessionId?: string;
  conversationId?: string;
  startedAt: string;
  finishedAt?: string;
  filePath?: string;
  calls: GptCallLogEntry[];
};

function slugifyQuery(query: string): string {
  const s = String(query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .replace(/[^\w\u3040-\u30ff\u3400-\u9fff\- ]+/g, '')
    .replace(/\s+/g, '-');
  return s || 'query';
}

function resolveLogDir(): string {
  const cwd = process.cwd();
  const base = path.basename(cwd).toLowerCase() === 'backend' ? path.resolve(cwd, '..') : cwd;
  return path.join(base, 'logs', 'gpt-calls');
}

/** Abbreviate tools array: step1 keeps short desc; step≥2 keeps names only. */
function compactRequestTools(request: unknown, step: number): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const body = { ...(request as Record<string, unknown>) };
  if (!Array.isArray(body.tools)) return body;
  const tools = body.tools as Array<Record<string, any>>;
  const aggressive = step >= 2;
  body.tools = {
    _compacted: aggressive
      ? 'tools abbreviated (step≥2: names only)'
      : 'tools abbreviated (step1: name + short desc)',
    count: tools.length,
    tools: tools.map((tool) => {
      const fn = tool?.function || tool;
      const name = String(fn?.name || tool?.name || tool?.type || '(unnamed)');
      if (aggressive) return { name };
      const desc = String(fn?.description || tool?.description || '');
      return {
        type: tool?.type || 'function',
        name,
        description: desc.length > 80 ? `${desc.slice(0, 80)}…` : desc,
        parameters: fn?.parameters ? '{…}' : undefined,
      };
    }),
  };
  return body;
}

/** Create a per-question GPT I/O recorder (writes JSON when flush is called). */
export function createGptCallRecorder(meta: {
  query: string;
  mode: string;
  chatSessionId?: string;
  conversationId?: string;
}): {
  record: (label: string, request: unknown, response?: unknown) => void;
  setConversationId: (id: string | undefined) => void;
  flush: () => Promise<string | null>;
  snapshot: () => GptCallLogDocument;
} {
  const startedAt = new Date().toISOString();
  const doc: GptCallLogDocument = {
    version: 1,
    query: meta.query,
    mode: meta.mode,
    chatSessionId: meta.chatSessionId,
    conversationId: meta.conversationId,
    startedAt,
    calls: [],
  };

  const stamp = startedAt.replace(/[:.]/g, '-');
  const sessionPart = (meta.chatSessionId || 'nosession').slice(0, 12);
  const fileName = `${stamp}_${sessionPart}_${slugifyQuery(meta.query)}.json`;
  const dir = resolveLogDir();
  const filePath = path.join(dir, fileName);

  return {
    record(label: string, request: unknown, response?: unknown) {
      const step = doc.calls.length + 1;
      // Vendor handoff: keep field shape of the real request/response; only clip long strings.
      const stringClip = 2000;
      const clippedReq = clipDeepForLog(compactRequestTools(request, step), stringClip);
      doc.calls.push({
        step,
        label,
        at: new Date().toISOString(),
        request: clippedReq,
        response: response === undefined ? null : clipDeepForLog(response, stringClip),
      });
    },
    setConversationId(id: string | undefined) {
      if (id) doc.conversationId = id;
    },
    async flush() {
      try {
        doc.finishedAt = new Date().toISOString();
        doc.filePath = filePath;
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, JSON.stringify(doc, null, 2), 'utf8');
        console.log(`[GptCallLog] wrote ${filePath} (${doc.calls.length} calls)`);
        return filePath;
      } catch (error) {
        console.warn('[GptCallLog] write failed:', (error as Error).message);
        return null;
      }
    },
    snapshot() {
      return { ...doc, calls: doc.calls.slice() };
    },
  };
}

export type GptCallRecorder = ReturnType<typeof createGptCallRecorder>;
