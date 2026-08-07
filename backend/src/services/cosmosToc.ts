import { CosmosClient } from '@azure/cosmos';
import { config } from '../config';

export interface CosmosTocNode {
  level: number;
  title: string;
  page: number;
  end_page: number;
  text?: string;
  meta_flag?: string;
  path: string;
  children?: CosmosTocNode[];
}

export interface FlatTocEntry {
  level: number;
  title: string;
  page: number;
  endPage: number;
  path: string;
}

function flattenNode(node: CosmosTocNode, acc: FlatTocEntry[] = []): FlatTocEntry[] {
  // Skip the synthetic root node (title === 'root') but keep its children.
  if (node.title !== 'root') {
    acc.push({
      level: node.level,
      title: node.title,
      page: node.page,
      endPage: node.end_page,
      path: node.path,
    });
  }
  for (const child of node.children || []) {
    flattenNode(child, acc);
  }
  return acc;
}

function buildClient() {
  const { endpoint, key } = config.cosmosDb;
  if (!endpoint) {
    throw new Error('Cosmos DB endpoint is missing. Set COSMOS_DB_ENDPOINT.');
  }
  if (!key) {
    throw new Error('Cosmos DB key is missing. Set COSMOS_DB_KEY.');
  }
  return new CosmosClient({ endpoint, key });
}

export async function fetchTocByDocumentNumber(documentNumber: string): Promise<FlatTocEntry[]> {
  const client = buildClient();
  const { database, container } = config.cosmosDb;

  const normalizedDocNumber = documentNumber.toUpperCase().trim();

  const querySpec = {
    query: 'SELECT c["value"] FROM c WHERE c.documentNumber = @docNum',
    parameters: [{ name: '@docNum', value: normalizedDocNumber }],
  };

  const containerClient = client.database(database).container(container);
  let resources: Record<string, any>[] = [];

  try {
    const result = await containerClient.items.query<Record<string, any>>(querySpec).fetchAll();
    resources = result.resources;
    console.log(`[Cosmos] TOC ${normalizedDocNumber}: ${resources.length} doc(s)`);
  } catch (paramError: any) {
    console.warn('[Cosmos] Parameterized query failed, trying direct query. Error:', paramError?.message || paramError);
    // Fallback to a direct string query (documentNumber is uppercased and single quotes are escaped).
    const directQuery = `SELECT c["value"] FROM c WHERE c.documentNumber = '${normalizedDocNumber.replace(/'/g, "''")}'`;
    const directResult = await containerClient.items.query<Record<string, any>>({ query: directQuery }).fetchAll();
    resources = directResult.resources;
    console.log(`[Cosmos] TOC ${normalizedDocNumber} (direct): ${resources.length} doc(s)`);
  }

  if (!resources.length) {
    return [];
  }

  // SELECT c.value returns { value: <toc node> }
  const first = resources[0];
  const root: CosmosTocNode | undefined = first?.value ?? first;
  if (!root || typeof root !== 'object') {
    throw new Error('Unexpected Cosmos response shape: missing value property.');
  }

  return flattenNode(root);
}

export function escapePathForODataFilter(path: string): string {
  return path.replace(/'/g, "''");
}

export function buildTocContent(entries: FlatTocEntry[]): string {
  return entries
    .map((entry) => {
      const indent = '  '.repeat(entry.level);
      return `${indent}path: ${entry.path}\n${indent}title: ${entry.title}`;
    })
    .join('\n');
}
