import { Router, Request, Response } from 'express';
import { appendChatLogEntry } from '../services/chatLogBlob';
import { runResponseAgent } from '../services/responseAgent';
import { ChatRequest } from '../types';
import { FINAL_ANSWER_REASONING_EFFORT, FAST_REASONING_EFFORT } from '../services/openai';

const router = Router();

function extractDocumentNumbers(request: ChatRequest): string[] {
  if (request.selectedDocuments && request.selectedDocuments.length > 0) {
    return request.selectedDocuments.map((d) => d.documentNumber);
  }
  return request.selectedPdfs || [];
}

/** Non-streaming chat (legacy clients). Runs the full agent then returns JSON. */
router.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const request: ChatRequest = req.body;
    const selectedDocumentNumbers = extractDocumentNumbers(request);

    if (!request.query || selectedDocumentNumbers.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: query, selectedPdfs or selectedDocuments',
      });
    }

    const mode = request.mode === 'fast' ? 'fast' : 'thinking';
    const result = await runResponseAgent({
      query: request.query,
      mode,
      selectedDocuments: request.selectedDocuments || [],
      selectedDocumentNumbers,
      chatHistory: request.chatHistory || [],
      chatSessionId: request.chatSessionId,
      userEmail: request.userEmail,
      conversationId: request.conversationId,
      previousResponseId: request.previousResponseId,
    });

    res.json({
      answer: result.answer,
      thinkingSteps: result.thinkingSteps,
      imageUrls: result.imageUrls,
      pdfUrls: result.pdfUrls,
      followupQuestions: [],
      tokenUsage: result.tokenUsage,
      responseId: result.responseId,
      conversationId: result.conversationId,
    });
  } catch (error) {
    console.error('Error processing chat request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** SSE streaming chat — primary frontend path. */
router.post('/api/chat/stream', async (req: Request, res: Response) => {
  const abortController = new AbortController();
  const onClientGone = () => {
    if (!abortController.signal.aborted && !res.writableEnded) {
      console.log('[Chat] client disconnected — aborting agent');
      abortController.abort();
    }
  };
  // Prefer response close: req 'close' can fire when the POST body finishes (false abort).
  res.on('close', onClientGone);

  try {
    const {
      query,
      selectedPdfs: rawPdfs,
      selectedDocuments,
      chatHistory,
      userEmail: rawUserEmail,
      mode: rawMode,
      previousResponseId: rawPreviousResponseId,
      conversationId: rawConversationId,
    } = req.body;

    const chatSessionId =
      typeof req.body?.chatSessionId === 'string' && req.body.chatSessionId.trim()
        ? req.body.chatSessionId.trim()
        : crypto.randomUUID();

    const selectedDocumentNumbers: string[] =
      (selectedDocuments?.length
        ? selectedDocuments.map((d: { documentNumber: string }) => d.documentNumber)
        : rawPdfs) || [];

    const mode = rawMode === 'fast' ? 'fast' : 'thinking';

    console.log(
      `[Chat] stream received: mode=${mode} docs=${selectedDocumentNumbers.length} query="${String(query || '').slice(0, 80)}"`
    );

    if (!query || selectedDocumentNumbers.length === 0) {
      console.log('[Chat] rejected: missing query or selected documents');
      return res.status(400).json({
        error: 'Missing required fields: query, selectedPdfs or selectedDocuments',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket?.setNoDelay?.(true);

    const writeEvent = (event: string, data: unknown) => {
      if (res.writableEnded || abortController.signal.aborted) return;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        const flushFn = (res as { flush?: () => void }).flush;
        if (typeof flushFn === 'function') flushFn.call(res);
      } catch {
        // Client likely gone
        if (!abortController.signal.aborted) abortController.abort();
      }
    };

    const answerEffort = mode === 'fast' ? FAST_REASONING_EFFORT : FINAL_ANSWER_REASONING_EFFORT;

    writeEvent('meta', {
      thinkingSteps: [
        {
          title: 'Agent thinking',
          description: mode === 'fast' ? 'Starting Fast agent…' : 'Starting Thinking agent…',
          status: 'pending',
          timestamp: new Date().toISOString(),
          reasoningEffort: answerEffort,
        },
      ],
      imageUrls: [],
      pdfUrls: [],
      followupQuestions: [],
      answerReasoningEffort: answerEffort,
    });

    const result = await runResponseAgent({
      query,
      mode,
      selectedDocuments: selectedDocuments || [],
      selectedDocumentNumbers,
      chatHistory: chatHistory || [],
      chatSessionId,
      userEmail: typeof rawUserEmail === 'string' ? rawUserEmail : undefined,
      conversationId:
        typeof rawConversationId === 'string' && rawConversationId.trim()
          ? rawConversationId.trim()
          : undefined,
      previousResponseId:
        typeof rawPreviousResponseId === 'string' && rawPreviousResponseId.trim()
          ? rawPreviousResponseId.trim()
          : undefined,
      signal: abortController.signal,
      hooks: {
        onSteps: (steps) => writeEvent('steps', { steps }),
        onToolStart: (payload) => writeEvent('tool_start', payload),
        onToolDone: (payload) => writeEvent('tool_done', payload),
        onAgentStatus: (status) => writeEvent('agent_status', { status }),
        onChunk: (chunk) => {
          if (chunk) writeEvent('chunk', { text: chunk });
        },
        onReasoningSummary: (payload) => {
          writeEvent('reasoning_summary', {
            active: Boolean(payload?.active),
            text: payload?.text ?? null,
          });
        },
        onModelFirstToken: (msFromAnswerStart) => {
          writeEvent('timing', { modelFirstTokenMs: msFromAnswerStart });
        },
        onHoldChange: (holding) => {
          writeEvent('stream_status', { holding });
        },
      },
    });

    if (result.aborted) {
      console.log(
        `[Chat] agent aborted conversation=${result.conversationId || '-'} response=${result.responseId || '-'}`
      );
      writeEvent('meta', {
        thinkingSteps: result.thinkingSteps,
        imageUrls: result.imageUrls,
        pdfUrls: result.pdfUrls,
        followupQuestions: [],
        answerReasoningEffort: answerEffort,
        tokenUsage: result.tokenUsage,
        responseId: result.responseId,
        conversationId: result.conversationId,
        aborted: true,
      });
      if (result.answer) {
        writeEvent('final', { text: result.answer });
      }
      writeEvent('done', {
        ok: false,
        aborted: true,
        conversationId: result.conversationId,
        responseId: result.responseId,
      });
      if (!res.writableEnded) res.end();
      return;
    }

    writeEvent('meta', {
      thinkingSteps: result.thinkingSteps,
      imageUrls: result.imageUrls,
      pdfUrls: result.pdfUrls,
      followupQuestions: [],
      answerReasoningEffort: answerEffort,
      tokenUsage: result.tokenUsage,
      responseId: result.responseId,
      conversationId: result.conversationId,
      gptCallLogPath: result.gptCallLogPath || null,
    });
    if (result.gptCallLogPath) {
      console.log(`[Chat] gpt call log: ${result.gptCallLogPath}`);
    }

    if (result.answer) {
      writeEvent('final', { text: result.answer });
    }

    const userEmail = typeof rawUserEmail === 'string' ? rawUserEmail.trim() : '';
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
    if (!res.writableEnded) res.end();
  } catch (error) {
    console.error('Error streaming chat response:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      try {
        if (!res.writableEnded) {
          res.write(`event: done\n`);
          res.write(
            `data: ${JSON.stringify({ ok: false, error: (error as Error).message })}\n\n`
          );
          res.end();
        }
      } catch {
        // ignore
      }
    }
  } finally {
    res.off('close', onClientGone);
  }
});

export default router;
