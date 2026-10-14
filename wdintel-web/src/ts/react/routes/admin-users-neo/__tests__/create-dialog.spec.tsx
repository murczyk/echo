/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Login, Organism, SigintZone } from '../../../../../Bindings';

const mocks = vi.hoisted(() => ({ createLogin: vi.fn(), updateLogin: vi.fn() }));
vi.hoisted(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
});

vi.mock('../../../services/api/logins', () => ({
  createLogin: mocks.createLogin,
  listLogins: vi.fn(),
  updateLogin: mocks.updateLogin,
}));

import { AddUserDialog, EditUserDialog } from '../index';

const lookups = {
  zones: [[1, { id: 1, name: 'Зона' } as SigintZone]] as [number, SigintZone][],
  zonesStatus: 'success' as const,
  zonesError: null,
  organisms: [{ id: 2, name: 'Організм' } as Organism],
  organismsStatus: 'success' as const,
  organismsError: null,
};

function createdLogin(): Login {
  return {
    id: 'created',
    login: 'local-login',
    roles: ['Rer'],
    createdAt: 0,
    deleted: false,
    sigintZoneId: 1,
    sigintZoneName: 'Зона',
    organismId: 2,
    organismName: 'Організм',
    organismEnabled: true,
    deltaLogin: 'delta-login',
    lastActiveAt: null,
    deactivationReason: null,
    description: null,
    passwordAuthEnabled: true,
    hasPassword: true,
    totpEnabled: false,
  };
}

function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = Array.from(document.querySelectorAll('label')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const element = labelElement?.htmlFor ? document.getElementById(labelElement.htmlFor) : undefined;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AddUserDialog', () => {
  beforeEach(() => {
    mocks.createLogin.mockReset();
    mocks.updateLogin.mockReset();
  });
  afterEach(() => document.body.replaceChildren());

  it('creates a dual-method account with separate local and Delta logins in one request', async () => {
    mocks.createLogin.mockResolvedValue(createdLogin());
    const onUserCreated = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AddUserDialog open onClose={vi.fn()} onUserCreated={onUserCreated} lookups={lookups} />,
      );
    });

    await act(async () => {
      change(input('Логін'), 'local-login');
      change(input('Delta логін'), 'delta-login');
      const passwordSwitch = Array.from(document.querySelectorAll('input')).find(
        (candidate) => candidate.type === 'checkbox',
      );
      passwordSwitch?.click();
    });
    await act(async () => change(input('Пароль'), 'secret'));
    const createButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Додати',
    );
    if (!(createButton instanceof HTMLButtonElement)) throw new Error('missing create action');
    await act(async () => createButton.click());

    expect(mocks.createLogin).toHaveBeenCalledTimes(1);
    expect(mocks.createLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        login: 'local-login',
        deltaLogin: 'delta-login',
        password: 'secret',
        passwordAuthEnabled: true,
      }),
    );
    expect(onUserCreated).toHaveBeenCalledWith(createdLogin());
    act(() => root.unmount());
  });

  it('keeps an inactivity-deactivated account state unchanged during an ordinary edit', async () => {
    const inactive = {
      ...createdLogin(),
      deleted: true,
      deactivationReason: 'Inactive' as const,
      passwordAuthEnabled: false,
      hasPassword: false,
      deltaLogin: 'delta-login',
    };
    mocks.updateLogin.mockResolvedValue(inactive);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <EditUserDialog
          open
          login={inactive}
          onClose={vi.fn()}
          onUserUpdated={vi.fn()}
          lookups={lookups}
        />,
      );
    });
    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Зберегти',
    );
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error('missing save action');
    await act(async () => saveButton.click());

    expect(mocks.updateLogin).toHaveBeenCalledWith(
      expect.not.objectContaining({
        deleted: expect.anything(),
        deactivationReason: expect.anything(),
      }),
    );
    act(() => root.unmount());
  });

  it('allows an ordinary edit of a legacy active account without a sign-in method', async () => {
    const legacy = {
      ...createdLogin(),
      passwordAuthEnabled: false,
      hasPassword: false,
      deltaLogin: null,
      description: 'до',
    };
    mocks.updateLogin.mockResolvedValue(legacy);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <EditUserDialog
          open
          login={legacy}
          onClose={vi.fn()}
          onUserUpdated={vi.fn()}
          lookups={lookups}
        />,
      );
    });
    await act(async () => change(input('Нотатка'), 'після'));
    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Зберегти',
    );
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error('missing save action');
    await act(async () => saveButton.click());

    expect(mocks.updateLogin).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'після' }),
    );
    act(() => root.unmount());
  });

  it('shows and clears password validation errors when enabling password authentication', async () => {
    const deltaOnly = {
      ...createdLogin(),
      passwordAuthEnabled: false,
      hasPassword: false,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <EditUserDialog
          open
          login={deltaOnly}
          onClose={vi.fn()}
          onUserUpdated={vi.fn()}
          lookups={lookups}
        />,
      );
    });
    const passwordSwitch = Array.from(document.querySelectorAll('input')).find(
      (candidate) => candidate.type === 'checkbox',
    );
    await act(async () => passwordSwitch?.click());
    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Зберегти',
    );
    if (!(saveButton instanceof HTMLButtonElement)) throw new Error('missing save action');
    await act(async () => saveButton.click());

    expect(mocks.updateLogin).not.toHaveBeenCalled();
    expect(input('Новий пароль').getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('Для входу за паролем вкажіть пароль');

    await act(async () => change(input('Новий пароль'), '   '));
    await act(async () => saveButton.click());
    expect(document.body.textContent).toContain(
      'Пароль не може бути пустим або складатися лише з пробілів',
    );

    mocks.updateLogin.mockResolvedValue({
      ...deltaOnly,
      passwordAuthEnabled: true,
      hasPassword: true,
    });
    await act(async () => change(input('Новий пароль'), 'valid password'));
    expect(document.body.textContent).toContain('Залиште порожнім, щоб не змінювати');
    await act(async () => saveButton.click());
    expect(mocks.updateLogin).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
