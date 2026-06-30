import mammoth from 'mammoth';

type DocxPreviewRequest = {
  requestId: string;
  request: {
    buffer: ArrayBuffer;
  };
};

type DocxPreviewResponse = {
  requestId: string;
  ok: boolean;
  value?: { html: string };
  error?: string;
};

self.addEventListener('message', async (event: MessageEvent<DocxPreviewRequest>) => {
  const { requestId, request } = event.data;

  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: request.buffer });
    const response: DocxPreviewResponse = { requestId, ok: true, value: { html: result.value } };
    self.postMessage(response);
  } catch (error) {
    const response: DocxPreviewResponse = {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'DOCX conversion failed',
    };
    self.postMessage(response);
  }
});

