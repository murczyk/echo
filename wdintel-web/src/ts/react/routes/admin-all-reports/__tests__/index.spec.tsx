/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/browser', () => ({ navigateWithinSpa: navigate }));
vi.mock('../../settings-neo/SettingsMyReportsSection', () => ({
  ReportHistoryTableSection: () => <div>Історія звітів</div>,
}));
import { AdminAllReportsPage } from '..';

afterEach(() => {
  document.body.innerHTML = '';
  navigate.mockReset();
});

it('#3974 redirects legacy RER settings links and preserves metadata filters', async () => {
  window.history.replaceState({}, '', '/admin/all-reports?tab=rer-report&globalFilter=unit');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminAllReportsPage />));
  expect(navigate).toHaveBeenCalledWith('/admin/system-settings-neo?globalFilter=unit#reports');
  expect(container.querySelector('[role="tab"]')).toBeNull();
  expect(container.textContent).toContain('Історія звітів');
  await act(async () => root.unmount());
});
