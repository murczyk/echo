import { describe, expect, it } from 'vitest';

import type { OrganismKeywordSetDto } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';

import {
  ORGANISM_KEYWORD_SET_DEFAULT_DISPLAY_NAME,
  defaultKeywordSetId,
  keywordSetDisplayName,
  resolveKeywordSetId,
} from './organism-keyword-sets';

function mkSet(partial: Partial<OrganismKeywordSetDto> & { id: number }): OrganismKeywordSetDto {
  return {
    id: partial.id,
    name: partial.name ?? 'custom',
    words: partial.words ?? [],
    authorLogin: partial.authorLogin ?? 'alice',
    isSystemDefault: partial.isSystemDefault ?? false,
    canEdit: partial.canEdit ?? true,
    canDelete: partial.canDelete ?? true,
  };
}

describe('organism-keyword-sets helpers', () => {
  const sets = [
    mkSet({ id: 1, name: 'default', isSystemDefault: true, authorLogin: null, canDelete: false }),
    mkSet({ id: 2, name: 'mine', authorLogin: 'alice' }),
    mkSet({ id: 3, name: 'other', authorLogin: 'bob', canEdit: false, canDelete: false }),
  ];

  it('keywordSetDisplayName shows Ukrainian label for default set', () => {
    expect(keywordSetDisplayName(sets[0])).toBe(ORGANISM_KEYWORD_SET_DEFAULT_DISPLAY_NAME);
    expect(keywordSetDisplayName(sets[1])).toBe('mine');
  });

  it('defaultKeywordSetId returns system default id', () => {
    expect(defaultKeywordSetId(sets)).toBe(1);
    expect(defaultKeywordSetId([])).toBeNull();
  });

  it('resolveKeywordSetId falls back to default when missing or unknown', () => {
    expect(resolveKeywordSetId(sets, null)).toBe(1);
    expect(resolveKeywordSetId(sets, undefined)).toBe(1);
    expect(resolveKeywordSetId(sets, 999)).toBe(1);
    expect(resolveKeywordSetId(sets, 2)).toBe(2);
  });

  it('transformSnakeToCamel maps ACL flags from API responses', () => {
    const dto = transformSnakeToCamel<OrganismKeywordSetDto>({
      id: 2,
      name: 'mine',
      words: ['небо'],
      author_login: 'alice',
      is_system_default: false,
      can_edit: true,
      can_delete: true,
    });
    expect(dto.canEdit).toBe(true);
    expect(dto.isSystemDefault).toBe(false);
    expect(dto.words).toEqual(['небо']);
  });
});
