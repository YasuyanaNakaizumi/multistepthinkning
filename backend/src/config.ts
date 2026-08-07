import dotenv from 'dotenv';
import path from 'path';

function resolveRepoPath(...segments: string[]): string {
  // In dev, cwd is typically <repo>/backend.
  // In prod (compiled), cwd is where node process is started.
  // Prefer resolving relative to current working directory first.
  return path.resolve(process.cwd(), ...segments);
}

function env(v: string | undefined): string {
  let value = (v ?? '').trim();
  // Strip matching surrounding quotes that are commonly added when pasting secrets.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function resolvePathFromRepoRoot(p: string): string {
  if (!p) return p;
  // If an absolute path, keep it.
  if (path.isAbsolute(p)) return p;
  // Dev: when started from <repo>/backend, treat relative paths as repo-root relative.
  // Prod: when started from repo root (e.g. /app in container), treat relative paths as cwd-relative.
  const cwdBase = path.basename(process.cwd());
  if (cwdBase.toLowerCase() === 'backend') {
    return resolveRepoPath('..', p);
  }
  return resolveRepoPath(p);
}

// Load env vars from `frontend_java/.env`.
// `npm run dev` starts this Node backend from `frontend_java/backend`,
// so the .env file is expected to live in the parent `frontend_java` directory.
// Keep override enabled so the local .env wins even if a parent process already injected values.
const envFilePath = resolveRepoPath('..', '.env');
dotenv.config({ path: envFilePath, override: true });

// Resolve a relative path against the .env file's directory, regardless of the CWD.
const envFileDir = path.dirname(envFilePath);
function resolveFromEnvDir(p: string): string {
  if (!p || path.isAbsolute(p)) return p;
  return path.resolve(envFileDir, p);
}

export const config = {
  // Azure AD / Entra ID
  azureAd: {
    clientId: env(process.env.AZURE_AD_CLIENT_ID),
    tenantId: env(process.env.AZURE_AD_TENANT_ID),
    redirectUri: env(process.env.AZURE_AD_REDIRECT_URI),
    certThumbprint: env(process.env.AZURE_AD_CERT_THUMBPRINT),
    certPrivateKeyPath: resolveFromEnvDir(env(process.env.AZURE_AD_CERT_PRIVATE_KEY_PATH)),
    certPublicPath: resolveFromEnvDir(env(process.env.AZURE_AD_CERT_PUBLIC_PATH) || 'certificate.crt'),
  },

  // Azure Foundry / Model Inference (Chat)
  azureOpenAI: {
    endpoint: env(process.env.AZURE_OPENAI_ENDPOINT),
    apiKey: env(process.env.AZURE_OPENAI_API_KEY),
    apiVersion: env(process.env.AZURE_OPENAI_API_VERSION) || '2025-04-01-preview',
    deployment: env(process.env.AZURE_OPENAI_DEPLOYMENT)
      || env(process.env.AZURE_OPENAI_DEPLOYMENT_NAME)
      || env(process.env.AZURE_OPENAI_DEPLOYMENT_NAME),
  },

  // Azure Foundry / Model Inference (Embeddings)
  aiInference: {
    endpoint: env(process.env.AZURE_AI_INFERENCE_ENDPOINT),
    modelName: env(process.env.AZURE_AI_INFERENCE_MODEL_NAME),
    apiKey: env(process.env.AZURE_AI_INFERENCE_API_KEY) || env(process.env.AZURE_OPENAI_API_KEY),
    // If you use Entra ID auth, set AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET
    authMode: (process.env.AZURE_AI_INFERENCE_AUTH_MODE || 'api_key') as 'api_key' | 'entra_id',
  },
  
  // Azure AI Search
  azureSearch: {
    endpoint: env(process.env.AZURE_SEARCH_ENDPOINT),
    apiKey: env(process.env.AZURE_SEARCH_API_KEY),
    indexName: env(process.env.AZURE_SEARCH_INDEX_NAME),
    indexNameOmm: env(process.env.AZURE_SEARCH_INDEX_NAME_OMM) || env(process.env.AZURE_SEARCH_INDEX_NAME),
  },
  
  // Azure Blob Storage
  azureStorage: {
    connectionString: env(process.env.AZURE_STORAGE_CONNECTION_STRING),
    containerName: env(process.env.AZURE_STORAGE_CONTAINER_NAME),
  },

  // Separate Blob storage for chat logs
  chatBlob: {
    connectionString:
      env(process.env.AZURE_CHAT_BLOB_CONNECTION_STRING) || env(process.env.AZURE_STORAGE_CONNECTION_STRING),
    containerName:
      env(process.env.AZURE_CHAT_BLOB_CONTAINER_NAME) || env(process.env.AZURE_STORAGE_CONTAINER_NAME),
  },

  // External Document Search API (APIM)
  documentSearch: {
    endpoint:
      env(process.env.DOCUMENT_SEARCH_API_URL) ||
      'https://aibot-apim-prod-jpe.azure-api.net/external/DocumentSearch',
    subscriptionKey: env(process.env.DOCUMENT_SEARCH_SUBSCRIPTION_KEY),
  },

  // Cosmos DB (TOC source)
  cosmosDb: {
    endpoint: env(process.env.COSMOS_DB_ENDPOINT).replace(/\/$/, ''),
    key: env(process.env.COSMOS_DB_KEY),
    database: env(process.env.COSMOS_DB_DATABASE) || 'aibot',
    container: env(process.env.COSMOS_DB_CONTAINER) || 'master-data',
  },

  // Application
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Paths
  // Prefer explicit env vars. Otherwise resolve relative to repo root.
  tocDir: process.env.TOC_DIR ? resolvePathFromRepoRoot(env(process.env.TOC_DIR)) : resolveRepoPath('..', 'md_out_toc'),
  documentsJsonPath: process.env.DOCUMENTS_JSON_PATH
    ? resolvePathFromRepoRoot(env(process.env.DOCUMENTS_JSON_PATH))
    : resolveRepoPath('..', 'documents.json'),
};

export const SEARCH_FIELDS = [
  'id',
  'TOC',
  'path',
  'parent_path',
  'content',
  'fileName',
  'start_page',
  'end_page',
  'image_content',
  'same_page_paths',
  'documentNumber',
  'documentTitle',
  'documentType',
  'document_id',
  'language',
] as const;
