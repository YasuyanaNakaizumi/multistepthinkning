export interface ThinkingStep {
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  timestamp?: string;
  error?: string;
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
