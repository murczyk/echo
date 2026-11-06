/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessengerWorkspace } from '../MessengerWorkspace';

describe('MessengerWorkspace', () => {
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

  it('has content only once an account is chosen', () => {
    act(() => root.render(<MessengerWorkspace account={null} />));
    expect(container.querySelector('[data-messenger-workspace]')).toBeNull();
    expect(container.textContent).toContain('Акаунт не обрано');

    act(() =>
      root.render(
        <MessengerWorkspace account={{ id: '1', name: 'name test', phone: '+10000000000' }} />,
      ),
    );
    expect(container.querySelector('[data-messenger-workspace-empty]')).toBeNull();
    expect(container.textContent).toContain('name test');
  });

  it('shows both ids and reports a click on the external id', () => {
    const onExternalIdClick = vi.fn();
    const account = {
      id: '1',
      name: 'name test',
      phone: '+10000000000',
      userId: 'user id test',
      externalId: 'external id test',
    };
    act(() =>
      root.render(<MessengerWorkspace account={account} onExternalIdClick={onExternalIdClick} />),
    );
    expect(container.querySelector('[data-messenger-user-id]')?.textContent).toContain(
      'user id test',
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-messenger-external-id]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onExternalIdClick).toHaveBeenCalledWith(account);
  });

  it('does not carry an unsaved internal note draft over to another account', () => {
    const onSaveInternalNotes = vi.fn();
    const render = (id: string) =>
      act(() =>
        root.render(
          <MessengerWorkspace
            account={{ id, name: `name ${id}`, phone: '', internalNotes: 'saved' }}
            onSaveInternalNotes={onSaveInternalNotes}
          />,
        ),
      );

    render('1');
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Редагувати"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container.querySelector('textarea')).not.toBeNull();

    render('2');
    expect(container.querySelector('textarea')).toBeNull();
  });
});
