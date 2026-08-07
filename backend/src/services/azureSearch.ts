import { SearchClient, SearchIndexClient, AzureKeyCredential } from '@azure/search-documents';
import { config, SEARCH_FIELDS } from '../config';
import { SearchResult } from '../types';
import { getTextEmbedding } from './openai';

const searchClients = new Map<string, SearchClient<SearchResult>>();
let indexClient: SearchIndexClient | null = null;

export function getSearchClient(indexName: string = config.azureSearch.indexName): SearchClient<SearchResult> {
  if (!searchClients.has(indexName)) {
    searchClients.set(
      indexName,
      new SearchClient<SearchResult>(
        config.azureSearch.endpoint,
        indexName,
        new AzureKeyCredential(config.azureSearch.apiKey)
      )
    );
  }
  return searchClients.get(indexName)!;
}

export function getIndexClient(): SearchIndexClient {
  if (!indexClient) {
    indexClient = new SearchIndexClient(
      config.azureSearch.endpoint,
      new AzureKeyCredential(config.azureSearch.apiKey)
    );
  }
  return indexClient;
}

export async function searchByTOCFilter(
  tocTitles: string[],
  pdfFilterPaths: string[],
  indexName?: string
): Promise<SearchResult[]> {
  const client = getSearchClient(indexName);
  const results: SearchResult[] = [];
  
  // Build exact path filter
  const tocFilter = tocTitles.map((path) => `path eq '${path.replace(/'/g, "''")}'`).join(' or ');
  
  // Build document number filter
  let docFilter = '';
  if (pdfFilterPaths.length > 0 && !pdfFilterPaths.includes('All Documents')) {
    docFilter = pdfFilterPaths.map(num => `documentNumber eq '${num}'`).join(' or ');
  }
  
  // Combine filters
  let filter = tocFilter;
  if (docFilter) {
    filter = `(${tocFilter}) and (${docFilter})`;
  }
  
  const batchSize = 1000;
  let skip = 0;
  
  while (true) {
    const searchResults = await client.search('*', {
      filter,
      select: SEARCH_FIELDS,
      skip,
      top: batchSize,
    });
    
    let batchCount = 0;
    for await (const result of searchResults.results) {
      results.push(result.document as SearchResult);
      batchCount++;
    }
    
    if (batchCount < batchSize) break;
    skip += batchSize;
  }
  
  return results;
}

export async function searchByTOCTitleFilter(
  tocTitles: string[],
  pdfFilterPaths: string[],
  indexName?: string
): Promise<SearchResult[]> {
  const client = getSearchClient(indexName);
  const results: SearchResult[] = [];

  if (tocTitles.length === 0) {
    return results;
  }

  // Match exact paths in Azure AI Search.
  const tocFilter = tocTitles.map((path) => `path eq '${path.replace(/'/g, "''")}'`).join(' or ');

  // Build document number filter
  let docFilter = '';
  if (pdfFilterPaths.length > 0 && !pdfFilterPaths.includes('All Documents')) {
    docFilter = pdfFilterPaths.map((num) => `documentNumber eq '${num}'`).join(' or ');
  }

  let filter = tocFilter;
  if (docFilter) {
    filter = `(${tocFilter}) and (${docFilter})`;
  }

  const batchSize = 1000;
  let skip = 0;

  while (true) {
    const searchResults = await client.search('*', {
      filter,
      select: SEARCH_FIELDS,
      skip,
      top: batchSize,
    });

    let batchCount = 0;
    for await (const result of searchResults.results) {
      results.push(result.document as SearchResult);
      batchCount++;
    }

    if (batchCount < batchSize) break;
    skip += batchSize;
  }

  return results;
}

export async function hybridSearch(
  query: string,
  pdfFilterPaths: string[],
  top: number = 5,
  indexName?: string
): Promise<SearchResult[]> {
  const client = getSearchClient(indexName);
  
  // Build document number filter
  let filter = '';
  if (pdfFilterPaths.length > 0 && !pdfFilterPaths.includes('All Documents')) {
    filter = pdfFilterPaths.map(num => `documentNumber eq '${num}'`).join(' or ');
  }
  
  // Hybrid: vector + text (falls back to text-only if embedding isn't available)
  let embedding: number[] | null = null;
  try {
    if (config.aiInference.endpoint && config.aiInference.modelName) {
      embedding = await getTextEmbedding(query);
    }
  } catch (e) {
    console.warn('Embedding generation failed; falling back to text-only search', e);
    embedding = null;
  }

  const searchResults = await client.search(query, {
    filter: filter || undefined,
    select: SEARCH_FIELDS,
    top,
    ...(embedding
      ? {
          vectorQueries: [
            {
              kind: 'vector',
              vector: embedding,
              kNearestNeighborsCount: Math.max(top, 10),
              fields: ['contentVector'],
            } as any,
          ],
        }
      : {}),
  } as any);
  
  const results: SearchResult[] = [];
  for await (const result of searchResults.results) {
    results.push(result.document as SearchResult);
  }
  
  return results;
}
