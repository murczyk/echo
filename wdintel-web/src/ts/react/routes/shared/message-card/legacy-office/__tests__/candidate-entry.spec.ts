import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../vendor/sheetjs/xlsx-0.20.3.mjs', () => ({ read }));

import { buildDocPreview } from '../doc-preview';
import { buildXlsPreview } from '../xls-preview';

describe('legacy Office candidate entry', () => {
  beforeEach(() => {
    read.mockReset();
  });

  it('does not enter SheetJS when CFB preflight rejects the bytes', () => {
    expect(() => buildXlsPreview(new TextEncoder().encode('not an xls').buffer)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not enter the DOC candidate when CFB preflight rejects the bytes', () => {
    const candidateGlobal = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const original = candidateGlobal.__echoLegacyDocToText;
    const model = vi.fn();
    candidateGlobal.__echoLegacyDocToText = Object.assign(() => null, { model });

    try {
      expect(() => buildDocPreview(new TextEncoder().encode('{\\rtf1}').buffer)).toThrow();
      expect(model).not.toHaveBeenCalled();
    } finally {
      candidateGlobal.__echoLegacyDocToText = original;
    }
  });

  it('contains no worker-network, classic-worker, or nested-worker API', async () => {
    const sources = await Promise.all(
      ['doc-preview.worker.ts', 'xls-preview.worker.ts', 'doc-preview.ts', 'xls-preview.ts'].map(
        (name) =>
          readFile(
            resolve(process.cwd(), `src/ts/react/routes/shared/message-card/legacy-office/${name}`),
            'utf8',
          ),
      ),
    );

    for (const source of sources) {
      expect(source).not.toMatch(
        /\b(?:importScripts|fetch|XMLHttpRequest|WebSocket|EventSource)\b/,
      );
      expect(source).not.toMatch(/new\s+Worker\s*\(/);
    }
  });
});
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
