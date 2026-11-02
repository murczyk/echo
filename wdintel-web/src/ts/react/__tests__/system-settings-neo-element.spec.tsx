/** @vitest-environment happy-dom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../routes/admin-system-settings-neo', async () => {
  const { usePowerSnackbar } = await vi.importActual<typeof import('../components/PowerSnackbar')>(
    '../components/PowerSnackbar',
  );
  return {
    AdminSystemSettingsNeoPage: () => {
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

import '../system-settings-neo-element';

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
  window.history.replaceState(null, '', '/admin/system-settings-neo');
});

describe('system-settings-neo custom element', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('provides snackbar context when opening Reports settings directly', async () => {
    window.history.replaceState(null, '', '/admin/system-settings-neo#reports');

    await act(async () => {
      document.body.append(document.createElement('system-settings-neo'));
      await Promise.resolve();
    });

    expect(document.querySelector('input[aria-label="enable rer report"]')).not.toBeNull();
  });
});
