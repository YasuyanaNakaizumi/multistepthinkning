import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { config } from '../config';
import { SelectedDocument, ThinkingStep } from '../types';

export interface ChatLogTurn {
  type: 'new_chat' | 'document_change' | 'message';
  timestamp: string;
  query: string;
  answer: string;
  thinkingSteps: ThinkingStep[];
  followupQuestions: string[];
  imageUrls: string[];
  pdfUrls: { title: string; url: string }[];
  selectedDocuments: SelectedDocument[];
  chatHistoryLength: number;
}

export interface ChatSessionLog {
  userEmail: string;
  sessionId: string;
  sessionDate: string;
  createdAt: string;
  updatedAt: string;
  currentSelectedDocuments: SelectedDocument[];
  turns: ChatLogTurn[];
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

function formatDateParts(date: Date): { dayFolder: string; timestamp: string } {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  const dayFolder = `${year}-${month}-${day}`;
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  return { dayFolder, timestamp };
}

function buildChatLogBlobPath(email: string, sessionId: string, date: Date): { blobPath: string; sessionDate: string; timestamp: string } {
  const normalizedEmail = sanitizePathSegment(normalizeEmail(email));
  const normalizedSessionId = sanitizePathSegment(sessionId || 'unknown-session');
  const { dayFolder, timestamp } = formatDateParts(date);
  return {
    blobPath: `chat-logs/${normalizedEmail}/${dayFolder}/${normalizedSessionId}.json`,
    sessionDate: dayFolder,
    timestamp,
  };
}

async function readExistingLog(blobClient: BlockBlobClient): Promise<ChatSessionLog | null> {
  try {
    if (!(await blobClient.exists())) {
      return null;
    }

    const download = await blobClient.downloadToBuffer();
    const text = download.toString('utf8').trim();
    if (!text) {
      return null;
    }

    return JSON.parse(text) as ChatSessionLog;
  } catch (error) {
    console.warn('Failed to read existing chat log blob:', (error as Error).message);
    return null;
  }
}

async function uploadLog(blobClient: BlockBlobClient, log: ChatSessionLog): Promise<void> {
  const payload = JSON.stringify(log, null, 2);
  await blobClient.upload(payload, Buffer.byteLength(payload, 'utf8'), {
    blobHTTPHeaders: {
      blobContentType: 'application/json; charset=utf-8',
    },
  });
}

export async function appendChatLogEntry(params: {
  userEmail: string;
  sessionId: string;
  query: string;
  answer: string;
  thinkingSteps: ThinkingStep[];
  followupQuestions: string[];
  imageUrls: string[];
  pdfUrls: { title: string; url: string }[];
  selectedDocuments: SelectedDocument[];
  chatHistoryLength: number;
  eventType?: ChatLogTurn['type'];
}): Promise<{ blobPath: string } | null> {
  if (!isChatBlobConfigured()) {
    return null;
  }

  const userEmail = normalizeEmail(params.userEmail);
  if (!userEmail) {
    return null;
  }

  const now = new Date();
  const eventType = params.eventType || (params.chatHistoryLength === 0 ? 'new_chat' : 'message');
  const { blobPath, sessionDate, timestamp } = buildChatLogBlobPath(userEmail, params.sessionId, now);

  const serviceClient = getBlobServiceClient();
  const containerClient = serviceClient.getContainerClient(config.chatBlob.containerName);
  await containerClient.createIfNotExists().catch(() => undefined);
  const blobClient = containerClient.getBlockBlobClient(blobPath);

  const existing = (await readExistingLog(blobClient)) || {
    userEmail,
    sessionId: params.sessionId,
    sessionDate,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentSelectedDocuments: params.selectedDocuments,
    turns: [],
  };

  const nextTurn: ChatLogTurn = {
    type: eventType,
    timestamp,
    query: params.query,
    answer: params.answer,
    thinkingSteps: params.thinkingSteps,
    followupQuestions: params.followupQuestions,
    imageUrls: params.imageUrls,
    pdfUrls: params.pdfUrls,
    selectedDocuments: params.selectedDocuments,
    chatHistoryLength: params.chatHistoryLength,
  };

  existing.userEmail = userEmail;
  existing.sessionId = params.sessionId;
  existing.sessionDate = sessionDate;
  existing.updatedAt = timestamp;
  existing.currentSelectedDocuments = params.selectedDocuments;
  existing.turns = [...(existing.turns || []), nextTurn];

  await uploadLog(blobClient, existing);
  return { blobPath };
}
