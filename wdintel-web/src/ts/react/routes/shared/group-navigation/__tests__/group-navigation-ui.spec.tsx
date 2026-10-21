/**
 * @vitest-environment happy-dom
 */
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTheme, ThemeProvider } from '@mui/material/styles';
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
};

const kitkat: GroupNavigationItem = {
  kind: 'group',
  masterKey: 'kitkat',
  name: 'KitKat',
  colorKey: 'deep_purple',
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

  it('uses the persisted palette color and a readable foreground', async () => {
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
          <GroupAvatar name="KitKat" colorKey="deep_purple" />
        </ThemeProvider>,
      );
    });

    const avatar = container.querySelector<HTMLElement>('[data-group-avatar]');
    expect(avatar?.style.backgroundColor).toBe('#7e57c2');
    expect(avatar?.style.color).not.toBe('');
  });

  it('falls back to the neutral theme avatar for an unknown color', async () => {
    const theme = createTheme({ palette: { action: { selected: '#334455' } } });
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <GroupAvatar name="KitKat" colorKey={'future_color' as 'blue'} />
        </ThemeProvider>,
      );
    });

    expect(container.querySelector<HTMLElement>('[data-group-avatar]')?.style.backgroundColor).toBe(
      '#334455',
    );
  });

  it('renders the Material group icon for the all-groups avatar', async () => {
    const theme = createTheme({
      palette: {
        background: { default: '#123456' },
        text: { primary: '#abcdef' },
      },
    });
    await act(async () => {
      root.render(
        <ThemeProvider theme={theme}>
          <GroupAvatar kind="all" name="Всі групи" />
        </ThemeProvider>,
      );
    });

    const avatar = container.querySelector<HTMLElement>('[data-group-avatar]');
    expect(container.querySelector('[data-testid="GroupOutlinedIcon"]')).not.toBeNull();
    expect(avatar?.textContent).toBe('');
    expect(avatar?.style.backgroundColor).toBe('#123456');
    expect(avatar?.style.color).toBe('#abcdef');
  });

  it('uses a neutral glyph while a group name is temporarily unavailable', () => {
    expect(firstVisibleGrapheme(undefined)).toBe('—');
  });

  it('keeps all groups first', async () => {
    await act(async () => {
      root.render(
        <GroupList groups={[kitkat, allGroups]} scope={{ kind: 'all' }} onSelect={vi.fn()} />,
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-group-list-item]');
    expect(buttons[0].textContent).toContain('Всі групи');
    expect(buttons[1].getAttribute('aria-label')).toBe('KitKat');
    expect(container.querySelector('[data-group-unread]')).toBeNull();
  });

  it('owns the shared list title and accessible label', async () => {
    await act(async () => {
      root.render(
        <GroupList
          groups={[allGroups, kitkat]}
          scope={{ kind: 'all' }}
          onSelect={vi.fn()}
          title="Групи"
          titleId="shared-groups-title"
        />,
      );
    });

    const title = container.querySelector('[data-group-list-title]');
    expect(title?.textContent).toBe('Групи');
    expect(title?.id).toBe('shared-groups-title');
    expect(container.querySelector('nav')?.getAttribute('aria-labelledby')).toBe(
      'shared-groups-title',
    );
  });

  it('exposes selected state and delegates selection', async () => {
    const groups = [allGroups, kitkat];
    const onSelect = vi.fn();
    await act(async () => {
      root.render(<GroupList groups={groups} scope={{ kind: 'all' }} onSelect={onSelect} />);
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-group-list-item]');
    expect(buttons[0].getAttribute('aria-current')).toBe('true');
    expect(buttons[0].getAttribute('aria-label')).toBe('Всі групи');
    buttons[1].click();

    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', masterKey: 'kitkat' });
    expect(groups).toEqual([allGroups, kitkat]);
  });

  it('closes on Escape and outside click without rendering a modal backdrop', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Групи
          </button>
          <GroupPanel
            id="test-groups"
            open={open}
            groups={[allGroups, kitkat]}
            scope={{ kind: 'group', masterKey: 'kitkat' }}
            onSelect={vi.fn()}
            onClose={() => setOpen(false)}
            triggerRef={triggerRef}
          />
          <button type="button">Повідомлення</button>
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => trigger.click());
    const panel = container.querySelector('[data-group-panel]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBeNull();
    expect(container.querySelector('[data-group-panel-backdrop]')).toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-group-panel]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    await act(async () => {
      const outside = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Повідомлення',
      )!;
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-group-panel]')).toBeNull();
  });

  it('truncates long names without removing the accessible full name', async () => {
    const longName = 'Надзвичайно довга назва групи для вузької колонки';
    await act(async () => {
      root.render(<GroupIsland group={{ ...kitkat, name: longName }} />);
    });

    const island = container.querySelector<HTMLElement>('[data-group-island]')!;
    expect(island.textContent).toContain(longName);
    expect(island.querySelector('[data-group-name]')?.getAttribute('title')).toBe(longName);
    expect(island.querySelector('[data-group-name]')?.className).toContain('group-navigation-name');
  });

  it('renders the current group island as non-interactive context', async () => {
    await act(async () => {
      root.render(<GroupIsland group={kitkat} />);
    });

    const island = container.querySelector<HTMLElement>('[data-group-island]')!;
    expect(island.tagName).toBe('DIV');
    expect(island.closest('button')).toBeNull();
  });
});
