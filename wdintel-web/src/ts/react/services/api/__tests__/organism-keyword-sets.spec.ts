import { describe, expect, it } from 'vitest';

import { transformSnakeToCamel } from '../../../../snake-to-camel';

describe('organism keyword-set API compatibility', () => {
  // @test-scope parser: keyword-set ACL response normalization fixture
  it('transformSnakeToCamel maps ACL flags from API responses', () => {
    const dto = transformSnakeToCamel<OrganismKeywordSetDto>({
      id: 2,
      name: 'mine',
      words: ['небо'],
      author_login: 'alice',
      can_edit: true,
      can_delete: true,
    });
    expect(dto.canEdit).toBe(true);
    expect(dto.words).toEqual(['небо']);
  });
});
