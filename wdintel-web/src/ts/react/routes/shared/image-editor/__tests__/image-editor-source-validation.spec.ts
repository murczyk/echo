/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';

import {
  IMAGE_EDITOR_ANIMATED_PNG_ERROR,
  IMAGE_EDITOR_DIMENSIONS_TOO_LARGE_ERROR,
  IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR,
  MAX_IMAGE_EDITOR_SIDE,
  MAX_IMAGE_EDITOR_SOURCE_BYTES,
  readBoundedImageEditorResponse,
  validateImageEditorSource,
} from '../image-editor-source-validation';

function pngChunk(type: string, data: number[] = []) {
  const bytes = new Uint8Array(12 + data.length);
  new DataView(bytes.buffer).setUint32(0, data.length);
  bytes.set(
    Array.from(type).map((value) => value.charCodeAt(0)),
    4,
  );
  bytes.set(data, 8);
  return bytes;
}

function png(width: number, height: number, beforeIdat: Uint8Array[] = []) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...pngChunk('IHDR', Array.from(ihdr)),
    ...beforeIdat.flatMap((chunk) => Array.from(chunk)),
    ...pngChunk('IDAT'),
    ...pngChunk('IEND'),
  ]);
}

function source(bytes: Uint8Array) {
  return { blob: new Blob([bytes]), fileName: 'image', mimeType: 'image/png' };
}

function jpeg() {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xc0, 0, 8, 8, 0, 3, 0, 4, 1, 0xff, 0xd9,
  ]);
}

function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', data: number[]) {
  const bytes = new Uint8Array(20 + data.length + (data.length % 2));
  bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], 0);
  bytes.set(
    Array.from(kind).map((value) => value.charCodeAt(0)),
    12,
  );
  new DataView(bytes.buffer).setUint32(16, data.length, true);
  bytes.set(data, 20);
  return bytes;
}

// @test-scope regression: https://github.com/echoua/echo/issues/3294
describe('image editor bounded source validation #3294', () => {
  it('parses valid PNG and JPEG dimensions and rejects oversized declarations', async () => {
    await expect(validateImageEditorSource(source(png(6000, 4000)))).resolves.toMatchObject({
      format: 'png',
      width: 6000,
      height: 4000,
    });
    await expect(validateImageEditorSource(source(jpeg()))).resolves.toMatchObject({
      format: 'jpeg',
      width: 4,
      height: 3,
    });
    await expect(
      validateImageEditorSource(source(png(MAX_IMAGE_EDITOR_SIDE + 1, 1))),
    ).rejects.toThrow(IMAGE_EDITOR_DIMENSIONS_TOO_LARGE_ERROR);
    await expect(validateImageEditorSource(source(png(6001, 4000)))).rejects.toThrow(
      IMAGE_EDITOR_DIMENSIONS_TOO_LARGE_ERROR,
    );
    await expect(validateImageEditorSource(source(png(6000, 4000)))).resolves.toMatchObject({
      width: 6000,
      height: 4000,
    });
  });

  it('rejects APNG chunks but not acTL bytes in ancillary payloads', async () => {
    await expect(validateImageEditorSource(source(png(4, 3, [pngChunk('acTL')])))).rejects.toThrow(
      IMAGE_EDITOR_ANIMATED_PNG_ERROR,
    );
    await expect(
      validateImageEditorSource(source(png(4, 3, [pngChunk('tEXt', [97, 99, 84, 76])]))),
    ).resolves.toMatchObject({ format: 'png', width: 4, height: 3 });
  });

  it('rejects malformed JPEG segments and parses static WebP variants', async () => {
    await expect(
      validateImageEditorSource(source(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 20]))),
    ).rejects.toThrow();
    await expect(
      validateImageEditorSource(source(webp('VP8X', [0, 0, 0, 0, 3, 0, 0, 2, 0, 0]))),
    ).resolves.toMatchObject({ format: 'webp', width: 4, height: 3 });
    await expect(
      validateImageEditorSource(source(webp('VP8 ', [0, 0, 0, 0x9d, 1, 0x2a, 4, 0, 3, 0]))),
    ).resolves.toMatchObject({ format: 'webp', width: 4, height: 3 });
    await expect(
      validateImageEditorSource(source(webp('VP8L', [0x2f, 3, 0, 0x80, 0]))),
    ).resolves.toMatchObject({ format: 'webp' });
    await expect(
      validateImageEditorSource(source(webp('VP8X', [2, 0, 0, 0, 3, 0, 0, 2, 0, 0]))),
    ).rejects.toThrow('Анімовані WebP');
  });

  it('bounds streamed responses even without an honest content length', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_IMAGE_EDITOR_SOURCE_BYTES + 1));
        },
        cancel,
      }),
    );
    await expect(readBoundedImageEditorResponse(response)).rejects.toThrow(
      IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR,
    );
    expect(cancel).toHaveBeenCalled();
    const bounded = await readBoundedImageEditorResponse(
      new Response(new Blob(['ok'], { type: 'image/png' })),
    );
    expect(await bounded.text()).toBe('ok');
  });
});
