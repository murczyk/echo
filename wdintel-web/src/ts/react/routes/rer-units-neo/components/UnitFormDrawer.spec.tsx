/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../../Bindings';
import { getCreateUnitDuplicateCandidates, getUnitsPage } from '../../../services/api/units';
import { UnitFormDrawer, type UnitFormSubmit } from './UnitFormDrawer';

vi.mock('../../../services/api/units', () => ({
  DEFAULT_LIST_UNITS_REQ: {},
  getCreateUnitDuplicateCandidates: vi.fn(),
  getUnitsPage: vi.fn(),
}));

const duplicate = {
  id: 7,
  name: '2 батальйон',
  active: true,
  other: '',
  teamOrCrew: '',
  section: '',
  squad: '',
  platoon: '',
  company: '',
  battalion: '2 батальйон',
  regiment: '',
  brigade: '',
  division: '',
  corps: '',
  army: '',
  militaryDistrict: '',
  armyRegion: '',
  comment: '',
  orbitNote: null,
  isDeduplicateCandidate: true,
  createdAt: 0,
  createdByLoginId: '',
  hasOrbit: true,
  orbitUnitIds: ['orbit-id'],
  orbitUnitGenerativeNames: ['106 пдд / МВО'],
} satisfies Unit;

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button ${label} not found`);
  return button;
}

async function renderDialog(onSubmit: (value: UnitFormSubmit) => void): Promise<Root> {
  vi.mocked(getUnitsPage).mockResolvedValue({
    showLoadMore: false,
    totalCount: 0,
    statusCounts: { active: 0, inactive: 0 },
    units: [],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <UnitFormDrawer
        open
        unit={null}
        devicesSectionEnabled={false}
        submitting={false}
        error={null}
        orbitUnits={[]}
        orbitLinksLoading={false}
        orbitLinksError={null}
        canLinkOrbitUnit={false}
        unlinkingOrbitUnitId={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onLinkOrbitUnit={vi.fn()}
        onUnlinkOrbitUnit={vi.fn()}
      />,
    );
  });
  return root;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('UnitFormDrawer', () => {
  it('preserves a draft through suspension and resets it only for a new session', async () => {
    vi.mocked(getUnitsPage).mockResolvedValue({
      showLoadMore: false,
      totalCount: 0,
      statusCounts: { active: 0, inactive: 0 },
      units: [],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    const render = (open: boolean, suspended = false) =>
      root.render(
        <UnitFormDrawer
          open={open}
          suspended={suspended}
          unit={null}
          devicesSectionEnabled={false}
          submitting={false}
          error={null}
          orbitUnits={[]}
          orbitLinksLoading={false}
          orbitLinksError={null}
          canLinkOrbitUnit={false}
          unlinkingOrbitUnitId={null}
          onClose={onClose}
          onSubmit={vi.fn()}
          onLinkOrbitUnit={vi.fn()}
          onUnlinkOrbitUnit={vi.fn()}
        />,
      );

    await act(async () => render(true));
    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Наприклад, 2 батальйон"]',
    );
    if (input === null) throw new Error('unit form input was not rendered');
    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'draft',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => render(true, true));
    await act(async () => render(true, false));
    expect(input.value).toBe('draft');
    expect(onClose).not.toHaveBeenCalled();
    const drawer = document.querySelector('[aria-labelledby="unit-form-drawer-title"]');
    expect(document.activeElement === input || drawer?.contains(document.activeElement)).toBe(true);

    await act(async () => render(false));
    await act(async () => render(true));
    expect(input.value).toBe('');
    act(() => root.unmount());
  });

  it('preserves a refreshed unit draft but resets for a different unit', async () => {
    vi.mocked(getUnitsPage).mockResolvedValue({
      showLoadMore: false,
      totalCount: 0,
      statusCounts: { active: 0, inactive: 0 },
      units: [],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (unit: Unit) =>
      root.render(
        <UnitFormDrawer
          open
          unit={unit}
          devicesSectionEnabled={false}
          submitting={false}
          error={null}
          orbitUnits={[]}
          orbitLinksLoading={false}
          orbitLinksError={null}
          canLinkOrbitUnit={false}
          unlinkingOrbitUnitId={null}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
          onLinkOrbitUnit={vi.fn()}
          onUnlinkOrbitUnit={vi.fn()}
        />,
      );
    await act(async () => render(duplicate));
    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Наприклад, 2 батальйон"]',
    );
    if (input === null) throw new Error('unit form input was not rendered');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'draft',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => render({ ...duplicate, battalion: 'refreshed' }));
    expect(input.value).toBe('draft');
    await act(async () => render({ ...duplicate, id: 8, battalion: 'new unit' }));
    expect(input.value).toBe('new unit');
    act(() => root.unmount());
  });

  it('waits for duplicate selection before creating an ORBIT-linked unit', async () => {
    vi.mocked(getCreateUnitDuplicateCandidates).mockResolvedValue([duplicate]);
    const onSubmit = vi.fn();
    const root = await renderDialog(onSubmit);
    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Наприклад, 2 батальйон"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (input === null) return;
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '2 батальйон',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => findButton('Створити').click());

    expect(getCreateUnitDuplicateCandidates).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Об’єднати дублікати');
    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);

    await act(async () => checkbox?.click());
    await act(async () => findButton('Створити').click());

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        unit: expect.objectContaining({ duplicateUnitIds: [7] }),
      }),
    );
    act(() => root.unmount());
  });
});
