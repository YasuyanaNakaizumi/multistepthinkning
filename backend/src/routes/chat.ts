import { Router, Request, Response } from 'express';
import { MultiStepReasoningService } from '../services/multiStepReasoning';
import { appendChatLogEntry } from '../services/chatLogBlob';
import { MultiStepReasoningRequest } from '../types';

const router = Router();

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

    const reasoningService = new MultiStepReasoningService();
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
    const { query, selectedPdfs: rawPdfs, selectedDocuments, chatHistory, userEmail: rawUserEmail, mode: rawMode } = req.body;
    const chatSessionId = typeof req.body?.chatSessionId === 'string' && req.body.chatSessionId.trim()
      ? req.body.chatSessionId.trim()
      : crypto.randomUUID();
    const selectedPdfs: string[] =
      (selectedDocuments?.length
        ? selectedDocuments.map((d: any) => d.documentNumber)
        : rawPdfs) || [];
    const mode = rawMode === 'fast' ? 'fast' : 'thinking';

    console.log(
      `[Chat] stream received: mode=${mode} docs=${selectedPdfs.length} query="${String(query || '').slice(0, 80)}"`
    );

    if (!query || selectedPdfs.length === 0) {
      console.log('[Chat] rejected: missing query or selected documents');
      return res.status(400).json({ error: 'Missing required fields: query, selectedPdfs or selectedDocuments' });
    }

    // Set headers for SSE streaming (disable proxy/nginx buffering)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket?.setNoDelay?.(true);

    const writeEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      const flushFn = (res as { flush?: () => void }).flush;
      if (typeof flushFn === 'function') flushFn.call(res);
    };

    const reasoningService = new MultiStepReasoningService();
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
      mode,
    };

    const initial = await reasoningService.processRequest(request);
    writeEvent('meta', {
      thinkingSteps: initial.thinkingSteps,
      imageUrls: initial.imageUrls,
      pdfUrls: initial.pdfUrls,
      followupQuestions: initial.followupQuestions,
      answerReasoningEffort: reasoningService.getAnswerReasoningEffort(),
    });

    // Asset token expansion/hold lives only in openai.ts (single buffer).
    // This route forwards displayable text immediately for low UI TTFT.
    const finalAnswer = await reasoningService.streamAnswer(
      query,
      { main: [], connector: [], sub: [] },
      chatHistory || [],
      (chunk: string) => {
        if (chunk) writeEvent('chunk', { text: chunk });
      },
      {
        onModelFirstToken: (msFromAnswerStart) => {
          writeEvent('timing', {
            modelFirstTokenMs: msFromAnswerStart,
          });
        },
        onHoldChange: (holding) => {
          writeEvent('stream_status', { holding });
        },
      }
    );
    if (typeof finalAnswer === 'string' && finalAnswer.length > 0) {
      // Final rewrite may expand residual assets; client applies only if content differs.
      writeEvent('final', { text: finalAnswer });
    }

    const userEmail = typeof request.userEmail === 'string' ? request.userEmail.trim() : '';
    if (userEmail) {
      await appendChatLogEntry({
        userEmail,
        sessionId: chatSessionId,
        query,
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
