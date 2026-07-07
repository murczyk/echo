/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  await import('./device-details-page-element');
});

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
});

async function mount(element: HTMLElement) {
  await act(async () => {
    document.body.appendChild(element);
    await Promise.resolve();
  });
}

describe('device-details-page custom element', () => {
  it('renders a visible error for missing or invalid device UUID', async () => {
    const missingId = document.createElement('device-details-page');
    await mount(missingId);
    expect(document.body.textContent).toContain('Некоректний ID пристрою.');

    const invalidId = document.createElement('device-details-page');
    invalidId.setAttribute('device-id', 'not-a-uuid');
    await mount(invalidId);
    expect(document.body.textContent).toContain('Некоректний ID пристрою.');
  });

  it('trims and accepts UUID device IDs', async () => {
    const element = document.createElement('device-details-page');
    element.setAttribute('device-id', ' 018f0000-0000-7000-8000-000000000000 ');
    element.setAttribute('data-auth-user-roles', 'DevicesEditor');

    await mount(element);

    expect(document.body.textContent).not.toContain('Некоректний ID пристрою.');
    expect(document.body.querySelector('[data-device-id]')?.getAttribute('data-device-id')).toBe(
      '018f0000-0000-7000-8000-000000000000',
    );
  });
});
