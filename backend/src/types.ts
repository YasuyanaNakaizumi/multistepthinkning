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

// GPT response types
export interface SearchQueriesResponse {
  queries: string[];
  has_codes: boolean;
}

export interface TOCChaptersResponse {
  chapters: string[];
}

export interface AnswerabilityResponse {
  answerable: boolean;
  reason: string;
}

export type AnswerPattern = 'single_fault' | 'assembly' | 'multi_fault' | 'maintenance' | 'general';

export interface AnswerPatternResponse {
  patterns: AnswerPattern[];
  reason: string;
}

export interface ExtractedElements {
  error_codes: string[];
  connectors: string[];
  reference_chapters: string[];
  diagnostic_chapters: string[];
  components: string[];
  reasoning: string;
  needs_followup: boolean;
}

export interface ChapterClassification {
  main: number[];
  connector: number[];
  sub: number[];
  ignore: number[];
}

export interface ClassifiedResults {
  main: SearchResult[];
  connector: SearchResult[];
  sub: SearchResult[];
}

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
  imageUrls?: string[];
  pdfUrls?: { title: string; url: string }[];
}

export interface MultiStepReasoningRequest {
  query: string;
  /** Legacy list of document numbers. */
  selectedPdfs?: string[];
  /** Full document metadata from DocumentSearch. */
  selectedDocuments?: SelectedDocument[];
  /** Client-generated chat session id used for Blob logging. */
  chatSessionId?: string;
  /** Logged-in user's email for chat log storage. */
  userEmail?: string;
  chatHistory: ChatMessage[];
}

export interface MultiStepReasoningResponse {
  answer: string;
  thinkingSteps: ThinkingStep[];
  imageUrls: string[];
  pdfUrls: { title: string; url: string }[];
  followupQuestions: string[];
}

export interface ImageExplanation {
  caption: string;
  ocr_text: string;
  label_list: string[];
  md_anchor_quotes: string[];
  procedure_step_number: string;
  page_number: number;
  cropped_image_path: string;
}

export interface ChapterRef {
  ref_id: string;
  title: string;
  result: SearchResult;
  is_main: boolean;
  is_connector: boolean;
}
