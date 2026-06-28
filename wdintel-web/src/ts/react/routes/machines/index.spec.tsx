/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../services/api/client';
import { MachinesPage } from './index';

const apiMock = vi.hoisted(() => ({
  listUnitMachines: vi.fn(),
  createUnitMachine: vi.fn(),
  updateUnitMachine: vi.fn(),
  archiveUnitMachine: vi.fn(),
  restoreUnitMachine: vi.fn(),
  getNetworksList: vi.fn(),
  getUnitsList: vi.fn(),
}));

vi.mock('../../services/api/unit-machines', () => ({
  listUnitMachines: apiMock.listUnitMachines,
  createUnitMachine: apiMock.createUnitMachine,
  updateUnitMachine: apiMock.updateUnitMachine,
  archiveUnitMachine: apiMock.archiveUnitMachine,
  restoreUnitMachine: apiMock.restoreUnitMachine,
}));

vi.mock('../../services/api/networks', () => ({
  getNetworksList: apiMock.getNetworksList,
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: apiMock.getUnitsList,
}));

let container: HTMLDivElement;
let root: Root;

function buildMachine(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    sigintNetworkId: 7,
    networkDisplayName: 'Network 7 - Unit',
    machineId: null,
    machineTags: ['50 обрБпС'],
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage(roles = ['NetworkEditor']) {
  await act(async () => {
    root.render(<MachinesPage authUserRoles={roles} />);
  });
  await flush();
}

function iconButton(testId: string): HTMLButtonElement {
  const icon = document.body.querySelector(`[data-testid="${testId}"]`);
  expect(icon).not.toBeNull();
  return icon!.closest('button') as HTMLButtonElement;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text),
  );
  expect(button).not.toBeUndefined();
  return button as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  apiMock.listUnitMachines.mockResolvedValue([
    buildMachine(),
    buildMachine({ id: 12, machineId: 'M-12', deleted: true }),
  ]);
  apiMock.getNetworksList.mockResolvedValue([{ id: 7, name: 'Network 7', unitIds: [1, 2] }]);
  apiMock.getUnitsList.mockResolvedValue([
    { id: 1, name: 'Unit Alpha' },
    { id: 2, name: 'Unit Bravo' },
  ]);
  apiMock.createUnitMachine.mockResolvedValue({
    item: buildMachine(),
    warning: null,
  });
  apiMock.updateUnitMachine.mockResolvedValue({
    item: buildMachine(),
    warning: null,
  });
  apiMock.archiveUnitMachine.mockResolvedValue({
    item: buildMachine({ deleted: true }),
    warning: null,
  });
  apiMock.restoreUnitMachine.mockResolvedValue({
    item: buildMachine({ deleted: false }),
    warning: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('MachinesPage', () => {
  it('blocks users without network editor role and does not load data', async () => {
    await renderPage([]);

    expect(document.body.textContent).toContain('Сторінка недоступна');
    expect(apiMock.listUnitMachines).not.toHaveBeenCalled();
  });

  it('renders null machine ids, network display names, and archived rows', async () => {
    await renderPage();

    expect(document.body.textContent).toContain('НВ');
    expect(document.body.textContent).toContain('50 обрБпС');
    expect(document.body.textContent).toContain('Network 7 - Unit');
    expect(document.body.textContent).toContain('Архів');
  });

  it('shows network unit names in the machine form selector', async () => {
    await renderPage();

    await act(async () => {
      buttonByText('Створити').click();
    });
    await flush();

    expect(document.body.textContent).toContain('Network 7 - Unit Alpha, Unit Bravo');
  });

  it('archives and restores machines', async () => {
    await renderPage();

    await act(async () => {
      iconButton('ArchiveIcon').click();
    });
    await flush();

    expect(apiMock.archiveUnitMachine).toHaveBeenCalledWith({ id: 11 });

    await act(async () => {
      iconButton('RestoreIcon').click();
    });
    await flush();

    expect(apiMock.restoreUnitMachine).toHaveBeenCalledWith({ id: 12 });
  });

  it('shows duplicate active machine id error from updates', async () => {
    apiMock.updateUnitMachine.mockRejectedValueOnce(
      new HttpRequestError(400, '{"err_code":465986}'),
    );
    await renderPage();

    await act(async () => {
      iconButton('EditIcon').click();
    });
    await flush();

    await act(async () => {
      buttonByText('Зберегти').click();
    });
    await flush();

    expect(apiMock.updateUnitMachine).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Машина з таким ID вже активна.');
  });

  it('requires a machine id or at least one machine tag before save', async () => {
    apiMock.listUnitMachines.mockResolvedValueOnce([
      buildMachine({ machineId: null, machineTags: [] }),
    ]);
    await renderPage();

    await act(async () => {
      iconButton('EditIcon').click();
    });
    await flush();

    expect(document.body.textContent).toContain('Вкажіть ID машини або хоча б один тег машини.');
    expect(buttonByText('Зберегти').disabled).toBe(true);
    expect(apiMock.updateUnitMachine).not.toHaveBeenCalled();
  });
});
