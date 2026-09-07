export interface ThinkingStep {
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  timestamp?: string;
  error?: string;
  /** Present when this step calls GPT (e.g. none / low / medium / high). */
  reasoningEffort?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinkingSteps?: ThinkingStep[];
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
