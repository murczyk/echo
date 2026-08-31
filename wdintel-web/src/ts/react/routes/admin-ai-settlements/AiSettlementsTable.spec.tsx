/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AiSettlementEngineItem,
  AiSettlementParseResultItem,
  AiSettlementTestMessageItem,
} from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../../copy-to-clipboard', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AiSettlementsTable } from './AiSettlementsTable';

const messageId = '019817d8-3b12-7ac8-aac3-75a87ec1b72f';
const engines: AiSettlementEngineItem[] = [
  { id: 'engine-a', name: 'Engine A', modelName: 'model-a' },
  { id: 'engine-b', name: 'Engine B', modelName: 'model-b' },
];
const savedResult: AiSettlementParseResultItem = {
  testMessageId: messageId,
  aiEngineId: 'engine-a',
  settlements: ['АРТІЛЬНЕ'],
  error: null,
  responseText: '{"settlements":["АРТІЛЬНЕ"]}',
  updatedAt: 1,
};
const testResult: AiSettlementParseResultItem = {
  testMessageId: messageId,
  aiEngineId: 'engine-b',
  settlements: ['ШЕВ’ЯКІВКА'],
  error: null,
  responseText: '{"settlements":["ШЕВ’ЯКІВКА"]}',
  updatedAt: null,
};
const messages: AiSettlementTestMessageItem[] = [
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
  mocks.notify.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AiSettlementsTable', () => {
  it('renders saved and temporary results in one column per selected engine', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <AiSettlementsTable
          engines={engines}
          messages={messages}
          testResults={[testResult]}
          onCreate={() => undefined}
          onDelete={() => undefined}
          onEdit={() => undefined}
        />,
      ),
    );

    expect(container.textContent).toContain('model-a: Населені пункти');
    expect(container.textContent).toContain('model-b: Населені пункти');
    expect(container.textContent).toContain('АРТІЛЬНЕ');
    expect(container.textContent).toContain('ШЕВ’ЯКІВКА');
    expect(container.textContent).toContain('ТЕСТ:');

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Дії"]')?.click(),
    );
    await act(async () =>
      Array.from(document.querySelectorAll('[role="menuitem"]'))
        .find((item) => item.textContent?.includes('Копіювати UUID'))
        ?.click(),
    );
    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(messageId);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'UUID скопійовано.',
    });

    await act(async () => root.unmount());
  });
});
