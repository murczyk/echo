// @vitest-environment happy-dom
// #3575: display labels must not merge identities or replace external attribution.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorLabel } from './AuthorLabel';
import { refreshAuthors } from '../author-identities';
import { MessageCardComments } from '../routes/shared/message-card/MessageCardComments';

const firstId = '00000000-0000-0000-0000-000000000001';
const secondId = '00000000-0000-0000-0000-000000000002';
let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(
    new Response(
      JSON.stringify({
        authors: [
          { id: firstId, login: 'first', display_name: 'Сокіл', delta_login: 'delta-first' },
          { id: secondId, login: 'second', display_name: 'Сокіл', delta_login: null },
        ],
      }),
    ),
  );
  refreshAuthors();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('author display names (#3575)', () => {
  it('batches repeated authors and opens the correct identity for duplicate names', async () => {
    await act(async () =>
      root.render(
        <>
          <AuthorLabel login="first" />
          <AuthorLabel login="second" />
          <AuthorLabel login="first" />
        </>,
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      logins: ['first', 'second'],
      ids: [],
    });
    const buttons = host.querySelectorAll('button');
    expect([...buttons].map((button) => button.textContent)).toEqual(['Сокіл', 'Сокіл', 'Сокіл']);
    await act(async () => buttons[0].click());
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.textContent).toContain('delta-first');
    expect(panel?.textContent).toContain('first');
    await act(async () =>
      document
        .querySelector('.MuiPopover-root')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => buttons[1].click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('second');
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('delta-first');
  });

  it('updates mounted authors after saving and restores the login after clearing', async () => {
    await act(async () => root.render(<AuthorLabel login="first" />));
    await act(async () =>
      refreshAuthors({ id: firstId, login: 'first', displayName: 'Нове ім’я', deltaLogin: null }),
    );
    expect(host.textContent).toBe('Нове ім’я');
    await act(async () =>
      refreshAuthors({ id: firstId, login: 'first', displayName: null, deltaLogin: null }),
    );
    expect(host.textContent).toBe('first');
    expect(host.querySelector('button')).toBeNull();
  });

  it('retries failed identity lookups on remount without caching the failure as a miss', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    await act(async () => root.render(<AuthorLabel login="first" />));
    expect(host.textContent).toBe('first');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => root.render(null));
    await act(async () => root.render(<AuthorLabel login="first" />));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector('button')?.textContent).toBe('Сокіл');
  });

  it('keeps successful missing-author lookups cached across remounts', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ authors: [] })));
    await act(async () => root.render(<AuthorLabel login="removed" />));
    await act(async () => root.render(null));
    await act(async () => root.render(<AuthorLabel login="removed" />));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('removed');
  });

  it('preserves post and external sender attribution and unresolved identities', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ authors: [] })));
    await act(async () =>
      root.render(
        <>
          <AuthorLabel accountId={secondId} fallback="Signal Sender" />
          <AuthorLabel login="removed" />
          <MessageCardComments
            signalMessageSenderLabel="External Sender"
            messageComments={[
              { id: 1, messageId: 1, login: 'first', sigintPostName: 'Пост', comment: 'One' },
              { id: 2, messageId: 1, login: 'system', sigintPostName: null, comment: 'Two' },
            ]}
          />
        </>,
      ),
    );
    expect(host.textContent).toContain('Signal Sender');
    expect(host.textContent).toContain('removed');
    expect(host.textContent).toContain('Пост');
    expect(host.textContent).toContain('External Sender');
    expect(host.querySelector('button')).toBeNull();
  });
});
