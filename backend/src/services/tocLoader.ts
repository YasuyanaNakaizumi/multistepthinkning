import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

export interface TocDocument {
  documentNumber: string;
  documentTitle: string;
}

export function loadDocumentsCatalog(): TocDocument[] {
  try {
    const filePath = config.documentsJsonPath;
    if (!fs.existsSync(filePath)) {
      console.warn(`Documents catalog not found at ${filePath}`);
      return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const catalog = JSON.parse(content) as TocDocument[];
    return catalog;
  } catch (error) {
    console.error('Error loading documents catalog:', error);
    return [];
  }
}

export function loadTOCMarkdown(documentNumbers: string[]): string {
  try {
    const tocDir = config.tocDir;
    
    if (!fs.existsSync(tocDir)) {
      console.warn(`TOC directory not found at ${tocDir}`);
      return '';
    }
    
    let tocContent = '';
    
    // Determine which files to read
    let filesToRead: string[] = [];
    
    if (documentNumbers.length === 0 || documentNumbers.includes('All Documents')) {
      // Read all .md files
      filesToRead = fs.readdirSync(tocDir)
        .filter(file => file.endsWith('.md'))
        .map(file => path.join(tocDir, file));
    } else {
      // Read specific document files
      for (const docNum of documentNumbers) {
        const filePath = path.join(tocDir, `${docNum}.md`);
        if (fs.existsSync(filePath)) {
          filesToRead.push(filePath);
        }
      }
    }
    
    // Read and concatenate files
    for (const filePath of filesToRead) {
      const content = fs.readFileSync(filePath, 'utf-8');
      tocContent += content + '\n\n';
    }
    
    return tocContent;
  } catch (error) {
    console.error('Error loading TOC markdown:', error);
    return '';
  }
}

export function flattenImageExplanations(imageContent: string): any[] {
  try {
    if (!imageContent) return [];

    // Azure Search may return this field as:
    // - JSON string
    // - already-parsed object/array (depending on pipeline)
    // - a non-JSON string like "[object Object]"
    const anyValue = imageContent as unknown as any;
    if (Array.isArray(anyValue)) return anyValue;
    if (typeof anyValue === 'object' && anyValue !== null) return [anyValue];

    const text = String(anyValue).trim();
    if (!text || text === '[object Object]') return [];

    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object' && parsed !== null) return [parsed];
    return [];
  } catch (error) {
    return [];
  }
}
