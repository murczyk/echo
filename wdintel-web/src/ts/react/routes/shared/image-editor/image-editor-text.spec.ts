import { describe, expect, it } from 'vitest';

import { assignImageEditorTextareaContainer } from './image-editor-text';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor textarea container', () => {
  it('assigns the dialog-local container to IText', () => {
    const container = {} as HTMLElement;
    const text = {} as import('fabric').IText;

    assignImageEditorTextareaContainer(text, container);

    expect(text.hiddenTextareaContainer).toBe(container);
  });
});
