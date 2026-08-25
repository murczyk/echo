/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './admin-units-element';

vi.mock('./routes/admin-units', () => ({
  AdminUnitsPage: ({ authUserRoles }: { authUserRoles: string[] }) => (
    <div data-testid="admin-units-roles">{authUserRoles.join(',')}</div>
  ),
}));

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
});

describe('admin-units custom element', () => {
  it('rerenders when its role attribute changes', async () => {
    const element = document.createElement('admin-units');
    await act(async () => {
      document.body.appendChild(element);
      await Promise.resolve();
    });
    expect(document.body.textContent).toBe('');

    await act(async () => {
      element.setAttribute('data-auth-user-roles', 'Rer, UnitsEditor');
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Rer,UnitsEditor');
  });
});
