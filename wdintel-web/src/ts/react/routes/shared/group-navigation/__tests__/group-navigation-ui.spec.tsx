/**
 * @vitest-environment happy-dom
 */
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { firstVisibleGrapheme, GroupAvatar } from '../GroupAvatar';
import { GroupIsland } from '../GroupIsland';
import { GroupList } from '../GroupList';
import { GroupPanel } from '../GroupPanel';
import type { GroupNavigationItem } from '../group-navigation.types';

const allGroups: GroupNavigationItem = {
  kind: 'all',
  masterKey: null,
  name: 'Всі групи',
  unreadCount: 3,
  oldestUnreadMessageRef: null,
  latestCursor: null,
};

const kitkat: GroupNavigationItem = {
  kind: 'group',
  masterKey: 'kitkat',
  name: 'KitKat',
  ignoreOperativny: false,
  unreadCount: 128,
  oldestUnreadMessageRef: null,
  lastActivityAt: null,
  latestCursor: null,
};

describe('group navigation UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the first Unicode grapheme and never an image avatar', async () => {
    await act(async () => {
      root.render(<GroupAvatar name="🇺🇦 Група" />);
    });

    expect(container.querySelector('[data-group-avatar]')?.textContent).toBe('🇺🇦');
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses a neutral glyph while a group name is temporarily unavailable', () => {
    expect(firstVisibleGrapheme(undefined)).toBe('—');
  });

  it('keeps all groups first and renders 99+ overflow', async () => {
    await act(async () => {
      root.render(
        <GroupList groups={[kitkat, allGroups]} scope={{ kind: 'all' }} onSelect={vi.fn()} />,
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-group-list-item]');
    expect(buttons[0].textContent).toContain('Всі групи');
    expect(buttons[1].textContent).toContain('99+');
    expect(buttons[1].getAttribute('aria-label')).toContain('128 непрочитаних');
  });

  it('exposes selected and unread state and delegates selection', async () => {
    const groups = [allGroups, kitkat];
    const onSelect = vi.fn();
    await act(async () => {
      root.render(<GroupList groups={groups} scope={{ kind: 'all' }} onSelect={onSelect} />);
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-group-list-item]');
    expect(buttons[0].getAttribute('aria-current')).toBe('true');
    expect(buttons[0].getAttribute('aria-label')).toContain('3 непрочитаних');
    buttons[1].click();

    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', masterKey: 'kitkat' });
    expect(groups).toEqual([allGroups, kitkat]);
  });

  it('closes on Escape and backdrop and restores focus to the island', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <GroupIsland
            group={kitkat}
            expanded={open}
            onOpen={() => setOpen(true)}
            buttonRef={triggerRef}
            panelId="test-groups"
          />
          <GroupPanel
            id="test-groups"
            open={open}
            groups={[allGroups, kitkat]}
            scope={{ kind: 'group', masterKey: 'kitkat' }}
            onSelect={vi.fn()}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
          />
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    const island = container.querySelector<HTMLButtonElement>('[data-group-island]')!;
    await act(async () => island.click());
    expect(container.querySelector('[data-group-panel]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-group-panel]')).toBeNull();
    expect(document.activeElement).toBe(island);

    await act(async () => island.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-group-panel-backdrop]')!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-group-panel]')).toBeNull();
    expect(document.activeElement).toBe(island);
  });

  it('truncates long names without removing the accessible full name', async () => {
    const longName = 'Надзвичайно довга назва групи для вузької колонки';
    await act(async () => {
      root.render(
        <GroupIsland group={{ ...kitkat, name: longName }} expanded={false} onOpen={vi.fn()} />,
      );
    });

    const island = container.querySelector<HTMLButtonElement>('[data-group-island]')!;
    expect(island.getAttribute('aria-label')).toContain(longName);
    expect(island.querySelector('[data-group-name]')?.getAttribute('title')).toBe(longName);
    expect(island.querySelector('[data-group-name]')?.className).toContain('group-navigation-name');
  });
});
