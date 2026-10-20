import { config } from '../config';

/**
 * Azure OpenAI Conversations API helpers.
 * base example: https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1
 *
 * Responses that use `conversation` MUST hit the SAME base:
 *   POST {base}/responses
 * On /openai/v1 paths, api-version query param is NOT allowed.
 */

function requireNonEmpty(value: string, name: string): string {
  if (!value) throw new Error(`${name} is missing or empty`);
  return value;
}

function apiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'api-key': requireNonEmpty(config.azureOpenAI.apiKey, 'AZURE_OPENAI_API_KEY'),
  };
}

/** Host origin from AZURE_OPENAI_ENDPOINT. */
function getResponsesOrigin(): string {
  const raw = requireNonEmpty(config.azureOpenAI.endpoint, 'AZURE_OPENAI_ENDPOINT');
  return new URL(raw).origin;
}

/**
 * Normalize Conversations base to .../openai/v1 (no trailing slash, no /conversations).
 * Accepts either:
 *   .../api/projects/{project}
 *   .../api/projects/{project}/openai/v1
 */
export function normalizeConversationsBase(raw: string): string {
  let base = String(raw || '').trim().replace(/\/$/, '');
  if (!base) return '';
  base = base.replace(/\/conversations\/?$/i, '');
  if (/\/api\/projects\/[^/]+$/i.test(base) && !/\/openai\/v1$/i.test(base)) {
    base = `${base}/openai/v1`;
  }
  return base.replace(/\/$/, '');
}

function conversationCreateCandidates(): string[] {
  const override = normalizeConversationsBase(process.env.AZURE_OPENAI_CONVERSATIONS_ENDPOINT || '');
  const origin = getResponsesOrigin();
  const host = new URL(origin).hostname;
  const resource = host.split('.')[0];

  const bases: string[] = [];
  if (override) bases.push(override);
  bases.push(`${origin}/openai/v1`);
  if (host.includes('cognitiveservices.azure.com')) {
    bases.push(`https://${resource}.openai.azure.com/openai/v1`);
    bases.push(`https://${resource}.services.ai.azure.com/openai/v1`);
  } else if (host.includes('openai.azure.com')) {
    bases.push(`https://${resource}.cognitiveservices.azure.com/openai/v1`);
    bases.push(`https://${resource}.services.ai.azure.com/openai/v1`);
  }

  // /openai/v1 forbids api-version query — prefer bare path first.
  const versions = ['', 'preview', 'v1'];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const normalized = normalizeConversationsBase(base);
    if (!normalized) continue;
    for (const ver of versions) {
      const url = ver
        ? `${normalized}/conversations?api-version=${encodeURIComponent(ver)}`
        : `${normalized}/conversations`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function conversationIdUrl(conversationId: string, createUrlTemplate: string): string {
  const u = new URL(createUrlTemplate);
  u.pathname = u.pathname.replace(
    /\/?conversations\/?$/,
    `/conversations/${encodeURIComponent(conversationId)}`
  );
  return u.toString();
}

export interface AzureConversation {
  id: string;
  object?: string;
  created_at?: number;
  metadata?: Record<string, string>;
  endpointUsed?: string;
}

let lastWorkingCreateUrl: string | null = null;

/**
 * Responses URL on the SAME surface as Conversations.
 * Example: .../api/projects/{project}/openai/v1/responses
 * (No api-version — Azure rejects it on /v1 paths.)
 */
export function getConversationResponsesEndpoint(): string | null {
  let base = '';

  if (lastWorkingCreateUrl) {
    const u = new URL(lastWorkingCreateUrl);
    base = normalizeConversationsBase(`${u.origin}${u.pathname.replace(/\/conversations\/?$/i, '')}`);
  } else {
    base = normalizeConversationsBase(process.env.AZURE_OPENAI_CONVERSATIONS_ENDPOINT || '');
  }

  if (!base) return null;
  return `${base}/responses`;
}

export function getLastConversationCreateUrl(): string | null {
  return lastWorkingCreateUrl;
}

export async function createAzureConversation(params?: {
  metadata?: Record<string, string>;
  items?: unknown[];
}): Promise<AzureConversation> {
  const body: Record<string, unknown> = {};
  if (params?.metadata && Object.keys(params.metadata).length) {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(params.metadata)) {
      if (!k || v == null) continue;
      meta[String(k).slice(0, 64)] = String(v).slice(0, 512);
    }
    if (Object.keys(meta).length) body.metadata = meta;
  }
  if (params?.items?.length) body.items = params.items;

  const preferred = lastWorkingCreateUrl ? [lastWorkingCreateUrl] : [];
  const candidates = [
    ...preferred,
    ...conversationCreateCandidates().filter((u) => u !== lastWorkingCreateUrl),
  ];
  const errors: string[] = [];

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
      const txt = await resp.text().catch(() => '');
      if (!resp.ok) {
        errors.push(`${resp.status} ${url} | ${txt.slice(0, 160)}`);
        continue;
      }
      const data: any = JSON.parse(txt);
      const id = typeof data?.id === 'string' ? data.id.trim() : '';
      if (!id) {
        errors.push(`empty-id ${url}`);
        continue;
      }
      lastWorkingCreateUrl = url;
      const responsesUrl = getConversationResponsesEndpoint();
      console.log(`[Conversation] created id=${id} via ${url}`);
      console.log(`[Conversation] paired Responses URL: ${responsesUrl}`);
      return {
        id,
        object: data.object,
        created_at: data.created_at,
        metadata: data.metadata,
        endpointUsed: url,
      };
    } catch (error) {
      errors.push(`network ${url} | ${(error as Error).message}`);
    }
  }

  throw new Error(
    `Azure Conversations create failed on all endpoints. ` +
      `Set AZURE_OPENAI_CONVERSATIONS_ENDPOINT=` +
      `https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1 ` +
      `(must end with /openai/v1). Attempts:\n- ${errors.join('\n- ')}`
  );
}

export async function deleteAzureConversation(conversationId: string): Promise<void> {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const createUrl = lastWorkingCreateUrl || conversationCreateCandidates()[0];
  if (!createUrl) return;
  const url = conversationIdUrl(id, createUrl);
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: apiHeaders(),
  });
  if (!resp.ok && resp.status !== 404) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Azure Conversations delete error: ${resp.status} ${resp.statusText} ${txt}`);
  }
  console.log(`[Conversation] deleted id=${id}`);
}

export function isConversationMissingError(error: unknown): boolean {
  const msg = String((error as Error)?.message || error || '').toLowerCase();
  return (
    msg.includes('conversation') &&
    (msg.includes('not found') ||
      msg.includes('does not exist') ||
      msg.includes('invalid') ||
      msg.includes('404') ||
      msg.includes('unknown_parameter') ||
      msg.includes('create failed'))
  );
}

export function isConversationSurfaceNotFoundError(error: unknown): boolean {
  const msg = String((error as Error)?.message || error || '').toLowerCase();
  return (
    (msg.includes('404') || msg.includes('notfound') || msg.includes('not found')) &&
    (msg.includes('resource not found') ||
      msg.includes('"code":"notfound"') ||
      msg.includes('conversation'))
  );
}

