/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessengerAccountList } from '../MessengerAccountList';

describe('MessengerAccountList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not hide accounts for a whitespace-only query', () => {
    act(() =>
      root.render(
        <MessengerAccountList accounts={[{ id: '1', name: 'A', phone: '' }]} query="   " />,
      ),
    );
    expect(container.querySelectorAll('[data-messenger-account-item]')).toHaveLength(1);
  });

  it('finds an account by its notes and ignores accounts that have none', () => {
    const accounts = [
      { id: '1', name: 'Alpha', phone: '', notes: 'Безхатько', internalNotes: null },
      { id: '2', name: 'Bravo', phone: '', notes: null, internalNotes: 'ПІДозрілий' },
      { id: '3', name: 'Charlie', phone: '' },
    ];
    const names = (query: string) => {
      act(() => root.render(<MessengerAccountList accounts={accounts} query={query} />));
      return [...container.querySelectorAll('[data-messenger-account-item] [title]')]
        .map((name) => name.getAttribute('title'))
        .filter((title) => ['Alpha', 'Bravo', 'Charlie'].includes(title ?? ''));
    };

    expect(names('безхат')).toEqual(['Alpha']);
    expect(names('підоз')).toEqual(['Bravo']);
    expect(names('zzz')).toEqual([]);
  });
});
