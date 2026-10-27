/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps } from 'react';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, MessageMediaInfo, Network, Tag } from '../../../../../../Bindings.ts';
import { emptyFilter } from '../../../rer-duty-neo/utils.ts';
import { formatMessageCardTooltipTime, MessageCard } from '../MessageCard.tsx';
import { MessageCardHeader, MessageCardMetadata } from '../MessageCardHeader.tsx';
import {
  canDownloadAllMessageAttachments,
  isAudioMediaAttachment,
  isVideoMediaAttachment,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES,
  MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS,
} from '../MessageCardMedia.tsx';
import { MessageDeviceAccessProvider } from '../MessageDeviceAccess.tsx';
import { DutyExcludeMenuContext } from '../DutyExcludeMenu.ts';
import { MessageDeleteAccessContext, MessageWriteAccessContext } from '../MessageWriteAccess.tsx';
import {
  hideMessageCardNetworks,
  resolveMessageCardEtalonDisplayModel,
} from '../message-card.utils.ts';

const observedPopoverAnchors: Array<HTMLElement | null> = [];

vi.mock('@mui/material', async () => {
  const material = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...material,
    Popover: (props: React.ComponentProps<typeof material.Popover>) => {
      observedPopoverAnchors.push(props.anchorEl as HTMLElement | null);
      return <material.Popover {...props} />;
    },
  };
});

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  props: ComponentProps<typeof MessageCard>;
};
const rendered: Rendered[] = [];

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: 'Повідомлення',
    freq: '153.6250',
    bookmarked: false,
    important: false,
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [7],
    tags: [3],
    inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: null }],
    timestamp: 1_709_999_940_000,
    time: '02:45',
    date: '2026-03-23',
    callsigns: [],
    callsignsAlg2: [],
    location: null,
    pointTokens: [],
    textMarked: [],
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

async function renderCard(
  overrides: Partial<ComponentProps<typeof MessageCard>> = {},
  access: { canWrite?: boolean; canDelete?: boolean; dutyExcludeMenuEnabled?: boolean } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    id: 42,
    msg: buildMessage(),
    feedCount: 1,
    referenceTimeMs: 1_710_000_000_000,
    authUserName: 'tester',
    groupName: 'Group',
    senderName: 'Sender',
    copiedFeedbackId: null,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network },
    tagsMap: { 3: { id: 3, label: 'переміщення', isPalitra: false } as Tag },
    filterState: emptyFilter(),
    collapseMediaPreviews: false,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onCreateReport: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
    onToggleTag: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  } as ComponentProps<typeof MessageCard>;
  const card = <MessageCard {...props} />;
  await act(async () =>
    root.render(
      access.canWrite === undefined &&
        access.canDelete === undefined &&
        access.dutyExcludeMenuEnabled === undefined ? (
        card
      ) : (
        <DutyExcludeMenuContext.Provider value={access.dutyExcludeMenuEnabled ?? true}>
          <MessageWriteAccessContext.Provider value={access.canWrite ?? true}>
            <MessageDeleteAccessContext.Provider value={access.canDelete ?? false}>
              {card}
            </MessageDeleteAccessContext.Provider>
          </MessageWriteAccessContext.Provider>
        </DutyExcludeMenuContext.Provider>
      ),
    ),
  );
  const view = { container, root, props };
  rendered.push(view);
  return view;
}

async function renderHeader(allowed: boolean | undefined) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const msg = buildMessage({ deviceName: 'Радіостанція' });
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks: false,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network },
    networks: undefined,
  });
  const props = {
    compact: true,
    displayMode: 'duty',
    excludeMenuOptions: [],
    id: 42,
    msg,
    copiedFeedbackId: null,
    groupName: 'Group',
    senderName: 'Sender',
    etalonDisplayModel,
    mapHref: undefined,
    analysisHref: undefined,
    rightInsetPx: 0,
    topRight: <div />,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCreateReport: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onDelete: vi.fn(),
    onEditDetails: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
  } as ComponentProps<typeof MessageCardHeader>;
  const content = (
    <>
      <MessageCardHeader {...props} />
      <MessageCardMetadata
        msg={msg}
        groupName="Group"
        senderName="Sender"
        etalonDisplayModel={etalonDisplayModel}
      />
    </>
  );
  await act(async () => {
    root.render(
      allowed === undefined ? (
        content
      ) : (
        <MessageDeviceAccessProvider allowed={allowed}>{content}</MessageDeviceAccessProvider>
      ),
    );
  });
  const view = { container, root, props: {} as ComponentProps<typeof MessageCard> };
  rendered.push(view);
  return view;
}

function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function downloadClick(element: HTMLElement) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function openOverflowMenu(container: HTMLElement) {
  const overflow = container.querySelector('button[aria-label="Більше дій"]');
  if (!(overflow instanceof HTMLElement)) throw new Error('missing overflow menu');
  await click(overflow);
}

afterEach(() => {
  for (const view of rendered.splice(0)) {
    act(() => view.root.unmount());
    view.container.remove();
  }
  observedPopoverAnchors.splice(0);
  vi.restoreAllMocks();
});

describe('MessageCard', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('hides cold-loaded network metadata and copies the independently displayed unit', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(40);
    const onCopyEtalon = vi.fn();
    const view = await renderCard({
      hideNetworks: true,
      featureStrictNetworks: true,
      msg: buildMessage({ unit: 'Підрозділ 42', location: 'ЛОКАЦІЯ' }),
      networkDisplayMap: {},
      networkMap: {},
      onCopyEtalon,
    });

    expect(view.container.textContent).not.toContain('Alpha');
    expect(view.container.textContent).toContain('Підрозділ 42');
    expect(view.container.textContent).toContain('Локація');

    await openOverflowMenu(view.container);
    const copySection = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Копіювати…');
    if (copySection == null) throw new Error('missing copy section');
    await click(copySection);
    const copyEtalon = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === "Копіювати прив'язку");
    if (copyEtalon == null) throw new Error('missing etalon copy action');
    await click(copyEtalon);

    expect(onCopyEtalon).toHaveBeenCalledWith('Підрозділ 42');
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('passes the hidden-network presentation to report creation', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(40);
    const onCreateReport = vi.fn();
    const view = await renderCard({
      hideNetworks: true,
      msg: buildMessage({ unit: 'Підрозділ 42', location: 'ЛОКАЦІЯ' }),
      onCreateReport,
    });

    const report = view.container.querySelector<HTMLElement>('[title="Створити розвіддонесення"]');
    if (report == null) throw new Error('missing report action');
    await click(report);

    expect(onCreateReport).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryKind: 'unit',
        displayValue: 'Підрозділ 42',
        copyEtalonValue: 'Підрозділ 42',
        renderedNetworks: [],
      }),
      report,
    );
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('keeps independent unit and location copy actions when hiding hydrated networks', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(40);
    const onCopyEtalon = vi.fn();
    const onCopyLocation = vi.fn();
    const view = await renderCard({
      hideNetworks: true,
      msg: buildMessage({ unit: 'Підрозділ 42', location: 'ЛОКАЦІЯ' }),
      onCopyEtalon,
      onCopyLocation,
    });

    expect(view.container.textContent).not.toContain('Alpha');
    expect(view.container.textContent).toContain('Підрозділ 42');
    expect(view.container.textContent).toContain('Локація');

    await openOverflowMenu(view.container);
    const copySection = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Копіювати…');
    if (copySection == null) throw new Error('missing copy section');
    await click(copySection);
    const copyEtalon = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === "Копіювати прив'язку");
    if (copyEtalon == null) throw new Error('missing etalon copy action');
    await click(copyEtalon);

    await openOverflowMenu(view.container);
    const secondCopySection = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Копіювати…');
    if (secondCopySection == null) throw new Error('missing second copy section');
    await click(secondCopySection);
    const copyLocation = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Копіювати локацію');
    if (copyLocation == null) throw new Error('missing location copy action');
    await click(copyLocation);

    expect(onCopyEtalon).toHaveBeenCalledWith('Підрозділ 42');
    expect(onCopyLocation).toHaveBeenCalledWith('Локація');
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it.each([
    { unit: undefined, location: 'ЛОКАЦІЯ', primaryKind: 'location' as const, value: 'Локація' },
    { unit: undefined, location: null, primaryKind: 'empty' as const, value: '—' },
  ])(
    'uses the $primaryKind fallback on hidden cold-loaded networks',
    ({ unit, location, primaryKind, value }) => {
      const raw = resolveMessageCardEtalonDisplayModel(buildMessage({ unit, location }), {
        featureStrictNetworks: true,
        networkDisplayMap: {},
        networkMap: {},
      });
      const hidden = hideMessageCardNetworks(raw, unit);

      expect(hidden).toMatchObject({
        primaryKind,
        displayValue: value,
        copyEtalonValue: null,
        renderedNetworks: [],
      });
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([
    { displayMode: 'duty' as const, featureStrictNetworks: false, hideNetworks: false },
    { displayMode: 'analysis' as const, featureStrictNetworks: false, hideNetworks: true },
    { displayMode: 'duty' as const, featureStrictNetworks: true, hideNetworks: false },
    { displayMode: 'analysis' as const, featureStrictNetworks: true, hideNetworks: true },
  ])(
    'ECHO-3324 keeps the explicit header unit independent of networks in $displayMode cards',
    async ({ displayMode, featureStrictNetworks, hideNetworks }) => {
      const view = await renderCard({
        displayMode,
        featureStrictNetworks,
        hideNetworks,
        msg: buildMessage({ unit: 'Підрозділ 42' }),
      });
      const headerUnit = view.container.querySelector('[data-message-card-header-unit-row="true"]');

      expect(headerUnit?.textContent).toContain('Підрозділ 42');
      expect(headerUnit?.textContent).not.toContain('Alpha');
      if (!featureStrictNetworks && !hideNetworks) {
        expect(
          view.container.querySelector('[data-message-card-network-item="true"]')?.textContent,
        ).toContain('Alpha');
      }
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([
    { networkIds: [] as number[], label: 'no network ids' },
    { networkIds: [99], label: 'unresolved network ids' },
  ])(
    'ECHO-3324 keeps the strict visible-network header unit with $label',
    async ({ networkIds }) => {
      const view = await renderCard({
        featureStrictNetworks: true,
        msg: buildMessage({ unit: 'Підрозділ 42', networkIds }),
      });
      expect(
        view.container.querySelector('[data-message-card-header-unit-row="true"]')?.textContent,
      ).toContain('Підрозділ 42');
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([undefined, null, '', '   '])(
    'ECHO-3324 renders a dash for blank header units (%j)',
    async (unit) => {
      const view = await renderCard({ msg: buildMessage({ unit }) });
      expect(
        view.container.querySelector('[data-message-card-header-unit-row="true"]')?.textContent,
      ).toContain('—');
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3598
  it('retains hydrated network metadata and copying when network hiding is disabled', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(40);
    const onCopyEtalon = vi.fn();
    const view = await renderCard({ onCopyEtalon });

    expect(view.container.textContent).toContain('Alpha');

    await openOverflowMenu(view.container);
    const copySection = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Копіювати…');
    if (copySection == null) throw new Error('missing copy section');
    await click(copySection);
    const copyEtalon = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === "Копіювати прив'язку");
    if (copyEtalon == null) throw new Error('missing etalon copy action');
    await click(copyEtalon);

    expect(onCopyEtalon).toHaveBeenCalledWith('р/м Alpha');
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('opens a catalog-only callsign tooltip when networks are hidden', async () => {
    const view = await renderCard({
      hideNetworks: true,
      msg: buildMessage({
        text: 'WOLF',
        textMarked: [
          {
            CNCallsignC: { text: 'WOLF', begin: 0, end: 4, etalon: 'WOLF' },
          },
        ],
      }),
      networks: [
        {
          id: 7,
          name: 'МЕРЕЖА, ЯКУ НЕ МОЖНА ПОКАЗУВАТИ',
          freqs: [],
          unitIds: [],
        } as Network,
      ],
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'КАТАЛОГОВА ПОЗИЦІЯ',
              comment: '',
              unit1: 'Каталоговий підрозділ',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [7],
            },
          ],
          networkHints: [
            {
              id: 1,
              networkId: 7,
              position: 'МЕРЕЖЕВА ПОЗИЦІЯ',
              formation: 'МЕРЕЖЕВЕ З’ЄДНАННЯ',
            },
          ],
        },
      },
    });

    const hint = view.container.querySelector<HTMLElement>(
      'button[aria-label="Підказка з каталогу"]',
    );
    if (hint == null) throw new Error('missing catalog callsign hint');
    await act(async () => {
      hint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Позивні з каталогу:');
    expect(tooltip?.textContent).toContain('КАТАЛОГОВА ПОЗИЦІЯ');
    expect(tooltip?.textContent).not.toContain('МЕРЕЖЕВА ПОЗИЦІЯ');
    expect(tooltip?.textContent).not.toContain('МЕРЕЖА, ЯКУ НЕ МОЖНА ПОКАЗУВАТИ');
  });

  it.each([
    { displayMode: 'duty' as const, hasExcludeSection: true },
    { displayMode: 'analysis' as const, hasExcludeSection: false },
  ])(
    'keeps report creation direct and moves the remaining actions into the menu on narrow $displayMode cards',
    async ({ displayMode, hasExcludeSection }) => {
      const clientWidth = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockReturnValue(390);
      const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(40);

      const view = await renderCard({
        displayMode,
        messageTimeBasis: 'creation',
        referenceTimeMs: Date.UTC(2026, 6, 17, 0, 31),
        msg: buildMessage({ createdAt: Date.UTC(2026, 6, 17, 0, 30), important: true }),
      });
      const visibleActions = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('.message-card-header-actions button'),
      ).map((action) => action.getAttribute('aria-label'));

      expect(visibleActions).toEqual(['Створити розвіддонесення', 'Більше дій']);
      const overflowAction = view.container.querySelector('button[aria-label="Більше дій"]');

      const importantStatus = view.container.querySelector(
        '[data-message-card-important-status="true"]',
      );
      expect(importantStatus?.textContent).toContain('Важливе');
      expect(importantStatus?.nextElementSibling?.contains(overflowAction)).toBe(true);
      expect(
        view.container.querySelector('.message-card-header-actions')?.contains(overflowAction),
      ).toBe(true);
      expect(
        view.container.querySelectorAll('[data-message-card-timestamp-item="true"]'),
      ).toHaveLength(1);
      expect(
        view.container.querySelector('[data-message-card-timestamp-footer="true"]')?.textContent,
      ).toBe('03:30');
      expect(view.container.querySelector('.message-card-header-timestamps')?.classList).toContain(
        'message-card-header-timestamps--mobile-nowrap',
      );

      await openOverflowMenu(view.container);
      expect(document.body.textContent).toContain('Позначити як не важливе');
      expect(document.body.textContent).toContain('Додати в закладки');
      expect(document.body.textContent).toContain('Копіювати');
      expect(document.body.textContent).toContain('Перейти');
      if (hasExcludeSection) expect(document.body.textContent).toContain('Виключити');

      const copySection = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
      ).find((item) => item.textContent?.trim() === 'Копіювати…');
      if (copySection == null) throw new Error('missing copy section');
      await click(copySection);

      expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
      expect(document.body.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
        'Копіювання повідомлення',
      );
      expect(document.body.querySelector('[aria-label="Назад до додаткових дій"]')).not.toBeNull();
      expect(document.body.textContent).toContain('Копіювати повідомлення');

      const back = document.body.querySelector('[aria-label="Назад до додаткових дій"]');
      if (!(back instanceof HTMLElement)) throw new Error('missing menu back button');
      await click(back);
      expect(document.body.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
        'Додаткові дії повідомлення',
      );
      expect(document.body.textContent).toContain('Копіювати');

      const navigateSection = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
      ).find((item) => item.textContent?.trim() === 'Перейти…');
      if (navigateSection == null) throw new Error('missing navigate section');
      await click(navigateSection);
      expect(document.body.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
        'Перехід по повідомленню',
      );
      expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);

      const navigateBack = document.body.querySelector('[aria-label="Назад до додаткових дій"]');
      if (!(navigateBack instanceof HTMLElement)) throw new Error('missing navigate back button');
      await click(navigateBack);

      if (hasExcludeSection) {
        const excludeSection = Array.from(
          document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
        ).find((item) => item.textContent?.trim() === 'Виключити…');
        if (excludeSection == null) throw new Error('missing exclude section');
        await click(excludeSection);
        expect(document.body.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
          'Виключення з фільтрів',
        );
        expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
      }

      clientWidth.mockRestore();
      scrollWidth.mockRestore();
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3569
  it('does not expose deletion without independent delete access', async () => {
    const view = await renderCard(
      { displayMode: 'analysis', onEditDetails: vi.fn(), onDelete: vi.fn() },
      { canDelete: false },
    );
    const overflow = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflow instanceof HTMLButtonElement)) throw new Error('overflow button not found');
    await click(overflow);
    expect(document.body.textContent).toContain('Редагувати');
    expect(document.body.textContent).not.toContain('Видалити');
  });

  it('keeps the overflow trigger available for focus restoration when editing', async () => {
    const onEditDetails = vi.fn();
    const view = await renderCard({ displayMode: 'analysis', onEditDetails });
    const overflow = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflow instanceof HTMLButtonElement)) throw new Error('overflow button not found');
    overflow.focus();
    await click(overflow);
    const editButton = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Редагувати');
    if (editButton == null) throw new Error('missing Редагувати');
    editButton.focus();

    await click(editButton);

    expect(onEditDetails).toHaveBeenCalledWith(overflow);
  });

  // Regression: https://github.com/echoua/echo/issues/3569
  it('keeps delete access independent from message write access', async () => {
    const onDelete = vi.fn();
    const view = await renderCard(
      { displayMode: 'analysis', onDelete },
      { canWrite: false, canDelete: true },
    );
    const overflow = view.container.querySelector('button[aria-label="Більше дій"]');
    if (!(overflow instanceof HTMLButtonElement)) throw new Error('overflow button not found');
    await click(overflow);
    const deleteButton = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"], li'),
    ).find((item) => item.textContent?.trim() === 'Видалити');
    if (deleteButton == null) throw new Error('missing Видалити');
    await click(deleteButton);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Редагувати');
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('keeps Cyber group exclusion without disclosing post exclusion data', async () => {
    const view = await renderCard({
      displayMode: 'duty',
      msg: buildMessage({ post: 'HIDDEN-POST' }),
    });
    const exclude = view.container.querySelector('button[aria-label="Виключити…"]');
    if (!(exclude instanceof HTMLButtonElement)) throw new Error('exclude button not found');
    await click(exclude);
    expect(document.body.textContent).toContain('Виключити групу');
    expect(document.body.textContent).not.toContain('Виключити пост');
    expect(document.body.textContent).not.toContain('HIDDEN-POST');
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('disables Duty exclusion without removing other card actions', async () => {
    const view = await renderCard({}, { dutyExcludeMenuEnabled: false });
    expect(view.container.querySelector('button[aria-label="Виключити…"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Копіювати…"]')).not.toBeNull();
  });

  // Regression: https://github.com/echoua/echo/issues/3569
  it.each(['full', 'compact'] as const)(
    'shows only applied inert viewer tags in %s layout',
    async (tagsLayout) => {
      const onToggleTag = vi.fn();
      const view = await renderCard(
        {
          tagsLayout,
          msg: buildMessage({ tags: [3], inboxTags: [] }),
          onToggleTag,
          onEditDetails: vi.fn(),
        },
        { canWrite: false },
      );
      const tag = view.container.querySelector('[data-message-card-tag-id="3"]');
      expect(tag).not.toBeNull();
      expect(tag?.querySelector('button')).toBeNull();
      await click(tag as HTMLElement);
      expect(onToggleTag).not.toHaveBeenCalled();
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3569
  it.each([false, true])('preserves bot-tag visibility for viewers (%s)', async (hideBotTags) => {
    const view = await renderCard(
      {
        hideBotTags,
        tagsMap: {
          3: { id: 3, label: 'переміщення', isPalitra: false } as Tag,
          4: { id: 4, label: 'бот', isPalitra: false } as Tag,
        },
        msg: buildMessage({
          inboxTags: [
            { id: 1, tagId: 3, confidence: 1, login: 'other', model: null, organismId: null },
            { id: 2, tagId: 4, confidence: 1, login: null, model: 'bot', organismId: null },
          ],
        }),
      },
      { canWrite: false },
    );
    expect(view.container.querySelector('[data-message-card-tag-id="3"]')).not.toBeNull();
    expect(view.container.querySelector('[data-message-card-tag-id="4"]') != null).toBe(
      !hideBotTags,
    );
  });

  // Regression: https://github.com/echoua/echo/issues/3569
  it('keeps attachment downloads available to viewers without edit actions', async () => {
    const view = await renderCard(
      {
        onEditDetails: vi.fn(),
        msg: buildMessage({
          media: ['first', 'second'].map((id) => ({
            id,
            href: `/api/messenger/media/${id}`,
            contentType: 'text/plain',
            fileName: `${id}.txt`,
            sizeBytes: 1,
          })) as InboxMessage['media'],
        }),
      },
      { canWrite: false },
    );
    await openOverflowMenu(view.container);
    expect(
      document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain('Редагувати');
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each(['duty', 'analysis'] as const)(
    'keeps the AI important status visible without actions on a read-only %s card',
    async (displayMode) => {
      const view = await renderCard({
        readOnly: true,
        displayMode,
        msg: buildMessage({ important: true, aiImportant: true }),
      });
      const importantStatus = view.container.querySelector(
        '[data-message-card-important-status="true"]',
      );
      expect(importantStatus?.textContent).toContain('Важливе');
      expect(importantStatus?.getAttribute('title')).toBe('Позначено ШІ');
      expect(view.container.querySelector('[aria-label="Дії повідомлення"]')).toBeNull();
    },
  );

  it('keeps attachment archive download without report creation on a read-only card', async () => {
    const view = await renderCard({
      readOnly: true,
      msg: buildMessage({
        media: ['first', 'second'].map((id) => ({
          id,
          href: `/api/messenger/media/${id}`,
          contentType: 'text/plain',
          fileName: `${id}.txt`,
          sizeBytes: 1,
        })) as InboxMessage['media'],
      }),
    });

    await openOverflowMenu(view.container);
    expect(
      document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
    ).not.toBeNull();
    expect(view.container.querySelector('[title="Створити розвіддонесення"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Створити розвіддонесення');
  });

  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 hides device metadata without device access', async () => {
    const view = await renderHeader(false);
    expect(view.container.querySelector('[title="Пристрій"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 hides device metadata without a provider', async () => {
    const view = await renderHeader(undefined);
    expect(view.container.querySelector('[title="Пристрій"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 shows device metadata with an allowed provider', async () => {
    const view = await renderHeader(true);
    expect(view.container.querySelector('[title="Пристрій"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each(['interception', 'creation'] as const)(
    '#3515 keeps receipt time when a date-only interception timestamp is selected (%s)',
    async (messageTimeBasis) => {
      const view = await renderCard({
        messageTimeBasis,
        referenceTimeMs: Date.UTC(2026, 6, 15, 10, 1),
        msg: buildMessage({
          text: 'Повідомлення без часу',
          textMarked: [],
          timestamp: Date.UTC(2026, 6, 15, 9),
          createdAt: Date.UTC(2026, 6, 15, 10),
          date: '15.07.2026',
          time: '12:00:00',
          isTimeNull: true,
          hasDateInHeader: false,
        }),
      });
      const timestamp = view.container.querySelector('[data-message-card-timestamp-item="true"]');
      expect(timestamp?.textContent).toContain(
        messageTimeBasis === 'creation' ? '15.07.2026, 13:00' : '15.07.2026',
      );
      expect(timestamp?.textContent).not.toContain('12:00');
      expect(
        view.container.querySelector('[data-message-card-timestamp-footer="true"]')?.textContent,
      ).toBe('13:00');
      expect(
        view.container.querySelector('[data-message-card-timestamp-footer="true"]'),
      ).not.toBeNull();
      expect(
        formatMessageCardTooltipTime({
          time: '12:00',
          timestamp: Date.UTC(2026, 6, 15, 9),
          isTimeNull: true,
        }),
      ).not.toContain('12:00');
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each(['interception', 'creation'] as const)(
    '#3515 displays the selected absolute timestamp and independent receipt time in analysis (%s)',
    async (messageTimeBasis) => {
      for (const isTimeNull of [true, false, null]) {
        const view = await renderCard({
          displayMode: 'analysis',
          messageTimeBasis,
          referenceTimeMs: Date.UTC(2026, 6, 16, 21, 31),
          msg: buildMessage({
            text: 'Повідомлення',
            textMarked: [],
            createdAt: Date.UTC(2026, 6, 16, 21, 30),
            timestamp: Date.UTC(2026, 6, 15, 9),
            date: '14.07.2026',
            time: '08:45:00',
            isTimeNull,
          }),
        });
        const timestamps = view.container.querySelectorAll(
          '[data-message-card-timestamp-item="true"]',
        );
        expect(timestamps).toHaveLength(1);
        expect(timestamps[0]?.getAttribute('title')).toBe(
          messageTimeBasis === 'creation'
            ? 'Дата і час створення повідомлення'
            : 'Дата і час перехоплення',
        );
        expect(timestamps[0]?.textContent).toContain(
          messageTimeBasis === 'creation'
            ? '17.07.2026, 00:30'
            : isTimeNull
              ? '14.07.2026'
              : '14.07.2026, 08:45',
        );
        if (messageTimeBasis === 'interception' && isTimeNull)
          expect(timestamps[0]?.textContent).not.toContain(':');
        expect(timestamps[0]?.querySelector('[data-testid="TodayOutlinedIcon"]')).not.toBeNull();
        expect(timestamps[0]?.querySelector('.message-card-header-icon')).not.toBeNull();
        expect(timestamps[0]?.querySelector('.message-card-timestamp-icon')).toBeNull();
        const footer = view.container.querySelector('[data-message-card-timestamp-footer="true"]');
        expect(footer?.querySelector('[title="Час отримання повідомлення"]')).not.toBeNull();
        expect(footer?.textContent).toBe('00:30');
      }
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3515
  it('ECHO-3515 does not borrow a timestamp across missing time bases', async () => {
    const createdAt = Date.UTC(2026, 6, 16, 21, 30);
    const interception = Date.UTC(2026, 6, 15, 9);
    const creationView = await renderCard({
      messageTimeBasis: 'creation',
      referenceTimeMs: createdAt + 60_000,
      msg: buildMessage({
        createdAt: null,
        timestamp: interception,
        date: '14.07.2026',
        time: '08:45:00',
      }),
    });
    expect(
      creationView.container.querySelector('[data-message-card-timestamp-item="true"]')
        ?.textContent,
    ).toContain('—');
    expect(
      creationView.container.querySelector('[data-message-card-timestamp-footer="true"]'),
    ).toBeNull();

    const interceptionView = await renderCard({
      messageTimeBasis: 'interception',
      referenceTimeMs: createdAt + 60_000,
      msg: buildMessage({ createdAt, timestamp: null, date: null, time: null, isTimeNull: false }),
    });
    expect(
      interceptionView.container.querySelector('[data-message-card-timestamp-item="true"]')
        ?.textContent,
    ).toContain('—');
    expect(
      interceptionView.container.querySelector('[data-message-card-timestamp-footer="true"]')
        ?.textContent,
    ).toBe('00:30');
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([
    ['2026-10-26T08:16:00Z', '2026-10-26T12:00:00Z', '10:16'],
    ['2026-10-25T08:16:00Z', '2026-10-26T12:00:00Z', '25.10, 10:16'],
    ['2025-10-26T08:16:00Z', '2026-10-26T12:00:00Z', '26.10.2025, 10:16'],
    ['2026-07-16T21:30:00Z', '2026-07-17T10:00:00Z', '00:30'],
    ['2026-07-16T20:59:00Z', '2026-07-16T21:01:00Z', '16.07, 23:59'],
    ['2026-12-31T21:30:00Z', '2026-12-31T22:01:00Z', '31.12.2026, 23:30'],
    ['2025-12-31T22:30:00Z', '2026-01-02T12:00:00Z', '01.01, 00:30'],
  ])(
    '#3324 formats receipt time using the Kyiv calendar (%s)',
    async (createdAt, now, expected) => {
      const view = await renderCard({
        referenceTimeMs: Date.parse(now),
        msg: buildMessage({ createdAt: Date.parse(createdAt) }),
      });
      expect(
        view.container.querySelector('[data-message-card-timestamp-footer="true"]')?.textContent,
      ).toBe(expected);
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each([
    { date: '2026-07-14', time: '08:45:00', isTimeNull: false, expected: '14.07.2026, 08:45' },
    { date: null, time: null, isTimeNull: false, expected: '15.07.2026, 12:00' },
    { date: null, time: null, isTimeNull: true, expected: '15.07.2026' },
  ])(
    '#3515 formats analysis event dates with timestamp fallback ($expected)',
    async ({ expected, ...fields }) => {
      const view = await renderCard({
        displayMode: 'analysis',
        msg: buildMessage({ ...fields, timestamp: Date.UTC(2026, 6, 15, 9) }),
      });
      expect(
        view.container.querySelector('[title="Дата і час перехоплення"]')?.textContent,
      ).toContain(expected);
      if (fields.isTimeNull) {
        expect(
          view.container.querySelector('[title="Дата і час перехоплення"]')?.textContent,
        ).not.toContain(':');
      }
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 cancels the matching mixed-provenance bot-tag action', async () => {
    const onCancelBotTagAction = vi.fn();
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction,
      onMarkBotTagWrong: vi.fn(),
    });
    await click(button(document.body, 'СКАСУВАТИ'));
    expect(onCancelBotTagAction).toHaveBeenCalledOnce();
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 confirms the matching bot-tag action exactly once', async () => {
    const onMarkBotTagWrong = vi.fn();
    await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onMarkBotTagWrong,
      onCancelBotTagAction: vi.fn(),
    });
    await click(button(document.body, 'БОТ ПОМИЛИВСЯ'));
    expect(onMarkBotTagWrong).toHaveBeenCalledOnce();
    expect(onMarkBotTagWrong).toHaveBeenCalledWith(42, 3);
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 retains the matching bot-tag anchor through unrelated card rerenders', async () => {
    const onCancelBotTagAction = vi.fn();
    const onMarkBotTagWrong = vi.fn();
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction,
      onMarkBotTagWrong,
    });
    const anchor = observedPopoverAnchors.at(-1);
    expect(anchor).toBeInstanceOf(HTMLElement);

    await act(async () => {
      view.root.render(<MessageCard {...view.props} messageTextPreviewLines={40} />);
    });

    expect(observedPopoverAnchors.at(-1)).toBe(anchor);
    expect(onCancelBotTagAction).not.toHaveBeenCalled();
    expect(onMarkBotTagWrong).not.toHaveBeenCalled();
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([
    ['read-only card', { readOnly: true }],
    ['disabled bot tags', { hideBotTags: true }],
    ['different message', { botTagAction: { messageId: 43, tagId: 3 } }],
    ['missing tag', { botTagAction: { messageId: 42, tagId: 99 } }],
  ] as const)('ECHO-3324 does not open a bot-action Popover for a %s', async (_, overrides) => {
    await renderCard({
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction: vi.fn(),
      onMarkBotTagWrong: vi.fn(),
      ...overrides,
    });
    expect(observedPopoverAnchors).toHaveLength(0);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
  it('classifies ambiguous video and snake-case audio metadata', () => {
    const video = {
      id: 'mpeg',
      href: '/media/mpeg',
      contentType: 'video/mp2t',
      fileName: 'clip.ts',
      sizeBytes: 1,
    } as MessageMediaInfo;
    const audio = {
      id: 'audio',
      href: '/media/audio',
      content_type: 'audio/mpeg',
      file_name: 'voice.mp3',
      size_bytes: 1,
    } as MessageMediaInfo;
    expect(isVideoMediaAttachment(video)).toBe(true);
    expect(isAudioMediaAttachment(video)).toBe(false);
    expect(isAudioMediaAttachment(audio)).toBe(true);
  });
  it('keeps download cooldowns independent by attachment identity', async () => {
    vi.useFakeTimers();
    try {
      const view = await renderCard({
        msg: buildMessage({
          media: [
            {
              id: 'first',
              href: 'javascript:void(1)',
              contentType: 'audio/mpeg',
              fileName: 'first.mp3',
            },
            {
              id: 'second',
              href: 'javascript:void(0)',
              contentType: 'audio/mpeg',
              fileName: 'second.mp3',
            },
          ] as InboxMessage['media'],
        }),
      });
      const first = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: first.mp3"]',
      ) as HTMLElement;
      const second = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: second.mp3"]',
      ) as HTMLElement;
      expect((await downloadClick(first)).defaultPrevented).toBe(false);
      expect((await downloadClick(first)).defaultPrevented).toBe(true);
      expect((await downloadClick(second)).defaultPrevented).toBe(false);
      await act(async () => vi.advanceTimersByTime(MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS));
      expect(first.getAttribute('aria-label')).toBe('Завантажити аудіо: first.mp3');
      expect(second.getAttribute('aria-label')).toBe('Завантажити аудіо: second.mp3');
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not request derived images for oversized snake-case audio metadata', async () => {
    const view = await renderCard({
      msg: buildMessage({
        media: [
          {
            id: 'large-audio',
            href: '/api/messenger/media/large-audio',
            content_type: 'audio/mpeg',
            file_name: 'large.mp3',
            size_bytes: 100 * 1024 * 1024 + 1,
          },
        ] as InboxMessage['media'],
      }),
    });
    const player = view.container.querySelector('custom-audio-player');
    expect(player?.getAttribute('src')).toBe('/api/messenger/media/large-audio?playback=1');
    expect(player?.hasAttribute('wave-src')).toBe(false);
    expect(player?.hasAttribute('spectrum-src')).toBe(false);
  });
  it('keeps legacy image order while merging metadata by attachment identity', async () => {
    const first = 'https://example.test/files/first.png';
    const shared = 'https://example.test/files/shared.png';
    const view = await renderCard({
      msg: buildMessage({
        images: [first, shared],
        media: [
          {
            id: 'shared-media',
            href: shared,
            contentType: 'image/png',
            fileName: 'shared.png',
            sizeBytes: 1,
          },
        ] as InboxMessage['media'],
      }),
    });
    const thumbnails = Array.from(
      view.container.querySelectorAll('button[aria-label="Відкрити зображення"]'),
    );
    expect(
      thumbnails.map((thumbnail) => thumbnail.querySelector('img')?.getAttribute('src')),
    ).toEqual([first, shared]);
    await click(thumbnails[1] as HTMLElement);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('shared.png');
  });
  it('rejects archive count and size limits while keeping individual downloads', async () => {
    const attachment = (id: string, sizeBytes: number) =>
      ({
        id,
        href: `/api/messenger/media/${id}`,
        contentType: 'text/plain',
        fileName: `${id}.txt`,
        sizeBytes,
      }) as MessageMediaInfo;
    const rejectedCollections = [
      Array.from({ length: RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES + 1 }, (_, index) =>
        attachment(`count-${index}`, 1),
      ),
      [
        attachment('large', RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES + 1),
        attachment('small', 1),
      ],
    ];

    for (const media of rejectedCollections) {
      expect(canDownloadAllMessageAttachments(media)).toBe(false);
      const view = await renderCard({ msg: buildMessage({ media }) });
      expect(view.container.querySelectorAll('a[download]')).toHaveLength(media.length);
      if (view.container.querySelector('button[aria-label="Більше дій"]'))
        await openOverflowMenu(view.container);
      expect(
        document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
      ).toBeNull();
    }

    const validMedia = [attachment('valid-first', 1), attachment('valid-second', 1)];
    expect(canDownloadAllMessageAttachments(validMedia)).toBe(true);

    const convertedKmz = {
      ...attachment('route', 128),
      contentType: 'application/geo+json',
      fileName: 'route.geojson',
    } as MessageMediaInfo;
    expect(
      canDownloadAllMessageAttachments([{ ...convertedKmz, kmzConversionStatus: 'done' }]),
    ).toBe(true);
    expect(
      canDownloadAllMessageAttachments([
        { ...convertedKmz, fileName: 'route.KML', kmzConversionStatus: 'done' },
      ]),
    ).toBe(true);
    for (const kmzConversionStatus of [null, 'pending', 'processing', 'error']) {
      expect(canDownloadAllMessageAttachments([{ ...convertedKmz, kmzConversionStatus }])).toBe(
        false,
      );
    }
    expect(
      canDownloadAllMessageAttachments([
        { ...convertedKmz, fileName: 'route.KMZ', kmzConversionStatus: 'done' },
      ]),
    ).toBe(false);

    const validView = await renderCard({ msg: buildMessage({ media: validMedia }) });
    await openOverflowMenu(validView.container);
    expect(
      document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
    ).not.toBeNull();
  });
});
