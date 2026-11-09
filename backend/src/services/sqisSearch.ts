/**
 * SQIS（PostgreSQL）ハイブリッド検索 — TSI / サービスニュース
 */
import pg from 'pg';
import { config } from '../config';
import { getTextEmbedding } from './openai';

const { Client } = pg;

export function isSqisConfigured(): boolean {
  return Boolean(
    config.sqis.connectionString ||
      (config.sqis.host && config.sqis.database && config.sqis.user)
  );
}

function requiredEnvLabel(name: string): never {
  throw new Error(`環境変数 ${name} が未設定です`);
}

function safeFunctionName(name: string | undefined, fallback: string): string {
  const v = name || fallback;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) {
    throw new Error(`不正な PostgreSQL 関数名: ${v}`);
  }
  return v;
}

export function toPgvectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => Number(v).toFixed(10)).join(',')}]`;
}

export function buildPgConnStr(): string {
  if (config.sqis.connectionString) return config.sqis.connectionString;

  const host = config.sqis.host || requiredEnvLabel('PG_HOST');
  const port = config.sqis.port || '5432';
  const dbname = config.sqis.database || requiredEnvLabel('PG_DB_NAME');
  const user = config.sqis.user || requiredEnvLabel('PG_USER');
  const password = config.sqis.password || '';
  const sslmode = config.sqis.sslMode || 'require';

  const userEnc = encodeURIComponent(user);
  const passEnc = encodeURIComponent(password);
  const auth = password !== '' ? `${userEnc}:${passEnc}@` : `${userEnc}@`;
  return `postgresql://${auth}${host}:${port}/${dbname}?sslmode=${sslmode}`;
}

async function withPg<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: buildPgConnStr(),
    ssl:
      (config.sqis.sslMode || 'require') === 'disable'
        ? false
        : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export interface SqisSearchResult {
  totalCount: number;
  data: unknown[];
}

function normalizeRows(rows: Array<[unknown, unknown]>): SqisSearchResult {
  if (!rows?.length) {
    return { totalCount: 0, data: [] };
  }
  if (rows.length === 1) {
    const [totalCount, data] = rows[0];
    return {
      totalCount: Number(totalCount) || 0,
      data: typeof data === 'string' ? JSON.parse(data) : (data as unknown[]) || [],
    };
  }
  return {
    totalCount: rows.reduce((n, [t]) => n + (Number(t) || 0), 0),
    data: rows.flatMap(([, d]) => {
      const parsed = typeof d === 'string' ? JSON.parse(d) : d;
      return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    }),
  };
}

/**
 * TSI ハイブリッド検索
 */
export async function hybridSearchTsi(params: {
  query: string;
  model?: string | null;
  lang?: string;
  page?: number;
  size?: number;
}): Promise<SqisSearchResult> {
  const { query, model = null, lang = config.sqis.lang, page = 0, size = 10 } = params;
  const embeddingStr = toPgvectorLiteral(await getTextEmbedding(query));
  const fn = safeFunctionName(config.sqis.searchFunctionTsi, 'fn_tsi_search_jsonb');

  const filters: Record<string, unknown> = {
    __search_mode: 'hybrid',
    __query_embedding: embeddingStr,
    __language: 'japanese',
  };
  if (model) filters.model = [model];

  // fn_tsi_search_jsonb(p_query text, p_filters_text text, p_lang text, p_page_number int, p_page_size int)
  const sql = `
    SELECT total_count, data
    FROM ${fn}($1::text, $2::text, $3::text, $4::int, $5::int)
  `;

  const rows = await withPg(async (client) => {
    const res = await client.query(sql, [
      query,
      JSON.stringify(filters),
      lang,
      page,
      size,
    ]);
    return res.rows.map((r) => [r.total_count, r.data] as [unknown, unknown]);
  });

  return normalizeRows(rows);
}

/**
 * サービスニュース ハイブリッド検索
 */
export async function hybridSearchServiceNews(params: {
  query: string;
  model?: string | null;
  userType?: string;
  page?: number;
  size?: number;
}): Promise<SqisSearchResult> {
  const {
    query,
    model = null,
    userType = config.sqis.userType,
    page = 0,
    size = 10,
  } = params;
  const embeddingStr = toPgvectorLiteral(await getTextEmbedding(query));
  const fn = safeFunctionName(
    config.sqis.searchFunctionServiceNews,
    'fn_service_news_search_jsonb'
  );

  const filters: Record<string, unknown> = {
    __search_mode: 'hybrid',
    __query_embedding: embeddingStr,
    __language: 'japanese',
  };
  if (model) filters.model = [model];

  const userFilter = { user_type: userType };

  // fn_service_news_search_jsonb(p_query text, p_filters_text text, p_user_filter_text text, p_page_number int, p_page_size int)
  const sql = `
    SELECT total_count, data
    FROM ${fn}($1::text, $2::text, $3::text, $4::int, $5::int)
  `;

  const rows = await withPg(async (client) => {
    const res = await client.query(sql, [
      query,
      JSON.stringify(filters),
      JSON.stringify(userFilter),
      page,
      size,
    ]);
    return res.rows.map((r) => [r.total_count, r.data] as [unknown, unknown]);
  });

  return normalizeRows(rows);
}

function asRecord(hit: unknown): Record<string, unknown> {
  return hit && typeof hit === 'object' ? (hit as Record<string, unknown>) : {};
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function clip(text: string, max = 600): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Compact TSI hits for the agent (avoid dumping huge JSON). */
export function summarizeTsiHits(data: unknown[], size: number): Array<Record<string, unknown>> {
  return (Array.isArray(data) ? data : []).slice(0, size).map((hit, index) => {
    const row = asRecord(hit);
    const nested = asRecord(row.document || row.doc || row.payload || row);
    return {
      rank: index + 1,
      id: pickString(row, ['id', 'tsi_id', 'document_id', 'doc_id']) ||
        pickString(nested, ['id', 'tsi_id', 'document_id']),
      number: pickString(row, ['tsi_number', 'document_number', 'doc_number', 'number']) ||
        pickString(nested, ['tsi_number', 'document_number', 'number']),
      title: pickString(row, ['title', 'subject', 'tsi_title', 'document_title']) ||
        pickString(nested, ['title', 'subject', 'tsi_title']),
      model: pickString(row, ['model', 'models', 'machine_model']) ||
        pickString(nested, ['model', 'models']),
      score: row.score ?? row.hybrid_score ?? nested.score,
      snippet: clip(
        pickString(row, ['snippet', 'summary', 'content', 'body', 'text', 'description']) ||
          pickString(nested, ['snippet', 'summary', 'content', 'body', 'text', 'description'])
      ),
      url: pickString(row, ['url', 'document_url', 'link']) ||
        pickString(nested, ['url', 'document_url', 'link']),
    };
  });
}

/** Compact Service News hits for the agent. */
export function summarizeServiceNewsHits(
  data: unknown[],
  size: number
): Array<Record<string, unknown>> {
  return (Array.isArray(data) ? data : []).slice(0, size).map((hit, index) => {
    const row = asRecord(hit);
    const nested = asRecord(row.document || row.doc || row.payload || row);
    return {
      rank: index + 1,
      id: pickString(row, ['id', 'news_id', 'document_id', 'doc_id']) ||
        pickString(nested, ['id', 'news_id', 'document_id']),
      number: pickString(row, ['news_number', 'document_number', 'doc_number', 'number']) ||
        pickString(nested, ['news_number', 'document_number', 'number']),
      title: pickString(row, ['title', 'subject', 'news_title', 'document_title']) ||
        pickString(nested, ['title', 'subject', 'news_title']),
      model: pickString(row, ['model', 'models', 'machine_model']) ||
        pickString(nested, ['model', 'models']),
      published: pickString(row, ['published_at', 'publish_date', 'date', 'issued_at']) ||
        pickString(nested, ['published_at', 'publish_date', 'date']),
      score: row.score ?? row.hybrid_score ?? nested.score,
      snippet: clip(
        pickString(row, ['snippet', 'summary', 'content', 'body', 'text', 'description']) ||
          pickString(nested, ['snippet', 'summary', 'content', 'body', 'text', 'description'])
      ),
      url: pickString(row, ['url', 'document_url', 'link']) ||
        pickString(nested, ['url', 'document_url', 'link']),
    };
  });
}
