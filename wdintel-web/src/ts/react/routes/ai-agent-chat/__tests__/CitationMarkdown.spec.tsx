/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { minimalInboxMessage } from '../../rer-duty-neo/inbox-message-mocks';
import { CitationMarkdown } from '../CitationMarkdown';
import { HttpRequestError } from '../../../services/api/client';

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
  async function render(content: string, references = citations) {
    if (!container) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root.render(<CitationMarkdown citations={references}>{content}</CitationMarkdown>);
    });
  }
  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    container = undefined as unknown as HTMLDivElement;
    document.body.innerHTML = '';
    vi.resetAllMocks();
  });
  it('keeps single newlines in answers as line breaks', async () => {
    await render('5271298, 6684479\n5278075, 6683751\n\n- список');
    const paragraph = container.querySelector('p');
    expect(paragraph?.innerHTML).toBe('5271298, 6684479<br>\n5278075, 6683751');
    expect(container.querySelectorAll('li')).toHaveLength(1);
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
    expect(container.textContent).toContain('Не вдалося завантажити джерело');
    expect(container.textContent).not.toContain('Джерело недоступне');
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

  // Regression: https://github.com/echoua/echo/issues/3757
  it('preserves successful batches and retries only failed citations', async () => {
    const references = Array.from({ length: 201 }, (_, index) => ({
      messageId: index + 1,
      messageIdentifier: `source-${index + 1}`,
    }));
    const content = references
      .map((citation) => `[джерело](/rer-analysis-neo?m=${citation.messageIdentifier})`)
      .join(' ');
    const batchResponse = (ids: number[]) => ({
      ...response(),
      inboxItems: ids.map((id) => [id, response().inboxItems[0][1]]),
    });
    mocks.fetch
      .mockImplementationOnce(async (ids: number[]) => batchResponse(ids))
      .mockRejectedValueOnce(new HttpRequestError(502, 'Bad Gateway'))
      .mockImplementation(async (ids: number[]) => batchResponse(ids));
    await render(content, references);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('a.echo-chip')).toHaveLength(101);
    expect(container.textContent).toContain('Не вдалося завантажити джерело');
    expect(container.textContent).not.toContain('Джерело недоступне');
    await render(`${content}\nMore text.`, references);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    await act(async () => container.querySelector('button')!.click());
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.fetch.mock.calls[3][0]).toEqual(
      references.slice(100, 200).map((citation) => citation.messageId),
    );
    expect(container.querySelectorAll('a.echo-chip')).toHaveLength(201);
    expect(container.querySelector('button')).toBeNull();
  });

  // Regression: https://github.com/echoua/echo/issues/3757
  it('hides stale previews after a failed revalidation and allows retry', async () => {
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new HttpRequestError(502, 'Bad Gateway'))
      .mockResolvedValue(response());
    await render(link);
    await act(async () => {
      container.querySelector('a')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Не вдалося завантажити джерело');
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('a')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  // Regression: https://github.com/echoua/echo/issues/3757
  it.each([403, 404])(
    'keeps HTTP %s sources unavailable without retrying access',
    async (status) => {
      mocks.fetch.mockRejectedValue(new HttpRequestError(status, 'Unavailable'));
      await render(link);
      expect(container.textContent).toContain('Джерело недоступне');
      expect(container.textContent).not.toContain('Не вдалося завантажити джерело');
      expect(container.querySelector('button')).toBeNull();
      expect(mocks.notify).toHaveBeenCalled();
    },
  );
});
