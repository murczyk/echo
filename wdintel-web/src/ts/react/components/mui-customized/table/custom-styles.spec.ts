/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { getDefaultMrtContainerProps, getDefaultMrtPaperProps } from './custom-styles';

describe('getDefaultMrtPaperProps', () => {
  it('leaves watermark resolution to the shared observer', () => {
    document.body.innerHTML = `
      <div class="app-shell" data-auth-user-name="anonymous"></div>
      <div class="app-shell" data-auth-user-name=""></div>
      <div class="app-shell" data-auth-user-name="Test User"></div>
    `;

    const paperProps = getDefaultMrtPaperProps({
      table: {
        getState: () => ({ showSkeletons: false, isFullScreen: false }),
      } as any,
      layout: 'list',
    });

    expect(paperProps['data-table-watermark']).toBe('');
    expect((paperProps as { sx?: Record<string, unknown> }).sx).toMatchObject({
      height: 'auto',
      minHeight: 320,
    });
  });
});

describe('getDefaultMrtContainerProps', () => {
  it('keeps list layout non-workspace-like', () => {
    const containerProps = getDefaultMrtContainerProps({
      loading: false,
      layout: 'list',
      fullScreen: false,
      hasRows: true,
    });

    expect((containerProps as { sx?: Record<string, unknown> }).sx).toMatchObject({
      height: 'clamp(320px, 48vh, 560px)',
      minHeight: 320,
      maxHeight: 560,
      overflowX: 'auto',
      overflowY: 'auto',
    });
  });

  it('hides vertical overflow for empty list tables', () => {
    const containerProps = getDefaultMrtContainerProps({
      loading: false,
      layout: 'list',
      fullScreen: false,
      hasRows: false,
    });

    expect((containerProps as { sx?: Record<string, unknown> }).sx).toMatchObject({
      height: 'clamp(320px, 48vh, 560px)',
      minHeight: 320,
      maxHeight: 560,
      overflowX: 'auto',
      overflowY: 'hidden',
    });
  });

  it('keeps workspace layout scrollable', () => {
    const containerProps = getDefaultMrtContainerProps({
      loading: false,
      layout: 'workspace',
      fullScreen: false,
    });

    expect((containerProps as { sx?: Record<string, unknown> }).sx).toMatchObject({
      height: '100%',
      minHeight: 0,
      maxHeight: '100%',
      overflowX: 'auto',
      overflowY: 'auto',
    });
  });
});
