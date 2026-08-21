/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import './unit-edit-dialog-element';

const UNIT = {
  id: 1,
  other: '',
  team_or_crew: '',
  section: '',
  squad: '',
  platoon: '',
  company: '1 рота',
  battalion: '',
  regiment: '',
  division: '',
  corps: '',
  army: '',
  military_district: '',
  army_region: '',
  comment: '',
  orbit_note: null,
  name: '1 рота',
  active: true,
  is_deduplicate_candidate: null,
  created_at: 0,
  created_by_login_id: '',
  has_orbit: false,
  orbit_unit_ids: [],
  orbit_unit_generative_names: [],
};

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
});

describe('unit-edit-dialog custom element', () => {
  it('preserves form edits when submitting state changes', async () => {
    const element = document.createElement('unit-edit-dialog');
    element.setAttribute('data-unit', JSON.stringify(UNIT));
    await act(async () => {
      document.body.appendChild(element);
      await Promise.resolve();
    });
    const companyInput = Array.from(document.querySelectorAll('input')).find(
      (input) => input.value === UNIT.company,
    );
    expect(companyInput).toBeDefined();
    await act(async () => {
      if (companyInput) {
        companyInput.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
          companyInput,
          '2 рота',
        );
        companyInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(companyInput?.value).toBe('2 рота');

    await act(async () => {
      element.setAttribute('data-submitting', 'true');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(companyInput?.isConnected).toBe(true);
    expect(companyInput?.value).toBe('2 рота');
  });
});
