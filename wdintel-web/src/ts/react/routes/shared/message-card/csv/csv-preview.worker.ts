import {
  CsvPreviewError,
  MAX_CSV_FILE_BYTES,
  decodeCsvBytes,
  isUtf16Csv,
  isProbablyBinaryCsv,
  parseCsvText,
} from './csv-preview-utils';

self.addEventListener(
  'message',
  (
    event: MessageEvent<{
      requestId: string;
      request: { buffer: ArrayBuffer; contentType: string | null };
    }>,
  ) => {
    const { requestId, request } = event.data;
    try {
      if (request.buffer.byteLength > MAX_CSV_FILE_BYTES)
        throw new CsvPreviewError('CSV_FILE_TOO_LARGE', 'CSV file is too large');
      const bytes = new Uint8Array(request.buffer);
      if (!isUtf16Csv(bytes, request.contentType) && isProbablyBinaryCsv(bytes))
        throw new CsvPreviewError('CSV_FILE_BINARY', 'CSV file is binary');
      self.postMessage({
        requestId,
        ok: true,
        value: parseCsvText(decodeCsvBytes(bytes, request.contentType)),
      });
    } catch (error) {
      self.postMessage({
        requestId,
        ok: false,
        error: error instanceof CsvPreviewError ? error.code : 'CSV_MALFORMED',
      });
    }
  },
);
