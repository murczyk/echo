/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './devices-page-element';

vi.mock('./routes/devices', () => ({
  DevicesPage: ({ authUserRoles }: { authUserRoles: string[] }) => (
    <div data-testid="devices-page-roles">{authUserRoles.join(',')}</div>
  ),
}));

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
});

describe('devices-page custom element', () => {
  it('rerenders when its role attribute changes', async () => {
    const element = document.createElement('devices-page');
    element.setAttribute('data-auth-user-roles', 'Cyber');
    await act(async () => {
      document.body.appendChild(element);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Cyber');

    await act(async () => {
      element.setAttribute('data-auth-user-roles', 'DeviceSource, DeviceAnalyst');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('DeviceSource,DeviceAnalyst');
  });
});
