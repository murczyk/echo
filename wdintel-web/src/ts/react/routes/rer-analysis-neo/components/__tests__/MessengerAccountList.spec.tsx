/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MessengerAccountAvatar, MessengerAccountList } from '../MessengerAccountList';

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

  it('shows the avatar image, and the initials once the image fails to load', () => {
    act(() =>
      root.render(
        <MessengerAccountAvatar
          account={{
            id: '1',
            name: 'Ivan Petrenko',
            phone: '',
            avatarUrl: '/api/messengers/avatars/a1',
          }}
        />,
      ),
    );
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/messengers/avatars/a1');
    act(() => {
      image.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('IP');
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
