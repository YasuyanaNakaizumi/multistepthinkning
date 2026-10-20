# Multi-Stage Thinking Chat Application

A sophisticated multi-stage reasoning chat application with Azure AI integration, featuring collapsible thinking process visualization, streaming responses, and intelligent SAS link insertion for documents and images.

## Features

- **Multi-Stage Reasoning**: Implements a 6-step reasoning process based on the processing flow specification
- **Collapsible Thinking Process**: Visual display of each reasoning step, collapsed by default with detailed descriptions on expansion
- **Streaming Responses**: Real-time streaming of AI-generated answers
- **SAS Link Insertion**: Automatic insertion of SAS URLs for images and TOC PDFs during streaming
- **Modern UI**: Built with React, TypeScript, TailwindCSS, and shadcn/ui components
- **Azure Integration**: Seamless integration with Azure OpenAI, Azure AI Search, and Azure Blob Storage

## Architecture

### Backend (Node.js/Express with TypeScript)
- **Multi-Step Reasoning Service**: Implements the complete 6-step reasoning flow
- **Azure AI Search Integration**: TOC-based filtering and hybrid vector search
- **Azure OpenAI Integration**: GPT-powered query generation, chapter selection, and answer generation
- **Azure Blob Storage**: SAS URL generation for secure document access
- **TOC Loader**: Loads and processes table of contents markdown files

### Frontend (React with Vite)
- **Modern UI Components**: Built with shadcn/ui and TailwindCSS
- **Collapsible Thinking Process**: Accordion-based step visualization
- **Streaming Chat Interface**: Real-time message streaming with markdown rendering
- **Document Selection**: Sidebar for selecting documents to search
- **Responsive Design**: Mobile-friendly interface

## Prerequisites

- Node.js 20 or higher
- npm or yarn
- Azure OpenAI resource
- Azure AI Search service
- Azure Blob Storage account
- Docker (for containerization)

## Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd frontend_java
```

### 2. Install Dependencies

```bash
npm install
```

This will install dependencies for both backend and frontend workspaces.

### 3. Configure Environment Variables

Copy the example environment file and configure your Azure credentials:

```bash
cp .env.example .env
```

Edit `.env` with your Azure configuration:

```env
# Azure OpenAI / Responses
AZURE_OPENAI_ENDPOINT=https://your-resource.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview
AZURE_OPENAI_API_KEY=your-openai-api-key
AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment
# Foundry Conversations + paired Responses (must end with /openai/v1)
AZURE_OPENAI_CONVERSATIONS_ENDPOINT=https://your-resource.services.ai.azure.com/api/projects/your-project/openai/v1

# Embeddings (optional key; falls back to AZURE_OPENAI_API_KEY)
AZURE_AI_INFERENCE_ENDPOINT=https://your-resource.services.ai.azure.com/models
AZURE_AI_INFERENCE_MODEL_NAME=cohere-embedding

# Azure AI Search
AZURE_SEARCH_ENDPOINT=https://your-search-service.search.windows.net
AZURE_SEARCH_API_KEY=your-search-api-key
AZURE_SEARCH_INDEX_NAME=your-index-name
AZURE_SEARCH_INDEX_NAME_OMM=your-omm-index-name

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=youraccount;...
AZURE_STORAGE_CONTAINER_NAME=your-container-name

# Chat Log Blob Storage
AZURE_CHAT_BLOB_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=yourchataccount;...
AZURE_CHAT_BLOB_CONTAINER_NAME=your-chat-log-container

# Document Search API
DOCUMENT_SEARCH_API_URL=https://your-apim.azure-api.net/external/DocumentSearch
DOCUMENT_SEARCH_SUBSCRIPTION_KEY=your-subscription-key

# Cosmos DB (TOC)
COSMOS_DB_ENDPOINT=https://your-cosmos.documents.azure.com:443/
COSMOS_DB_KEY=your-cosmos-key
COSMOS_DB_DATABASE=aibot
COSMOS_DB_CONTAINER=master-data

# Azure AD / Entra ID
AZURE_AD_CLIENT_ID=your-azure-ad-client-id
AZURE_AD_TENANT_ID=your-azure-ad-tenant-id
AZURE_AD_REDIRECT_URI=http://localhost:3000
AZURE_AD_CERT_THUMBPRINT=your-cert-thumbprint
AZURE_AD_CERT_PUBLIC_PATH=certificate.crt
AZURE_AD_CERT_PRIVATE_KEY_PATH=private_key.pem
```

### 4. Prepare Data Files

Create the required data files:

- **`documents.json`**: JSON file containing document catalog
  ```json
  [
    {
      "documentNumber": "SEN06867-11",
      "documentTitle": "Shop Manual Example"
    }
  ]
  ```

- **`md_out_toc/`**: Directory containing TOC markdown files
  - Place `.md` files with table of contents for each document
  - Filename format: `{documentNumber}.md` or use `All Documents` to load all

## Development

### Start Development Servers

Run both backend and frontend in development mode:

```bash
npm run dev
```

This will start:
- Backend server on `http://localhost:3001`
- Frontend dev server on `http://localhost:3000`

The frontend proxies API requests to the backend automatically.

### Start Backend Only

```bash
npm run dev:backend
```

### Start Frontend Only

```bash
npm run dev:frontend
```

## Building

### Build for Production

```bash
npm run build
```

This builds both backend and frontend for production deployment.

### Build Backend Only

```bash
npm run build:backend
```

### Build Frontend Only

```bash
npm run build:frontend
```

## Docker Deployment

### Build Docker Image

```bash
docker build -t multi-stage-thinking-chat .
```

### Run with Docker Compose

```bash
docker-compose up -d
```

This will start both backend and frontend services.

### Standalone Backend Container

```bash
cd backend
docker build -t multi-stage-chat-backend .
docker run -p 3001:3001 --env-file .env multi-stage-chat-backend
```

### Standalone Frontend Container

```bash
cd frontend
docker build -t multi-stage-chat-frontend .
docker run -p 3000:80 multi-stage-chat-frontend
```

## Azure Container App Deployment

### 1. Build and Push Image

```bash
az acr build --registry your-registry --image multi-stage-thinking-chat:latest .
```

### 2. Update Configuration

Edit `azure-container-app.yaml` with your specific values:
- Resource group name
- Location
- Container registry
- Secret values

### 3. Deploy using Azure CLI

```bash
az containerapp create \
  --resource-group your-resource-group \
  --name multi-stage-thinking-chat \
  --yaml azure-container-app.yaml
```

## API Endpoints

### POST `/api/chat`
Non-streaming chat (runs the Response Agent end-to-end). Prefer `/api/chat/stream` for the UI.

**Request Body:**
```json
{
  "query": "Your question here",
  "selectedPdfs": ["SEN06867-01"],
  "selectedDocuments": [],
  "chatHistory": [],
  "mode": "thinking",
  "chatSessionId": "optional-session-id",
  "conversationId": "optional-azure-conversation-id"
}
```

**Response:**
```json
{
  "answer": "...",
  "thinkingSteps": [],
  "imageUrls": [],
  "pdfUrls": [],
  "conversationId": "conv_...",
  "responseId": "resp_..."
}
```

### POST `/api/chat/stream`
SSE stream: thinking steps, tool events, answer chunks, then final meta (`conversationId`, assets, token usage).

**Request Body:** Same as `/api/chat`

**Response:** Server-Sent Events (`steps`, `chunk`, `meta`, `final`, `done`)

### GET `/api/documents`
Get the document catalog.

**Response:**
```json
[
  {
    "documentNumber": "SEN06867-11",
    "documentTitle": "Shop Manual Example"
  }
]
```

### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Response Agent Flow

Chat uses a single Responses API agent (`runResponseAgent`):

1. **Select TOC** via `select_toc_bookmarks` (inner GPT picks paths; TOC cached for the turn)
2. **Fetch chapters** via `fetch_chapters_by_paths` (host loads text/images; no TOC GPT)
3. **Optional 2nd select+fetch** (Thinking mode) when MAIN bodies need cross-refs / connectors / related fault codes
4. **Answer** from the same agent (no separate final-answer model), with `[[PDF:shop-N]]` / `[[IMG:]]` expanded to SAS links
5. **Conversation continuity** via Azure Conversations API + Blob-stored citation maps

Fast mode: one select+fetch then answer. Thinking mode: up to two fetches.

## SAS Link Insertion

During answer streaming the host expands:

- **`[[IMG:filename]]`** → image SAS markdown
- **`[[PDF:shop-N]]`** → `[Title](<SAS_URL>)` markdown links

## Troubleshooting

### CSS Warnings
Warnings about `@tailwind` and `@apply` rules are expected during development and will resolve once Tailwind CSS dependencies are installed.

### Port Conflicts
If port 3001 or 3000 are in use, modify the `PORT` environment variable or Vite config.

### Azure Connection Issues
- Verify all Azure credentials in `.env` are correct
- Ensure your Azure resources are in the same region
- Check that your IP has access to Azure resources

### Missing Data Files
- Ensure `documents.json` exists with valid document catalog
- Verify `md_out_toc/` directory contains TOC markdown files

## License

[Your License Here]

## Support

For issues and questions, please contact [your support contact].
