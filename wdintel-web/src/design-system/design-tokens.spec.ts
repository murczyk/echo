/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { afterEach, describe, expect, it } from 'vitest';

import { designTokens } from './design-tokens';

const generatedCss = readFileSync(
  resolve(process.cwd(), 'src/styles/_design-tokens.generated.css'),
  'utf8',
);
const legacyVariablesCss = readFileSync(
  resolve(process.cwd(), 'src/styles/_variables.css'),
  'utf8',
);

describe('generated design tokens', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-bs-theme');
    document.head.querySelector('[data-testid="echo-design-tokens"]')?.remove();
    document.head.querySelector('[data-testid="echo-legacy-variables"]')?.remove();
  });

  it('contains the required light and dark semantic palettes', () => {
    expect(designTokens.color.light).toMatchObject({
      background: '#eff0f1',
      borderSelected: '#d3871d',
      primary: '#2c6c91',
      text: '#000000',
    });
    expect(designTokens.color.dark).toMatchObject({
      background: '#1f1f1f',
      borderSelected: '#bc8c56',
      primary: '#93cdf6',
      text: '#ffffff',
    });
  });

  it('compiles representative Echo utilities and resolves mode-specific variables', async () => {
    const style = document.createElement('style');
    style.dataset.testid = 'echo-design-tokens';
    style.textContent = generatedCss;
    document.head.append(style);
    const legacyStyle = document.createElement('style');
    legacyStyle.dataset.testid = 'echo-legacy-variables';
    legacyStyle.textContent = legacyVariablesCss;
    document.head.append(legacyStyle);

    expect(generatedCss).toContain('--spacing-echo-sm: var(--echo-spacing-sm);');
    expect(generatedCss).toContain('--spacing-echo-control-md: var(--echo-size-control-md);');
    expect(generatedCss).toContain('--color-echo-surface: var(--echo-color-surface);');
    expect(generatedCss).toContain('--breakpoint-echo-md: 768px;');
    expect(legacyVariablesCss).toContain(
      '--border-selected-color: var(--echo-color-border-selected);',
    );
    const compiler = await compile(`@import "tailwindcss";\n${generatedCss}`, {
      base: process.cwd(),
      loadStylesheet: async (id, from) => {
        const path =
          id === 'tailwindcss'
            ? resolve(process.cwd(), 'node_modules/tailwindcss/index.css')
            : resolve(from, id);
        return { content: readFileSync(path, 'utf8'), base: dirname(path) };
      },
    });
    const utilities = compiler.build([
      'gap-echo-sm',
      'p-echo-lg',
      'h-echo-control-md',
      'size-echo-icon-sm',
      'rounded-echo-md',
      'text-echo-sm',
      'bg-echo-surface',
      'text-echo-text',
      'border-echo-border',
      'echo-md:grid-cols-2',
    ]);

    expect(utilities).toContain('.gap-echo-sm');
    expect(utilities).toContain('.echo-md\\:grid-cols-2');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--echo-color-background').trim(),
    ).toBe('#eff0f1');
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--echo-color-border-selected')
        .trim(),
    ).toBe('#d3871d');
    expect(readLegacySelectedBorderColor()).toBe('#d3871d');

    document.documentElement.setAttribute('data-bs-theme', 'dark');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--echo-color-background').trim(),
    ).toBe('#1f1f1f');
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--echo-color-border-selected')
        .trim(),
    ).toBe('#bc8c56');
    expect(readLegacySelectedBorderColor()).toBe('#bc8c56');
  });
});

function readLegacySelectedBorderColor() {
  const probe = document.createElement('div');
  probe.style.borderColor = 'var(--border-selected-color)';
  document.body.append(probe);
  const borderColor = getComputedStyle(probe).borderColor;
  probe.remove();
  return borderColor;
}
