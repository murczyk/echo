/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuleExpression } from '../../../../Bindings';
import { RuleExpressionEditor } from './RuleExpressionEditor';

let container: HTMLDivElement;
let root: Root;

function buttonWithText(text: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

function enabledButtonWithAriaLabel(label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => !button.disabled && button.getAttribute('aria-label') === label,
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('RuleExpressionEditor', () => {
  it('creates a usable match condition from an empty rule', () => {
    const onChange = vi.fn();
    act(() => root.render(<RuleExpressionEditor expression={null} onChange={onChange} />));

    const addButton = buttonWithText('Додати правило');
    expect(addButton).toBeDefined();
    act(() => addButton?.click());

    expect(onChange).toHaveBeenCalledWith({
      match: {
        field: 'file_name',
        matcher: 'contains',
        values: [''],
      },
    });
  });

  it('adds nested conditions while preserving the current boolean group', () => {
    const onChange = vi.fn();
    const expression: RuleExpression = {
      all: {
        children: [
          {
            match: {
              field: 'full_path',
              matcher: 'regex',
              values: ['\\.pdf$'],
            },
          },
        ],
      },
    };

    act(() => root.render(<RuleExpressionEditor expression={expression} onChange={onChange} />));

    expect(container.querySelector('[role="combobox"][aria-label="Поле файла"]')).not.toBeNull();
    const addCondition = buttonWithText('Додати умову');
    expect(addCondition).toBeDefined();
    act(() => addCondition?.click());

    expect(onChange).toHaveBeenCalledWith({
      all: {
        children: [
          expression.all.children[0],
          {
            match: {
              field: 'file_name',
              matcher: 'contains',
              values: [''],
            },
          },
        ],
      },
    });
  });

  it('reorders sibling nodes through keyboard-focusable controls', () => {
    const onChange = vi.fn();
    const first: RuleExpression = {
      match: { field: 'file_name', matcher: 'contains', values: ['first'] },
    };
    const second: RuleExpression = {
      match: { field: 'full_path', matcher: 'contains', values: ['second'] },
    };
    const expression: RuleExpression = { any: { children: [first, second] } };

    act(() => root.render(<RuleExpressionEditor expression={expression} onChange={onChange} />));

    const moveUp = enabledButtonWithAriaLabel('Перемістити вузол правила вище');
    expect(moveUp).toBeDefined();
    expect(moveUp?.getAttribute('aria-label')).toBe('Перемістити вузол правила вище');
    act(() => moveUp?.click());

    expect(onChange).toHaveBeenCalledWith({ any: { children: [second, first] } });
  });
});
