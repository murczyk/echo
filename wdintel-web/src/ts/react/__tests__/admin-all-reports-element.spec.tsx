/** @vitest-environment happy-dom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../routes/admin-all-reports', async () => {
  const { usePowerSnackbar } = await vi.importActual<typeof import('../components/PowerSnackbar')>(
    '../components/PowerSnackbar',
  );
  return {
    AdminAllReportsPage: () => {
      usePowerSnackbar();
      return (
        <label>
          <input type="checkbox" aria-label="enable rer report" />
          enable rer report
        </label>
      );
    },
  };
});

import '../admin-all-reports-element';

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
  window.history.replaceState(null, '', '/admin/all-reports');
});

describe('admin-all-reports custom element', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('provides snackbar context when opening the RER report tab directly', async () => {
    window.history.replaceState(null, '', '/admin/all-reports?tab=rer-report');

    await act(async () => {
      document.body.append(document.createElement('admin-all-reports'));
      await Promise.resolve();
    });

    expect(document.querySelector('input[aria-label="enable rer report"]')).not.toBeNull();
  });
});
