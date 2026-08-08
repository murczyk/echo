import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import type { ReactNode } from 'react';

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const UTF8_BOM = '\uFEFF';
const UTF16_BE_BOM_BYTES = [0xfe, 0xff] as const;
const UTF16_LE_BOM_BYTES = [0xff, 0xfe] as const;

type ResolvedTextEncoding = {
  decoder: TextDecoder;
  encoding: string;
  bomLength: number;
  skipBinaryHeuristic: boolean;
};

type TextDocumentPreviewProps = {
  href: string;
  kindLabel: 'TXT' | 'Markdown';
  renderText: (text: string) => ReactNode;
  sizeBytes?: number | null;
};

function formatTextPreviewErrorMessage(
  kindLabel: 'TXT' | 'Markdown',
  error: string | null,
): string {
  if (error === 'TEXT_FILE_TOO_LARGE') {
    return `${kindLabel} файл завеликий для попереднього перегляду. Максимум: 1 МБ.`;
  }
  if (error === 'TEXT_FILE_BINARY') {
    return 'Схоже, це не текстовий файл.';
  }
  return error ?? `${kindLabel} недоступний`;
}

function parseCharset(contentType: string | null): string | null {
  if (contentType == null) return null;
  const match = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return match?.[1]?.trim() ?? null;
}

function normalizeCharset(charset: string | null): string | null {
  return (
    charset
      ?.trim()
      .toLowerCase()
      .replaceAll('_', '-')
      .replace(/^utf16/, 'utf-16') ?? null
  );
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function createTextDecoder(encoding: string): TextDecoder | null {
  try {
    return new TextDecoder(encoding);
  } catch {
    return null;
  }
}

function resolveTextEncoding(bytes: Uint8Array, contentType: string | null): ResolvedTextEncoding {
  if (startsWithBytes(bytes, UTF16_LE_BOM_BYTES)) {
    return {
      decoder: new TextDecoder('utf-16le'),
      encoding: 'utf-16le',
      bomLength: 2,
      skipBinaryHeuristic: true,
    };
  }
  if (startsWithBytes(bytes, UTF16_BE_BOM_BYTES)) {
    return {
      decoder: new TextDecoder('utf-16be'),
      encoding: 'utf-16be',
      bomLength: 2,
      skipBinaryHeuristic: true,
    };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      decoder: new TextDecoder('utf-8'),
      encoding: 'utf-8',
      bomLength: 3,
      skipBinaryHeuristic: false,
    };
  }

  const declaredCharset = normalizeCharset(parseCharset(contentType));
  if (declaredCharset === 'utf-16le' || declaredCharset === 'utf-16') {
    return {
      decoder: new TextDecoder('utf-16le'),
      encoding: 'utf-16le',
      bomLength: 0,
      skipBinaryHeuristic: true,
    };
  }
  if (declaredCharset === 'utf-16be') {
    return {
      decoder: new TextDecoder('utf-16be'),
      encoding: declaredCharset,
      bomLength: 0,
      skipBinaryHeuristic: true,
    };
  }
  if (declaredCharset != null) {
    const decoder = createTextDecoder(declaredCharset);
    if (decoder != null) {
      return {
        decoder,
        encoding: declaredCharset,
        bomLength: 0,
        skipBinaryHeuristic: false,
      };
    }
  }

  return {
    decoder: new TextDecoder('utf-8'),
    encoding: 'utf-8',
    bomLength: 0,
    skipBinaryHeuristic: false,
  };
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  let controlCount = 0;
  const sampleLength = Math.min(bytes.length, 4096);

  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlCount += 1;
    }
  }

  return controlCount / sampleLength > 0.3;
}

async function readBoundedTextResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body == null) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throw new Error('TEXT_FILE_TOO_LARGE');
    const bytes = new Uint8Array(arrayBuffer);
    const { decoder, bomLength, skipBinaryHeuristic } = resolveTextEncoding(
      bytes,
      response.headers.get('content-type'),
    );
    if (!skipBinaryHeuristic && isProbablyBinary(bytes.subarray(bomLength))) {
      throw new Error('TEXT_FILE_BINARY');
    }
    const decoded = decoder.decode(bytes.subarray(bomLength));
    return decoded.startsWith(UTF8_BOM) ? decoded.slice(1) : decoded;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;

      totalBytes += value.byteLength;
      chunks.push(value);
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stop of the underlying stream.
        }
        throw new Error('TEXT_FILE_TOO_LARGE');
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const { decoder, bomLength, skipBinaryHeuristic } = resolveTextEncoding(
    bytes,
    response.headers.get('content-type'),
  );
  if (!skipBinaryHeuristic && isProbablyBinary(bytes.subarray(bomLength))) {
    throw new Error('TEXT_FILE_BINARY');
  }
  const decoded = decoder.decode(bytes.subarray(bomLength));
  return decoded.startsWith(UTF8_BOM) ? decoded.slice(1) : decoded;
}

export function isSafeMarkdownHref(href: string): boolean {
  const normalizedHref = href.trim();
  return (
    (normalizedHref.startsWith('/') &&
      !normalizedHref.startsWith('//') &&
      !normalizedHref.startsWith('/\\')) ||
    normalizedHref.startsWith('#') ||
    /^https?:\/\//i.test(normalizedHref) ||
    /^mailto:/i.test(normalizedHref)
  );
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href == null || !isSafeMarkdownHref(href)) {
    return <span>{children}</span>;
  }

  const isExternal = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
  return (
    <a
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownRenderer({ text }: { text: string }) {
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
      img: () => null,
    }),
    [],
  );

  return (
    <ReactMarkdown skipHtml disallowedElements={['img']} components={components}>
      {text}
    </ReactMarkdown>
  );
}

import { fetchCachedDocumentResponse } from './document-preview-utils';

export function TextDocumentPreview({
  href,
  kindLabel,
  renderText,
  sizeBytes,
}: TextDocumentPreviewProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;

    const load = async () => {
      setStatus('loading');
      setText('');
      setError(null);

      try {
        if (sizeBytes != null && sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error('TEXT_FILE_TOO_LARGE');
        }

        const { buffer, contentLength, contentType } = await fetchCachedDocumentResponse(
          href,
          abortController.signal,
        );

        if (contentLength != null && contentLength > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error('TEXT_FILE_TOO_LARGE');
        }

        if (buffer.byteLength > MAX_TEXT_PREVIEW_BYTES) {
          throw new Error('TEXT_FILE_TOO_LARGE');
        }

        const bytes = new Uint8Array(buffer);
        const { decoder, bomLength, skipBinaryHeuristic } = resolveTextEncoding(bytes, contentType);
        if (!skipBinaryHeuristic && isProbablyBinary(bytes.subarray(bomLength))) {
          throw new Error('TEXT_FILE_BINARY');
        }
        const decoded = decoder.decode(bytes.subarray(bomLength));
        const nextText = decoded.startsWith(UTF8_BOM) ? decoded.slice(1) : decoded;
        if (disposed) return;
        setText(nextText);
        setStatus('ready');
      } catch (loadError) {
        if (disposed || abortController.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : null);
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [href, sizeBytes]);

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'text.primary' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {formatTextPreviewErrorMessage(kindLabel, error)}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        overflow: 'auto',
        borderRadius: 1,
        backgroundColor: 'transparent',
      }}
    >
      {status === 'loading' ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {status === 'ready' ? renderText(text) : null}
    </Box>
  );
}

export function TxtDocumentPreview({
  href,
  sizeBytes,
}: {
  href: string;
  sizeBytes?: number | null;
}) {
  return (
    <TextDocumentPreview
      href={href}
      sizeBytes={sizeBytes}
      kindLabel="TXT"
      renderText={(text) => (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 3,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'text.primary',
          }}
        >
          {text}
        </Box>
      )}
    />
  );
}

export function MarkdownDocumentPreview({
  href,
  sizeBytes,
}: {
  href: string;
  sizeBytes?: number | null;
}) {
  return (
    <TextDocumentPreview
      href={href}
      sizeBytes={sizeBytes}
      kindLabel="Markdown"
      renderText={(text) => (
        <Box sx={{ px: 3, py: 2.5, color: 'text.primary', '& > *:first-of-type': { mt: 0 } }}>
          <MarkdownRenderer text={text} />
        </Box>
      )}
    />
  );
}
