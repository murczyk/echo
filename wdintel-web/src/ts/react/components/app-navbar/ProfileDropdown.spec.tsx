/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileDropdown } from './ProfileDropdown';

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
});

function renderComponent(props: any) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ProfileDropdown {...props} />);
  });

  return { container, root };
}

describe('ProfileDropdown', () => {
  const defaultProps = {
    user: { name: 'Test User' },
    shared: { themeMode: 'light' },
    isBasic: false,
    openDropdown: null,
    setOpenDropdown: vi.fn(),
    onThemeChange: vi.fn(),
    onLogout: vi.fn(),
    handleInternalLinkClick: vi.fn(),
    closeDropdowns: vi.fn(),
  };

  it('renders user name', () => {
    const { container } = renderComponent(defaultProps);
    expect(container.textContent).toContain('Test User');
  });

  it('toggles dropdown on click', () => {
    const setOpenDropdown = vi.fn();
    const { container } = renderComponent({ ...defaultProps, setOpenDropdown });

    const button = container.querySelector('button');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setOpenDropdown).toHaveBeenCalledWith('profile');
  });

  it('closes dropdown if already open', () => {
    const setOpenDropdown = vi.fn();
    const { container } = renderComponent({
      ...defaultProps,
      openDropdown: 'profile',
      setOpenDropdown,
    });

    const button = container.querySelector('button');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setOpenDropdown).toHaveBeenCalledWith(null);
  });

  it('calls onThemeChange when theme button clicked', () => {
    const onThemeChange = vi.fn();
    const closeDropdowns = vi.fn();
    const { container } = renderComponent({
      ...defaultProps,
      openDropdown: 'profile',
      shared: { themeMode: 'light' },
      onThemeChange,
      closeDropdowns,
    });

    const themeBtn = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Темна тема'),
    );
    expect(themeBtn).not.toBeUndefined();

    act(() => {
      themeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onThemeChange).toHaveBeenCalledWith('dark');
    expect(closeDropdowns).toHaveBeenCalled();
  });

  it('calls onLogout when logout button clicked', () => {
    const onLogout = vi.fn();
    const closeDropdowns = vi.fn();
    const { container } = renderComponent({
      ...defaultProps,
      openDropdown: 'profile',
      onLogout,
      closeDropdowns,
    });

    const logoutBtn = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Вийти'),
    );

    act(() => {
      logoutBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onLogout).toHaveBeenCalled();
    expect(closeDropdowns).toHaveBeenCalled();
  });

  it('shows settings when isBasic is true', () => {
    const handleInternalLinkClick = vi.fn();
    const { container } = renderComponent({
      ...defaultProps,
      openDropdown: 'profile',
      isBasic: true,
      handleInternalLinkClick,
    });

    const settingsBtn = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Налаштування'),
    );
    expect(settingsBtn).not.toBeUndefined();

    act(() => {
      settingsBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(handleInternalLinkClick).toHaveBeenCalled();
  });

  it('hides settings when isBasic is false', () => {
    const { container } = renderComponent({
      ...defaultProps,
      openDropdown: 'profile',
      isBasic: false,
    });

    const settingsBtn = Array.from(container.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('Налаштування'),
    );
    expect(settingsBtn).toBeUndefined();
  });
});
