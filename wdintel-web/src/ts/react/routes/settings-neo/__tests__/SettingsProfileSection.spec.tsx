// @vitest-environment happy-dom
// Regression: https://github.com/echoua/echo/issues/3575
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsProfileSection } from '../SettingsProfileSection';

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(
    async (_url, options) =>
      new Response(
        JSON.stringify(
          options?.method === 'PUT'
            ? {
                id: 'self',
                login: 'actual-login',
                display_name: JSON.parse(options.body).display_name,
                delta_login: null,
              }
            : { id: 'self', name: 'actual-login', display_name: 'Старе ім’я' },
        ),
      ),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function changeName(value: string) {
  const input = host.querySelectorAll('input')[1];
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('saves and clears only the custom name (#3575)', async () => {
  await act(async () => root.render(<SettingsProfileSection />));
  expect(host.querySelector('input')?.readOnly).toBe(true);
  await changeName('Сокіл');
  await act(async () =>
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(fetchMock.mock.calls[1][0]).toBe('/api/user/display-name');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ display_name: 'Сокіл' });
  expect(host.querySelector('input')?.value).toBe('actual-login');
  await changeName('');
  await act(async () =>
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ display_name: null });
});

it('keeps the edited name and exposes a failed save (#3575)', async () => {
  await act(async () => root.render(<SettingsProfileSection />));
  await changeName('Нове ім’я');
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Не вдалося зберегти' }), { status: 500 }),
  );
  await act(async () =>
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(host.querySelectorAll('input')[1].value).toBe('Нове ім’я');
  expect(host.textContent).toContain('Не вдалося зберегти');
  expect(host.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
});
