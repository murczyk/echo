/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeAll(async () => {
  await import('./device-details-page-element');
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/device/detail') {
        return jsonResponse({
          id: DEVICE_ID,
          source_label: 'Source device',
          name: 'Device Alpha',
          aors: [],
          unit: null,
          external_url: null,
          custom_fields: {},
          created_by: 'operator',
          archived: false,
          archived_at: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
  vi.unstubAllGlobals();
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
    element.setAttribute('device-id', ` ${DEVICE_ID} `);
    element.setAttribute('data-auth-user-roles', 'DeviceSource');

    await mount(element);

    expect(document.body.textContent).not.toContain('Некоректний ID пристрою.');
    expect(document.body.querySelector('[data-device-id]')).toBeNull();
  });
});
