import { config } from '../config';
import { DocumentSearchItem, DocumentSearchResponse } from '../types';

export interface SearchDocumentsParams {
  model: string;
  serial?: string;
  language: string;
}

/**
 * Calls the external DocumentSearch API and returns both shop_manual and operation_and_maintenance_manual documents.
 */
export async function searchDocuments(
  params: SearchDocumentsParams
): Promise<DocumentSearchResponse> {
  const { model, serial = '', language } = params;

  if (!config.documentSearch.subscriptionKey) {
    throw new Error('DOCUMENT_SEARCH_SUBSCRIPTION_KEY is not configured');
  }

  const body = {
    Model: model,
    Language: language,
    RequiredDocumentsUrl: true,
    Serial: serial,
    SortingLanguage: language,
    UserEmail: 'user@example.com',
    SkipAccessCheck: true,
  };

  const response = await fetch(config.documentSearch.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': config.documentSearch.subscriptionKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `DocumentSearch API error: ${response.status} ${response.statusText} - ${text}`
    );
  }

  const data = (await response.json()) as DocumentSearchResponse;

  const mapDocument = (doc: DocumentSearchItem): DocumentSearchItem => ({
    documentNumber: doc.documentNumber,
    documentTitle: doc.documentTitle,
    documentType: doc.documentType,
    language: doc.language,
    fileSize: doc.fileSize,
    fileName: doc.fileName,
    sourceDocumentType: doc.sourceDocumentType,
    documentUrl: doc.documentUrl,
    modelSerialAssociation: doc.modelSerialAssociation,
  });

  return {
    shop_manual: (data.shop_manual || []).map(mapDocument),
    operation_and_maintenance_manual: (data.operation_and_maintenance_manual || []).map(mapDocument),
  };
}
