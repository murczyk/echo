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
          name: 'Device Alpha',
          created_by: 'operator',
          aor_ids: [],
          aor_names: [],
          unit_id: null,
          unit_name: null,
          tags: [],
          external_url: null,
          hostname: null,
          ssh_port: null,
          archived: false,
          created_at_ms: 10,
          updated_at_ms: 20,
          archived_at_ms: null,
        });
      }
      if (url === '/api/device/files/list') {
        return jsonResponse({ list: [], total: 0, has_more: false });
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
    element.setAttribute('data-auth-user-roles', 'DevicesEditor');

    await mount(element);

    expect(document.body.textContent).not.toContain('Некоректний ID пристрою.');
    expect(document.body.querySelector('[data-device-id]')).toBeNull();
  });
});
