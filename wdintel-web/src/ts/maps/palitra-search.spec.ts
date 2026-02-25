import { describe, it, expect } from 'vitest';
import { labelMatchesTerm, parseSearchQuery, type SearchTerm } from './palitra-search';

describe('parseSearchQuery', () => {
  it('returns empty array for empty or whitespace-only query', () => {
    expect(parseSearchQuery('')).toEqual([]);
    expect(parseSearchQuery('   ')).toEqual([]);
    expect(parseSearchQuery('\t\n')).toEqual([]);
  });

  it('splits only by comma', () => {
    expect(parseSearchQuery('40')).toEqual([{ kind: 'exact', value: '40' }]);
    expect(parseSearchQuery('40,50')).toEqual([
      { kind: 'exact', value: '40' },
      { kind: 'exact', value: '50' },
    ]);
    expect(parseSearchQuery('40, 50 , красная 60 ')).toEqual([
      { kind: 'exact', value: '40' },
      { kind: 'exact', value: '50' },
      { kind: 'exact', value: 'красная 60' },
    ]);
  });

  it('keeps spaces inside a term (no split by space)', () => {
    expect(parseSearchQuery('40 50')).toEqual([{ kind: 'exact', value: '40 50' }]);
  });

  it('trims around commas and normalizes tokens to lowercase', () => {
    expect(parseSearchQuery('  AB ,  cd  ')).toEqual([
      { kind: 'exact', value: 'ab' },
      { kind: 'exact', value: 'cd' },
    ]);
  });

  it('parses prefix and suffix terms', () => {
    expect(parseSearchQuery('40*,*50')).toEqual([
      { kind: 'prefix', value: '40' },
      { kind: 'suffix', value: '50' },
    ]);
  });
});

describe('labelMatchesTerm', () => {
  it('exact: matches only when label equals term value', () => {
    const term: SearchTerm = { kind: 'exact', value: '40' };
    expect(labelMatchesTerm('40', term)).toBe(true);
    expect(labelMatchesTerm('400', term)).toBe(false);
    expect(labelMatchesTerm('540', term)).toBe(false);
    expect(labelMatchesTerm('4', term)).toBe(false);
  });

  it('prefix: matches when label starts with term value', () => {
    const term: SearchTerm = { kind: 'prefix', value: '40' };
    expect(labelMatchesTerm('40', term)).toBe(true);
    expect(labelMatchesTerm('400', term)).toBe(true);
    expect(labelMatchesTerm('401', term)).toBe(true);
    expect(labelMatchesTerm('540', term)).toBe(false);
    expect(labelMatchesTerm('4', term)).toBe(false);
  });

  it('suffix: matches when label ends with term value', () => {
    const term: SearchTerm = { kind: 'suffix', value: '40' };
    expect(labelMatchesTerm('40', term)).toBe(true);
    expect(labelMatchesTerm('540', term)).toBe(true);
    expect(labelMatchesTerm('840', term)).toBe(true);
    expect(labelMatchesTerm('400', term)).toBe(false);
    expect(labelMatchesTerm('4', term)).toBe(false);
  });
});
