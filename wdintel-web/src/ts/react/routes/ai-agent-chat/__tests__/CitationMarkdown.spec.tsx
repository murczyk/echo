/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { minimalInboxMessage } from '../../rer-duty-neo/inbox-message-mocks';
import { CitationMarkdown } from '../CitationMarkdown';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), notify: vi.fn() }));
vi.mock('../../../services/api/inbox-messages', () => ({
  fetchMessagesByIdsWithMetadata: mocks.fetch,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

// Regression: https://github.com/echoua/echo/issues/3064
describe('AI message citations', () => {
  let root: Root;
  let container: HTMLDivElement;
  const citations = [{ messageId: 77, messageIdentifier: 'source-77' }];
  const link = '[джерело](/rer-analysis-neo?m=source-77)';
  function response() {
    return {
      inboxItems: [
        [
          77,
          minimalInboxMessage({
            text: 'Complete body '.repeat(1000),
            date: '2025-09-26',
            time: '11:23',
            timestamp: null,
            groupMasterKey: 'group',
          }),
        ],
      ],
      signalGroups: [{ masterKey: 'group', name: 'Натрій' }],
    };
  }
  async function render(content: string) {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root.render(<CitationMarkdown citations={citations}>{content}</CitationMarkdown>);
    });
  }
  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    container = undefined as unknown as HTMLDivElement;
    document.body.innerHTML = '';
    vi.resetAllMocks();
  });
  it('deduplicates streamed citations, displays authoritative metadata and the full hover body', async () => {
    mocks.fetch.mockResolvedValue(response());
    await render(`Summary ${link.slice(0, -8)}`);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await render(`Summary ${link} and ${link}`);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const anchors = container.querySelectorAll('a.echo-chip');
    expect(anchors).toHaveLength(2);
    expect(anchors[0].textContent).toBe('26.09.2025 11:23 Натрій');
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    await act(async () => {
      anchors[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Complete body '.repeat(1000).trim(),
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await render(`Summary ${link} and ${link}. More text.`);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not resolve invented references or reveal a body after access is revoked', async () => {
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockResolvedValue({ inboxItems: [], signalGroups: [] });
    await render(`${link} [invented](/rer-analysis-neo?m=other)`);
    expect(container.textContent).toContain('Неперевірене джерело');
    const anchor = container.querySelector('a')!;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(container.textContent).toContain('Джерело недоступне');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
  it('retries failed source loading and omits unknown event times', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await render(link);
    expect(mocks.notify).toHaveBeenCalled();
    const data = response();
    Object.assign(data.inboxItems[0][1], {
      isTimeNull: true,
      date: `${new Date().getFullYear()}-09-26`,
    });
    mocks.fetch.mockResolvedValue(data);
    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(container.querySelector('a')?.textContent).toBe('26.09 Натрій');
  });
});
