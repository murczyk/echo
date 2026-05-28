import { describe, expect, it } from 'vitest';

import type { OrganismKeywordSetDto } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';

import {
  ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX,
  keywordSetDisplayName,
  resolveKeywordSetId,
  suggestNewKeywordSetName,
} from './organism-keyword-sets';

function mkSet(partial: Partial<OrganismKeywordSetDto> & { id: number }): OrganismKeywordSetDto {
  return {
    id: partial.id,
    name: partial.name ?? 'custom',
    words: partial.words ?? [],
    authorLogin: partial.authorLogin ?? 'alice',
    canEdit: partial.canEdit ?? true,
    canDelete: partial.canDelete ?? true,
  };
}

describe('organism-keyword-sets helpers', () => {
  const sets = [
    mkSet({ id: 1, name: 'alpha' }),
    mkSet({ id: 2, name: 'mine', authorLogin: 'alice' }),
    mkSet({ id: 3, name: 'other', authorLogin: 'bob', canEdit: false, canDelete: false }),
  ];

  it('keywordSetDisplayName returns set name', () => {
    expect(keywordSetDisplayName(sets[0])).toBe('alpha');
    expect(keywordSetDisplayName(sets[1])).toBe('mine');
  });

  it('suggestNewKeywordSetName picks first free numbered name', () => {
    expect(suggestNewKeywordSetName([])).toBe(ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX);
    expect(suggestNewKeywordSetName([mkSet({ id: 2, name: ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX })])).toBe(
      `${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} 2`,
    );
    expect(
      suggestNewKeywordSetName([
        mkSet({ id: 2, name: ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX }),
        mkSet({ id: 3, name: `${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} 2` }),
      ]),
    ).toBe(`${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} 3`);
    expect(
      suggestNewKeywordSetName([
        mkSet({ id: 2, name: ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX }),
        mkSet({ id: 4, name: `${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} 3` }),
      ]),
    ).toBe(`${ORGANISM_KEYWORD_SET_NEW_NAME_PREFIX} 2`);
  });

  it('resolveKeywordSetId returns id only when present in list', () => {
    expect(resolveKeywordSetId(sets, null)).toBeNull();
    expect(resolveKeywordSetId(sets, undefined)).toBeNull();
    expect(resolveKeywordSetId(sets, 999)).toBeNull();
    expect(resolveKeywordSetId(sets, 2)).toBe(2);
  });

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
