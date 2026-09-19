// @test-scope parser: battle-line state response normalization fixture
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBattleLineState } from '../battle-line';

afterEach(() => vi.unstubAllGlobals());

describe('battle-line API', () => {
  it('normalizes state responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            active_version: {
              id: 1,
              source_file_name: 'line.kml',
              uploader_login: 'admin',
              uploaded_at_ts: 10,
              retired_at_ts: null,
            },
            active_features: [],
            aor_geometries: [],
            previous_versions: [],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(fetchBattleLineState()).resolves.toMatchObject({
      activeVersion: { sourceFileName: 'line.kml' },
    });
  });
});
