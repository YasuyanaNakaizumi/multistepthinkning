// Search result types from Azure AI Search
export interface SearchResult {
  id: string;
  TOC: string;
  path: string;
  parent_path?: string;
  content: string;
  fileName: string;
  start_page: number;
  end_page: number;
  image_content?: string;
  same_page_paths?: string[];
  documentNumber: string;
  documentTitle: string;
  documentType: string;
  document_id?: string;
  language: string;
  contentVector?: number[];
  imageSummaryVector?: number[];
  _search_type?: string;
}

export interface DocumentCatalog {
  documentNumber: string;
  documentTitle: string;
}

export interface ModelSerialAssociation {
  model: string;
  serial: string;
  serial_start?: string;
  serial_end?: string;
}

export interface DocumentSearchItem {
  documentNumber: string;
  documentTitle: string;
  documentType: string;
  language: string;
  fileSize?: string;
  fileName?: string;
  sourceDocumentType?: string;
  documentUrl?: string;
  modelSerialAssociation?: ModelSerialAssociation[];
}

export interface DocumentSearchResponse {
  shop_manual?: DocumentSearchItem[];
  operation_and_maintenance_manual?: DocumentSearchItem[];
  parts_book?: DocumentSearchItem[];
  [key: string]: DocumentSearchItem[] | undefined;
}

export interface SelectedDocument {
  documentNumber: string;
  documentTitle: string;
  documentType: string;
  language: string;
  fileSize?: string;
  fileName?: string;
  documentUrl?: string;
  modelSerialAssociation?: ModelSerialAssociation[];
}

/** Inner GPT: search queries + initial TOC path selection. */
export interface InitialQueryAndTocResponse {
  queries: string[];
  has_codes: boolean;
  chapters: string[];
}

/** Inner GPT: follow-up TOC path selection. */
export interface TOCChaptersResponse {
  chapters: string[];
}

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
  imageUrls?: string[];
  pdfUrls?: { title: string; url: string }[];
}

/** POST /api/chat and /api/chat/stream body. */
export interface ChatRequest {
  query: string;
  /** Document numbers (compat with older clients). */
  selectedPdfs?: string[];
  /** Full document metadata from DocumentSearch. */
  selectedDocuments?: SelectedDocument[];
  chatSessionId?: string;
  userEmail?: string;
  /** thinking = up to 2 retrieves; fast = 1 retrieve. */
  mode?: 'thinking' | 'fast';
  chatHistory: ChatMessage[];
  conversationId?: string;
  previousResponseId?: string;
}

export interface ChatResponse {
  answer: string;
  thinkingSteps: ThinkingStep[];
  imageUrls: string[];
  pdfUrls: { title: string; url: string }[];
  followupQuestions?: string[];
}
