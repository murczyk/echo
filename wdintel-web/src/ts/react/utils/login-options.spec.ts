import { describe, expect, it } from 'vitest';

import {
  buildLoginOptions,
  formatLoginIds,
  selectedLoginIds,
  selectLoginOptions,
} from './login-options';

describe('login options', () => {
  const options = buildLoginOptions([
    { id: 'id-b', login: 'Бета' },
    { id: 'id-a', login: 'Альфа' },
  ]);

  it('keeps UUID values while sorting and displaying login names', () => {
    expect(options).toEqual([
      { id: 'id-a', login: 'Альфа' },
      { id: 'id-b', login: 'Бета' },
    ]);
    expect(selectedLoginIds(options)).toEqual(['id-a', 'id-b']);
    expect(formatLoginIds(['id-b'], new Map(options.map((login) => [login.id, login])))).toBe(
      'Бета',
    );
  });

  it('preserves an existing unknown login UUID', () => {
    expect(selectLoginOptions(['missing-id'], options)).toEqual([
      { id: 'missing-id', login: 'missing-id' },
    ]);
  });
});
