import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { config } from '../config';

/**
 * Persist Azure Conversation IDs as JSON in the chat-log blob container
 * so they can be listed and deleted later (Conversations API DELETE).
 */

export type ConversationIdStatus = 'active' | 'deleted';

/** Persist PDF citation tokens so follow-up turns can still expand [[PDF:shop-N]]. */
export interface PersistedPdfRef {
  refId: string;
  title: string;
  blobPath: string;
}

export interface PersistedImageRef {
  fileName: string;
  blobPath: string;
}

export interface ConversationIdRecord {
  chatSessionId: string;
  conversationId: string;
  userEmail: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationIdStatus;
  lastResponseId?: string;
  lastTotalTokens?: number;
  /** Soft-delete timestamp when marked deleted in Blob (Azure delete may be separate). */
  deletedAt?: string;
  /** Cumulative PDF citation map for this chat session (refId → blob). */
  pdfRefs?: PersistedPdfRef[];
  /** Cumulative image basename → blob path for [[IMG:]] expansion. */
  imageRefs?: PersistedImageRef[];
}

let blobServiceClient: BlobServiceClient | null = null;

function isChatBlobConfigured(): boolean {
  return Boolean(config.chatBlob.connectionString && config.chatBlob.containerName);
}

function getBlobServiceClient(): BlobServiceClient {
  if (!blobServiceClient) {
    blobServiceClient = BlobServiceClient.fromConnectionString(config.chatBlob.connectionString);
  }
  return blobServiceClient;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function buildBlobPath(email: string, sessionId: string): string {
  const normalizedEmail = sanitizePathSegment(normalizeEmail(email) || 'anonymous');
  const normalizedSessionId = sanitizePathSegment(sessionId || 'unknown-session');
  return `conversation-ids/${normalizedEmail}/${normalizedSessionId}.json`;
}

async function readRecord(blobClient: BlockBlobClient): Promise<ConversationIdRecord | null> {
  try {
    if (!(await blobClient.exists())) return null;
    const download = await blobClient.downloadToBuffer();
    const text = download.toString('utf8').trim();
    if (!text) return null;
    return JSON.parse(text) as ConversationIdRecord;
  } catch (error) {
    console.warn('Failed to read conversation-id blob:', (error as Error).message);
    return null;
  }
}

async function uploadRecord(blobClient: BlockBlobClient, record: ConversationIdRecord): Promise<void> {
  const payload = JSON.stringify(record, null, 2);
  await blobClient.upload(payload, Buffer.byteLength(payload, 'utf8'), {
    blobHTTPHeaders: {
      blobContentType: 'application/json; charset=utf-8',
    },
  });
}

export async function upsertConversationIdRecord(params: {
  userEmail?: string;
  chatSessionId: string;
  conversationId: string;
  lastResponseId?: string;
  lastTotalTokens?: number;
  pdfRefs?: PersistedPdfRef[];
  imageRefs?: PersistedImageRef[];
}): Promise<{ blobPath: string } | null> {
  if (!isChatBlobConfigured()) return null;

  const chatSessionId = String(params.chatSessionId || '').trim();
  const conversationId = String(params.conversationId || '').trim();
  if (!chatSessionId || !conversationId) return null;

  const userEmail = String(params.userEmail || '').trim() || 'anonymous';
  const now = new Date().toISOString();
  const blobPath = buildBlobPath(userEmail, chatSessionId);
  const container = getBlobServiceClient().getContainerClient(config.chatBlob.containerName);
  const blobClient = container.getBlockBlobClient(blobPath);

  const existing = await readRecord(blobClient);
  const mergePdfRefs = (prev: PersistedPdfRef[] | undefined, next: PersistedPdfRef[] | undefined) => {
    const map = new Map<string, PersistedPdfRef>();
    for (const r of prev || []) {
      if (r?.refId && r?.blobPath) map.set(r.refId, r);
    }
    for (const r of next || []) {
      if (r?.refId && r?.blobPath) map.set(r.refId, r);
    }
    return [...map.values()];
  };
  const mergeImageRefs = (prev: PersistedImageRef[] | undefined, next: PersistedImageRef[] | undefined) => {
    const map = new Map<string, PersistedImageRef>();
    for (const r of prev || []) {
      if (r?.fileName && r?.blobPath) map.set(r.fileName.toLowerCase(), r);
    }
    for (const r of next || []) {
      if (r?.fileName && r?.blobPath) map.set(r.fileName.toLowerCase(), r);
    }
    return [...map.values()];
  };

  const record: ConversationIdRecord = {
    chatSessionId,
    conversationId,
    userEmail: normalizeEmail(userEmail),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: existing?.status === 'deleted' ? 'deleted' : 'active',
    lastResponseId: params.lastResponseId || existing?.lastResponseId,
    lastTotalTokens:
      typeof params.lastTotalTokens === 'number'
        ? params.lastTotalTokens
        : existing?.lastTotalTokens,
    deletedAt: existing?.deletedAt,
    pdfRefs: mergePdfRefs(existing?.pdfRefs, params.pdfRefs),
    imageRefs: mergeImageRefs(existing?.imageRefs, params.imageRefs),
  };

  await uploadRecord(blobClient, record);
  console.log(
    `[ConversationBlob] upserted ${blobPath} conversationId=${conversationId}` +
      ` pdfRefs=${record.pdfRefs?.length || 0} imageRefs=${record.imageRefs?.length || 0}`
  );
  return { blobPath };
}

/** Mark a stored conversation id as deleted in Blob (call Azure DELETE separately). */
export async function markConversationIdDeleted(params: {
  userEmail?: string;
  chatSessionId: string;
}): Promise<ConversationIdRecord | null> {
  if (!isChatBlobConfigured()) return null;
  const chatSessionId = String(params.chatSessionId || '').trim();
  if (!chatSessionId) return null;

  const userEmail = String(params.userEmail || '').trim() || 'anonymous';
  const blobPath = buildBlobPath(userEmail, chatSessionId);
  const container = getBlobServiceClient().getContainerClient(config.chatBlob.containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  const existing = await readRecord(blobClient);
  if (!existing) return null;

  const now = new Date().toISOString();
  const record: ConversationIdRecord = {
    ...existing,
    status: 'deleted',
    updatedAt: now,
    deletedAt: now,
  };
  await uploadRecord(blobClient, record);
  return record;
}

export async function getConversationIdRecord(params: {
  userEmail?: string;
  chatSessionId: string;
}): Promise<ConversationIdRecord | null> {
  if (!isChatBlobConfigured()) return null;
  const chatSessionId = String(params.chatSessionId || '').trim();
  if (!chatSessionId) return null;
  const userEmail = String(params.userEmail || '').trim() || 'anonymous';
  const blobPath = buildBlobPath(userEmail, chatSessionId);
  const container = getBlobServiceClient().getContainerClient(config.chatBlob.containerName);
  const blobClient = container.getBlockBlobClient(blobPath);
  return readRecord(blobClient);
}
