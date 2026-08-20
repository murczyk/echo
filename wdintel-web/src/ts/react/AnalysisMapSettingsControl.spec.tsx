/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnalysisMapSettingsControl } from './AnalysisMapSettingsControl';

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = '';
});

async function renderControl(canShowSettlements: boolean) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const onShowSettlementsChange = vi.fn();
  await act(async () => {
    root.render(
      <AnalysisMapSettingsControl
        visible
        forceCollapsed={false}
        onVisibleChange={vi.fn()}
        canShowSettlements={canShowSettlements}
        showSettlements={false}
        onShowSettlementsChange={onShowSettlementsChange}
      />,
    );
  });
  await act(async () => {
    (host.querySelector('button[aria-label="Налаштування мапи"]') as HTMLButtonElement).click();
  });
  return { host, onShowSettlementsChange };
}

describe('AnalysisMapSettingsControl', () => {
  it('shows the settlement checkbox only to admins and keeps it off by default', async () => {
    const admin = await renderControl(true);
    expect(admin.host.textContent).toContain('Показувати населені пункти');
    const checkbox = Array.from(admin.host.querySelectorAll('input[type="checkbox"]')).at(-1);
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    const regular = await renderControl(false);
    expect(regular.host.textContent).not.toContain('Показувати населені пункти');
  });

  it('emits the enabled state for an admin', async () => {
    const { host, onShowSettlementsChange } = await renderControl(true);
    const checkbox = Array.from(host.querySelectorAll('input[type="checkbox"]')).at(-1);
    await act(async () => {
      (checkbox as HTMLInputElement).click();
    });
    expect(onShowSettlementsChange).toHaveBeenCalledWith(true);
  });
});
