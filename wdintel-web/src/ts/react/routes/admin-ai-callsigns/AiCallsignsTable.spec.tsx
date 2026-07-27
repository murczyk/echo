/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AiCallsignEngineItem,
  AiCallsignParseResultItem,
  AiCallsignTestMessageItem,
} from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('../../../copy-to-clipboard', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

import { AiCallsignsTable } from './AiCallsignsTable';

const messageId = '019817d8-3b12-7ac8-aac3-75a87ec1b72f';
const engines: AiCallsignEngineItem[] = [
  { id: 'engine-a', name: 'Engine A', modelName: 'model-a' },
  { id: 'engine-b', name: 'Engine B', modelName: 'model-b' },
];
const savedResult: AiCallsignParseResultItem = {
  testMessageId: messageId,
  aiEngineId: 'engine-a',
  callsigns: ['alfa'],
  error: null,
  responseText: '{"callsigns":["ALFA"]}',
  updatedAt: 1,
};
const testResult: AiCallsignParseResultItem = {
  testMessageId: messageId,
  aiEngineId: 'engine-b',
  callsigns: ['bravo'],
  error: null,
  responseText: '{"callsigns":["BRAVO"]}',
  updatedAt: null,
};
const messages: AiCallsignTestMessageItem[] = [
  {
    id: messageId,
    message: 'Test message',
    createdAt: 1,
    updatedAt: 1,
    results: [savedResult],
  },
];

beforeEach(() => {
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AiCallsignsTable', () => {
  it('renders one saved and test column for every selected engine', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <AiCallsignsTable
          engines={engines}
          messages={messages}
          testResults={[testResult]}
          onCreate={() => undefined}
          onDelete={() => undefined}
          onEdit={() => undefined}
        />,
      ),
    );

    expect(container.textContent).toContain('Engine A');
    expect(container.textContent).toContain('Engine B');
    expect(container.textContent).toContain('ALFA');
    expect(container.textContent).toContain('BRAVO');
    expect(container.textContent).not.toContain('01981...1b72f');
    expect(container.textContent).not.toContain(messageId);
    expect(
      Array.from(container.querySelectorAll('th')).filter((cell) => cell.textContent === 'Тест'),
    ).toHaveLength(2);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Копіювати UUID"]')?.click(),
    );
    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(messageId);

    await act(async () =>
      root.render(
        <AiCallsignsTable
          engines={[engines[0]]}
          messages={messages}
          testResults={[]}
          onCreate={() => undefined}
          onDelete={() => undefined}
          onEdit={() => undefined}
        />,
      ),
    );
    expect(container.textContent).not.toContain('Engine B');
    await act(async () => root.unmount());
  });
});
