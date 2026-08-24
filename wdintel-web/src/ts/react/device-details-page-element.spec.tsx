/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './device-details-page-element';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const SECOND_DEVICE_ID = '018f0000-0000-7000-8000-000000000001';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/device/detail') {
        return jsonResponse({
          id: DEVICE_ID,
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
      if (url === '/api/device/files/roots') {
        return jsonResponse({ roots: [] });
      }
      if (url === '/api/device/analytics/tags') {
        return jsonResponse({ tags: [] });
      }
      if (url === '/api/device/analytics/summary') {
        return jsonResponse({ total_file_count: 0, analyzed_file_count: 0, items: [] });
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

  it('updates sync capability when roles change', async () => {
    const element = document.createElement('device-details-page');
    element.setAttribute('device-id', DEVICE_ID);
    element.setAttribute('data-auth-user-roles', 'DeviceSource');
    await mount(element);

    const filesTab = Array.from(document.body.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (tab) => tab.textContent === 'Файли',
    );
    expect(filesTab).toBeDefined();
    await act(async () => {
      filesTab?.click();
      await Promise.resolve();
    });

    expect(
      Array.from(document.body.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Синхронізувати'),
      ),
    ).toBe(true);

    await act(async () => {
      element.setAttribute('data-auth-user-roles', 'Basic');
      await Promise.resolve();
    });

    expect(
      Array.from(document.body.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Синхронізувати'),
      ),
    ).toBe(false);

    await act(async () => {
      element.setAttribute('data-auth-user-roles', 'Cyber');
      await Promise.resolve();
    });

    expect(
      Array.from(document.body.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Синхронізувати'),
      ),
    ).toBe(true);
  });

  // @test-scope safeguard: prevents a stale device detail response from replacing the newly selected device
  it('ignores stale detail responses after the device-id attribute changes', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/device/files/roots') return jsonResponse({ roots: [] });
        const body = JSON.parse(String(init?.body)) as { device_id: string };
        return body.device_id === DEVICE_ID ? firstResponse : secondResponse;
      }),
    );

    const element = document.createElement('device-details-page');
    element.setAttribute('device-id', DEVICE_ID);
    element.setAttribute('data-auth-user-roles', 'Cyber');
    await mount(element);
    await act(async () => {
      element.setAttribute('device-id', SECOND_DEVICE_ID);
      await Promise.resolve();
    });

    resolveSecond(
      jsonResponse({
        id: SECOND_DEVICE_ID,
        name: 'Second device',
        aors: [],
        unit: null,
        external_url: null,
        custom_fields: {},
        created_by: 'operator',
        archived: false,
        archived_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      }),
    );
    await act(async () => {
      await secondResponse;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Second device');

    resolveFirst(
      jsonResponse({
        id: DEVICE_ID,
        name: 'Stale first device',
        aors: [],
        unit: null,
        external_url: null,
        custom_fields: {},
        created_by: 'operator',
        archived: false,
        archived_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      }),
    );
    await act(async () => {
      await firstResponse;
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Second device');
    expect(document.body.textContent).not.toContain('Stale first device');
  });
});
