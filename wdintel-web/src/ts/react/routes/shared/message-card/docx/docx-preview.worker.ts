import mammoth from 'mammoth';

import { readDocxPageSize } from './read-docx-page-size';
import type { DocxPreviewResult } from './docx-preview.types';

type DocxPreviewRequest = {
  requestId: string;
  request: {
    buffer: ArrayBuffer;
  };
};

type DocxPreviewResponse = {
  requestId: string;
  ok: boolean;
  value?: DocxPreviewResult;
  error?: string;
};

self.addEventListener('message', async (event: MessageEvent<DocxPreviewRequest>) => {
  const { requestId, request } = event.data;

  try {
    const pageSize = readDocxPageSize(request.buffer);
    const result = await mammoth.convertToHtml({ arrayBuffer: request.buffer });
    const response: DocxPreviewResponse = {
      requestId,
      ok: true,
      value: { html: result.value, pageSize },
    };
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
