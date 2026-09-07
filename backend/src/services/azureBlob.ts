import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from '@azure/storage-blob';
import { config } from '../config';
import { URL } from 'url';
import { SearchResult } from '../types';

let blobServiceClient: BlobServiceClient | null = null;

export function getBlobServiceClient(): BlobServiceClient {
  if (!blobServiceClient) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      config.azureStorage.connectionString
    );
  }
  return blobServiceClient;
}

export function getContainerClient() {
  const serviceClient = getBlobServiceClient();
  return serviceClient.getContainerClient(config.azureStorage.containerName);
}

export function extractBlobNameFromReference(blobUrl: string): string | null {
  try {
    if (!blobUrl.startsWith('http')) {
      // Container-relative path
      return decodeURIComponent(blobUrl);
    }
    
    const url = new URL(blobUrl);
    const pathname = url.pathname;
    // Extract /container/blob
    const parts = pathname.split('/');
    if (parts.length >= 2) {
      return decodeURIComponent(parts.slice(2).join('/'));
    }
    return null;
  } catch (error) {
    console.error('Error extracting blob name:', error);
    return null;
  }
}

export async function createSasUrl(blobUrl: string): Promise<string> {
  try {
    const blobName = extractBlobNameFromReference(blobUrl);
    if (!blobName) {
      return blobUrl;
    }

    // Blob paths in the OMM index sometimes use the Unicode angle quotation mark (›)
    // while the actual Azure Blob name uses the greater-than sign (>).
    const normalizedBlobName = blobName.replace(/›/g, '>');
    
    const serviceClient = getBlobServiceClient();
    const containerName = config.azureStorage.containerName;
    
    // Generate SAS token
    const isPdf = normalizedBlobName.toLowerCase().endsWith('.pdf');
    const sasOptions: any = {
      containerName,
      blobName: normalizedBlobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn: new Date(Date.now() - 5 * 60 * 1000),
      expiresOn: new Date(Date.now() + 3600 * 1000), // 1 hour
      protocol: SASProtocol.Https,
    };
    if (isPdf) {
      // Ensure the browser/iframe displays the PDF instead of downloading it.
      sasOptions.contentDisposition = 'inline';
      sasOptions.contentType = 'application/pdf';
    }
    
    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      (serviceClient as any).credential
    ).toString();
    
    // Build URL using SDK to ensure correct path encoding (avoids signature mismatches)
    // Then post-process to percent-encode characters that may appear unescaped in the path.
    const blobClient = serviceClient.getContainerClient(containerName).getBlobClient(normalizedBlobName);
    const u = new URL(blobClient.url);
    // Encode parentheses explicitly to match strict "fully encoded" blob URL expectations.
    // Note: keep existing %xx sequences intact.
    u.pathname = u.pathname.replace(/\(/g, '%28').replace(/\)/g, '%29');
    const sasUrl = `${u.toString()}?${sasToken}`;
    
    return sasUrl;
  } catch (error) {
    console.error('Error creating SAS URL:', error);
    return blobUrl;
  }
}

function getStorageAccountName(): string | null {
  const connectionString = config.azureStorage.connectionString;
  if (!connectionString) {
    return null;
  }

  const match = connectionString.match(/(?:^|;)AccountName=([^;]+)/i);
  return match?.[1]?.trim() || null;
}

export function buildDirectBlobUrl(blobPath: string): string | null {
  try {
    const accountName = getStorageAccountName();
    const containerName = config.azureStorage.containerName;
    if (!accountName || !containerName) {
      return null;
    }

    const normalizedPath = blobPath.replace(/^\/+/, '');
    const encodedPath = normalizedPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return `https://${accountName}.blob.core.windows.net/${containerName}/${encodedPath}`;
  } catch (error) {
    console.error('Error building direct blob URL:', error);
    return null;
  }
}

export async function blobExists(blobName: string): Promise<boolean> {
  try {
    if (!blobName) return false;
    const containerClient = getContainerClient();
    return await containerClient.getBlobClient(blobName).exists();
  } catch (error) {
    console.error('Error checking blob existence:', error);
    return false;
  }
}

export async function listBlobsByPrefix(prefix: string): Promise<string[]> {
  try {
    const containerClient = getContainerClient();
    const blobs: string[] = [];
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
      blobs.push(blob.name);
    }
    return blobs;
  } catch (error) {
    console.error('Error listing blobs:', error);
    return [];
  }
}

export function buildTOCPdfBlobNameCandidates(result: SearchResult): string[] {
  const candidates: string[] = [];
  try {
    const { documentNumber, path, TOC } = result;
    const documentId = (result as any).document_id as string | undefined;

    if (!documentNumber) {
      return candidates;
    }

    let documentFolder: string | null = null;
    if (documentId) {
      const lowerId = documentId.toLowerCase();
      const suffix = `_${documentNumber.toLowerCase()}`;
      documentFolder = lowerId.endsWith(suffix)
        ? lowerId.slice(0, lowerId.length - suffix.length)
        : lowerId;
    }

    if (!documentFolder) {
      return candidates;
    }

    const pathCandidate = typeof path === 'string' ? path.trim() : '';
    const tocCandidate = typeof TOC === 'string' ? TOC.trim() : '';

    let chapterPath = '';
    if (pathCandidate) {
      chapterPath = pathCandidate.replace(/›/g, '>');
    } else if (tocCandidate) {
      chapterPath = tocCandidate.replace(/›/g, '>');
    }

    const chapterNoExt = chapterPath.replace(/\.pdf$/i, '').trim();
    if (!chapterNoExt) {
      return candidates;
    }
    if (chapterNoExt.toLowerCase() === documentNumber.toLowerCase() && tocCandidate) {
      chapterPath = tocCandidate;
    }

    const pdfPath = chapterPath.toLowerCase().endsWith('.pdf') ? chapterPath : `${chapterPath}.pdf`;
    let normalizedPdfPath = pdfPath.replace(/^\/+/, '');
    normalizedPdfPath = normalizedPdfPath.replace(/^pdfs\/processed\//i, '');
    normalizedPdfPath = normalizedPdfPath.replace(/^chunks\/[A-Za-z0-9_-]+\//i, '');
    normalizedPdfPath = normalizedPdfPath.replace(new RegExp(`^chunks\/${documentNumber.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\/`, 'i'), '');

    // OMM chunks are stored under a folder derived from fileName (e.g., PENC1607-04-MA4)
    // with the path/TOC as the actual PDF file name.
    const fileName = (result as any).fileName as string | undefined;
    const baseFile = fileName ? fileName.replace(/\.pdf$/i, '') : documentNumber;

    if (fileName) {
      candidates.push(`pdfs/processed/${documentFolder}/chunks/${baseFile}/${normalizedPdfPath}`);
      candidates.push(`pdfs/processed/${documentFolder}/${fileName}`);
      candidates.push(`pdfs/processed/${documentFolder}/${baseFile}.pdf`);
      if (baseFile.toLowerCase() !== documentNumber.toLowerCase()) {
        candidates.push(`pdfs/processed/${documentFolder}/chunks/${documentNumber}/${normalizedPdfPath}`);
      }
    } else {
      candidates.push(`pdfs/processed/${documentFolder}/chunks/${documentNumber}/${normalizedPdfPath}`);
    }

    candidates.push(`pdfs/processed/${documentFolder}/${normalizedPdfPath}`);
    return Array.from(new Set(candidates));
  } catch (error) {
    console.error('Error building TOC PDF blob name candidates:', error);
    return [];
  }
}

export async function buildTOCPdfBlobName(result: SearchResult): Promise<string | null> {
  try {
    const candidates = buildTOCPdfBlobNameCandidates(result);
    if (candidates.length === 0) return null;

    // Check candidates in parallel, then keep the first existing path in preference order.
    const existence = await Promise.all(
      candidates.map(async (candidate) => ({ candidate, exists: await blobExists(candidate) }))
    );
    const found = existence.find((entry) => entry.exists);
    if (found) return found.candidate;

    // Fallback: even if existence could not be confirmed, use the best candidate
    // so the answer can still offer a PDF link. The browser will 404 if it is wrong.
    return candidates[0] || null;
  } catch (error) {
    console.error('Error building TOC PDF blob name:', error);
    return null;
  }
}
