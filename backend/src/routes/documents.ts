import { Router, Request, Response } from 'express';
import { loadDocumentsCatalog } from '../services/tocLoader';
import { searchDocuments } from '../services/documentSearch';
import { fetchTocByDocumentNumber } from '../services/cosmosToc';
import { getSearchClient } from '../services/azureSearch';
import { buildTOCPdfBlobNameCandidates, blobExists, createSasUrl } from '../services/azureBlob';
import { config } from '../config';
import { SEARCH_FIELDS } from '../config';
import fs from 'fs';
import { SearchResult } from '../types';

const router = Router();

// GET /api/documents - Get document catalog (legacy/local fallback)
router.get('/api/documents', (req: Request, res: Response) => {
  try {
    const catalog = loadDocumentsCatalog();
    res.json(catalog);
  } catch (error) {
    console.error('Error loading documents:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/documents/search - Search chatbot-enabled documents via external API
router.post('/api/documents/search', async (req: Request, res: Response) => {
  try {
    const { model, serial, language } = req.body;

    if (!model || !language) {
      return res.status(400).json({ error: 'Model and language are required' });
    }

    const docs = await searchDocuments({ model, serial, language });
    res.json(docs);
  } catch (error) {
    console.error('Error searching documents:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message,
    });
  }
});

// GET /api/documents/:documentNumber/toc - Fetch TOC from Cosmos DB
router.get('/api/documents/:documentNumber/toc', async (req: Request, res: Response) => {
  try {
    const documentNumber = req.params.documentNumber;
    if (!documentNumber) {
      return res.status(400).json({ error: 'documentNumber is required' });
    }

    const toc = await fetchTocByDocumentNumber(documentNumber);
    res.json({ documentNumber, count: toc.length, toc });
  } catch (error) {
    console.error('Error fetching TOC from Cosmos DB:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message,
    });
  }
});

// GET /api/documents/debug - Diagnostics for documents catalog/TOC availability
router.get('/api/documents/debug', (req: Request, res: Response) => {
  try {
    const documentsJsonPath = config.documentsJsonPath;
    const tocDir = config.tocDir;

    const documentsJsonExists = !!documentsJsonPath && fs.existsSync(documentsJsonPath);
    const tocDirExists = !!tocDir && fs.existsSync(tocDir);

    res.json({
      env: {
        DOCUMENTS_JSON_PATH: process.env.DOCUMENTS_JSON_PATH ?? null,
        TOC_DIR: process.env.TOC_DIR ?? null,
      },
      resolved: {
        documentsJsonPath,
        tocDir,
      },
      exists: {
        documentsJson: documentsJsonExists,
        tocDir: tocDirExists,
      },
      stats: {
        documentsJsonBytes: documentsJsonExists ? fs.statSync(documentsJsonPath).size : null,
        tocMdCount: tocDirExists
          ? fs.readdirSync(tocDir).filter((f) => f.toLowerCase().endsWith('.md')).length
          : null,
      },
    });
  } catch (error) {
    console.error('Error in documents debug endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/documents/azure-search/debug - Return raw Azure AI Search records as JSON
router.get('/api/documents/azure-search/debug', async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : '*';
    const top = Number.parseInt(typeof req.query.top === 'string' ? req.query.top : '20', 10);
    const safeTop = Number.isFinite(top) && top > 0 ? Math.min(top, 100) : 20;
    const resolveBlobs = typeof req.query.resolve === 'string'
      ? ['1', 'true', 'yes'].includes(req.query.resolve.toLowerCase())
      : false;

    const documentNumbers = typeof req.query.documentNumber === 'string'
      ? req.query.documentNumber.split(',').map((v) => v.trim()).filter(Boolean)
      : [];
    const paths = typeof req.query.path === 'string'
      ? req.query.path.split(',').map((v) => v.trim()).filter(Boolean)
      : [];

    const filters: string[] = [];
    if (documentNumbers.length > 0) {
      filters.push(`(${documentNumbers.map((num) => `documentNumber eq '${num.replace(/'/g, "''")}'`).join(' or ')})`);
    }
    if (paths.length > 0) {
      filters.push(`(${paths.map((p) => `path eq '${p.replace(/'/g, "''")}'`).join(' or ')})`);
    }

    const filter = filters.length > 0 ? filters.join(' and ') : undefined;
    const client = getSearchClient();
    const searchResults = await client.search(q, {
      filter,
      select: SEARCH_FIELDS,
      top: safeTop,
    } as any);

    const results = [] as any[];
    for await (const result of searchResults.results) {
      const document = result.document as SearchResult;
      const entry: any = {
        score: result.score ?? null,
        rerankerScore: (result as any).rerankerScore ?? null,
        document,
      };

      if (resolveBlobs) {
        const pdfCandidates = buildTOCPdfBlobNameCandidates(document);
        const resolvedPdfCandidates: Array<{ blobName: string; exists: boolean; sasUrl?: string | null }> = [];
        for (const blobName of pdfCandidates) {
          const exists = await blobExists(blobName);
          resolvedPdfCandidates.push({
            blobName,
            exists,
            sasUrl: exists ? await createSasUrl(blobName) : null,
          });
        }

        const samePagePaths = Array.isArray(document.same_page_paths) ? document.same_page_paths : [];
        const resolvedImageCandidates: Array<{ blobName: string; exists: boolean; sasUrl?: string | null }> = [];
        for (const blobName of samePagePaths) {
          const exists = await blobExists(blobName);
          resolvedImageCandidates.push({
            blobName,
            exists,
            sasUrl: exists ? await createSasUrl(blobName) : null,
          });
        }

        entry.resolution = {
          pdfCandidates: resolvedPdfCandidates,
          imageCandidates: resolvedImageCandidates,
        };
      }

      results.push(entry);
    }

    res.json({
      query: q,
      top: safeTop,
      resolveBlobs,
      filter: filter ?? null,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error('Error querying Azure AI Search debug endpoint:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: (error as Error).message,
    });
  }
});

export default router;
