/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from './client';
import { getUnitsList } from './units';

vi.mock('./client', () => ({
  postJson: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

describe('units API', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('encodes the units list request in snake_case', async () => {
    postJsonMock.mockResolvedValueOnce({
      units: [],
    });

    await getUnitsList();

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/units',
      {
        sort_by: null,
        after_unit_id: null,
        before_unit_id: null,
      },
    );
  });
});
