export interface ThinkingStep {
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  timestamp?: string;
  error?: string;
  /** Present when this step calls GPT (e.g. none / low / medium / high). */
  reasoningEffort?: string;
  /** UI grouping: tool parent vs nested detail vs agent/answer. */
  kind?: 'agent' | 'tool' | 'detail' | 'answer';
  /** Shared id so detail steps nest under their tool call. */
  groupId?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingSteps?: ThinkingStep[];
  /**
   * Reasoning summary parts kept in Thinking Process (not cleared when answer starts).
   * afterStepIndex: insert after this step index in thinkingSteps (chronological).
   */
  reasoningSummaries?: Array<{ text: string | null; afterStepIndex?: number }>;
  thinkingSources?: { key: string; label: string }[];
  thinkingStepsBySource?: Record<string, ThinkingStep[]>;
  thinkingQuery?: string;
  thinkingDocuments?: Document[];
  activeThinkingSourceKey?: string;
  imageUrls?: string[];
  pdfUrls?: { title: string; url: string }[];
  /** Latency from request start: first visible character / last character. */
  answerTiming?: {
    firstTokenMs: number;
    completeMs?: number;
    /** Backend: ms from answer-model call start to first Azure delta. */
    modelFirstTokenMs?: number;
    /** Frontend: ms between model_first_token SSE and first painted chunk. */
    holdDelayMs?: number;
  };
  /** Reasoning effort used for the final answer GPT call. */
  answerReasoningEffort?: string;
  /** Aggregated Azure Responses API token usage for this turn (all tool rounds + answer). */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  };
}

export interface Document {
  documentNumber: string;
  documentTitle: string;
  documentType: string;
  language: string;
  fileSize?: string;
  fileName?: string;
  documentUrl?: string;
  sourceDocumentType?: string;
  modelSerialAssociation?: { model: string; serial: string; serial_start?: string; serial_end?: string }[];
}
