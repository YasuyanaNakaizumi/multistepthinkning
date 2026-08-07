import { Router, Request, Response } from 'express';
import { MultiStepReasoningService } from '../services/multiStepReasoning';
import { appendChatLogEntry } from '../services/chatLogBlob';
import { MultiStepReasoningRequest } from '../types';

const router = Router();
const reasoningService = new MultiStepReasoningService();

// POST /api/chat - Process chat request with multi-step reasoning
function extractDocumentNumbers(request: MultiStepReasoningRequest): string[] {
  if (request.selectedDocuments && request.selectedDocuments.length > 0) {
    return request.selectedDocuments.map((d) => d.documentNumber);
  }
  return request.selectedPdfs || [];
}

router.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const request: MultiStepReasoningRequest = req.body;
    const selectedPdfs = extractDocumentNumbers(request);

    if (!request.query || selectedPdfs.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: query, selectedPdfs or selectedDocuments' });
    }

    // Process the request with the derived document numbers
    const response = await reasoningService.processRequest({
      ...request,
      selectedPdfs,
    });

    // Return initial response with thinking steps
    res.json(response);
  } catch (error) {
    console.error('Error processing chat request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat/stream - Stream the final answer
router.post('/api/chat/stream', async (req: Request, res: Response) => {
  try {
    const { query, selectedPdfs: rawPdfs, selectedDocuments, chatHistory, userEmail: rawUserEmail } = req.body;
    const chatSessionId = typeof req.body?.chatSessionId === 'string' && req.body.chatSessionId.trim()
      ? req.body.chatSessionId.trim()
      : crypto.randomUUID();
    const selectedPdfs: string[] =
      (selectedDocuments?.length
        ? selectedDocuments.map((d: any) => d.documentNumber)
        : rawPdfs) || [];

    if (!query || selectedPdfs.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: query, selectedPdfs or selectedDocuments' });
    }

    // Set headers for SSE streaming
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Stream thinking step updates while processing
    reasoningService.setProgressCallback((steps) => {
      writeEvent('steps', { steps });
    });

    const request: MultiStepReasoningRequest = {
      query,
      selectedPdfs,
      selectedDocuments,
      chatSessionId,
      chatHistory: chatHistory || [],
      userEmail: rawUserEmail,
    };

    const initial = await reasoningService.processRequest(request);
    writeEvent('meta', {
      thinkingSteps: initial.thinkingSteps,
      imageUrls: initial.imageUrls,
      pdfUrls: initial.pdfUrls,
      followupQuestions: initial.followupQuestions,
    });

    // Get the ref link map for SAS replacement (fallback for any residual [shop-N])
    const refLinkMap = reasoningService.getRefLinkMap();

    // Buffer so we can replace [shop-N] tokens that are split across chunks
    let pending = '';
    const flush = (text: string, isFinal: boolean) => {
      pending += text;

      // Replace any complete [shop-N] tokens using the map
      for (const [refId, link] of refLinkMap.entries()) {
        pending = pending.replace(new RegExp(`\\[${refId}\\]`, 'g'), link);
      }

      // Handle [----] placeholder
      pending = pending.replace(/\[----\]/g, '[📄 Document Reference]');

      let emit = pending;
      if (!isFinal) {
        // Keep a tail in buffer if it could be the start of a [shop-N] token
        const holdMatch = pending.match(/\[(?:s(?:h(?:o(?:p(?:-[0-9]*)?)?)?)?)?$/);
        if (holdMatch) {
          const holdIdx = pending.length - holdMatch[0].length;
          emit = pending.slice(0, holdIdx);
          pending = pending.slice(holdIdx);
        } else {
          pending = '';
        }
      } else {
        pending = '';
      }

      if (emit) writeEvent('chunk', { text: emit });
    };

    const finalAnswer = await reasoningService.streamAnswer(
      query,
      { main: [], connector: [], sub: [] },
      chatHistory || [],
      (chunk: string) => flush(chunk, false)
    );
    if (typeof finalAnswer === 'string' && finalAnswer.length > 0) {
      writeEvent('final', { text: finalAnswer });
    }
    flush('', true);

    const userEmail = typeof request.userEmail === 'string' ? request.userEmail.trim() : '';
    if (userEmail) {
      await appendChatLogEntry({
        userEmail,
        sessionId: chatSessionId,
        query,
        answer: finalAnswer,
        thinkingSteps: initial.thinkingSteps,
        followupQuestions: initial.followupQuestions,
        imageUrls: initial.imageUrls,
        pdfUrls: initial.pdfUrls,
        selectedDocuments: selectedDocuments || [],
        chatHistoryLength: (chatHistory || []).length,
        eventType: (chatHistory || []).length === 0 ? 'new_chat' : 'message',
      }).catch((error) => {
        console.warn('Failed to persist chat log entry:', error);
      });
    }

    writeEvent('done', { ok: true });
    reasoningService.setProgressCallback(null);
    res.end();
  } catch (error) {
    console.error('Error streaming chat response:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      try {
        res.write(`event: done\n`);
        res.write(`data: ${JSON.stringify({ ok: false, error: (error as Error).message })}\n\n`);
      } catch {
        // ignore
      }
      res.end();
    }
  }
});

export default router;
