/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangelogDropdown } from './ChangelogDropdown';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
  vi.useRealTimers();
});

function renderComponent(props: any) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ChangelogDropdown {...props} />);
  });

  rendered.push({ container, root });
  return { container, root };
}

describe('ChangelogDropdown', () => {
  const defaultShared = {
    changelogPreview: {
      preview: ['Fix 1', 'Feature 2'],
      version: '1-0-0',
      fullUrl: 'http://example.com/changelog',
    },
    userLoaded: true,
    changelogLastSeenLoaded: true,
    changelogLastSeen: '0-9-0',
  };

  it('renders nothing if changelogPreview is missing or empty', () => {
    const { container } = renderComponent({
      shared: {},
      openDropdown: null,
      setOpenDropdown: vi.fn(),
      onOpenChangelog: vi.fn(),
    });
    expect(container.innerHTML).toBe('');
  });

  it('shows and opens the deployment maintenance notice once per maintenance', () => {
    vi.useFakeTimers();
    const setOpenDropdown = vi.fn();
    const props = {
      shared: {
        deploymentMaintenance: { id: 'deploy-1', remaining_ms: 60000 },
      },
      openDropdown: null,
      setOpenDropdown,
      onOpenChangelog: vi.fn(),
    };
    const { container, root } = renderComponent(props);

    expect(setOpenDropdown).toHaveBeenCalledTimes(1);
    expect(setOpenDropdown).toHaveBeenCalledWith('changelog');
    expect(container.querySelector('.bi-cone-striped')).not.toBeNull();

    act(() => {
      root.render(<ChangelogDropdown {...props} openDropdown="changelog" />);
    });
    expect(container.textContent).toContain('відбувається оновлення системи...');
    expect(container.querySelector('[data-testid="construction-emoji"]')?.textContent).toBe('🚧');

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(container.querySelector('[data-testid="construction-emoji"]')?.textContent).toBe('👷');

    act(() => {
      container
        .querySelector('button[aria-label="Закрити сповіщення"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      root.render(<ChangelogDropdown {...props} openDropdown={null} />);
    });

    expect(setOpenDropdown).toHaveBeenLastCalledWith(null);
    expect(setOpenDropdown).toHaveBeenCalledTimes(2);
  });

  it('closes an open maintenance notice when the deployment window ends', () => {
    const setOpenDropdown = vi.fn();
    const { root } = renderComponent({
      shared: {
        deploymentMaintenance: { id: 'deploy-1', remaining_ms: 60000 },
      },
      openDropdown: 'changelog',
      setOpenDropdown,
      onOpenChangelog: vi.fn(),
    });

    act(() => {
      root.render(
        <ChangelogDropdown
          shared={{}}
          openDropdown="changelog"
          setOpenDropdown={setOpenDropdown}
          onOpenChangelog={vi.fn()}
        />,
      );
    });

    expect(setOpenDropdown).toHaveBeenLastCalledWith(null);
  });

  it('shows unseen badge when changelogLastSeen does not match version', () => {
    const { container } = renderComponent({
      shared: defaultShared,
      openDropdown: null,
      setOpenDropdown: vi.fn(),
      onOpenChangelog: vi.fn(),
    });

    // Check if the orange badge is present (has bg-orange-400 class)
    const badge = container.querySelector('.bg-orange-400');
    expect(badge).not.toBeNull();
  });

  it('hides unseen badge when changelogLastSeen matches version', () => {
    const { container } = renderComponent({
      shared: { ...defaultShared, changelogLastSeen: '1-0-0' },
      openDropdown: null,
      setOpenDropdown: vi.fn(),
      onOpenChangelog: vi.fn(),
    });

    const badge = container.querySelector('.bg-orange-400');
    expect(badge).toBeNull();
  });

  it('calls onOpenChangelog and setOpenDropdown when clicking bell with unseen changes', () => {
    const onOpenChangelog = vi.fn();
    const setOpenDropdown = vi.fn();

    const { container } = renderComponent({
      shared: defaultShared,
      openDropdown: null,
      setOpenDropdown,
      onOpenChangelog,
    });

    const button = container.querySelector('button');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenChangelog).toHaveBeenCalledWith('1-0-0');
    expect(setOpenDropdown).toHaveBeenCalledWith('changelog');
  });

  it('only calls setOpenDropdown when clicking bell with no unseen changes', () => {
    const onOpenChangelog = vi.fn();
    const setOpenDropdown = vi.fn();

    const { container } = renderComponent({
      shared: { ...defaultShared, changelogLastSeen: '1-0-0' },
      openDropdown: null,
      setOpenDropdown,
      onOpenChangelog,
    });

    const button = container.querySelector('button');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenChangelog).not.toHaveBeenCalled();
    expect(setOpenDropdown).toHaveBeenCalledWith('changelog');
  });

  it('renders dropdown content correctly when open', () => {
    const { container } = renderComponent({
      shared: defaultShared,
      openDropdown: 'changelog', // It's open
      setOpenDropdown: vi.fn(),
      onOpenChangelog: vi.fn(),
    });

    // Check if it displays the preview items
    expect(container.textContent).toContain('Fix 1');
    expect(container.textContent).toContain('Feature 2');
    expect(container.textContent).toContain('Реліз 1.0.0');

    // Check if link is correct
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('http://example.com/changelog');
  });
});
