/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportTextPreviewAction, ReportTextPreviewPane } from '../ReportTextPreview';

describe('attachment preview text draft', () => {
  afterEach(() => document.body.replaceChildren());

  it.each([
    ['message', 'Текст повідомлення', 'Писати повідомлення'],
    ['report', 'Текст розвіддонесення', 'Писати розвіддонесення'],
  ] as const)('uses %s-specific labels', async (kind, fieldLabel, actionLabel) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <>
          <ReportTextPreviewAction kind={kind} active={false} onClick={vi.fn()} />
          <ReportTextPreviewPane draft={{ kind, value: '', onChange: vi.fn() }} />
        </>,
      );
    });

    expect(container.querySelector(`button[aria-label="${actionLabel}"]`)).not.toBeNull();
    expect(container.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(fieldLabel);
    expect(container.textContent).toContain(fieldLabel);

    act(() => root.unmount());
  });
});
