import { describe, expect, it } from 'vitest';
import type { AiAgentMapRecord } from '../../../../../Bindings';
import {
  describeSidc,
  joinSidc,
  searchSymbolTypes,
  sidcParts,
  symbolTypeOf,
} from '../app6d-catalog';
import { identityColor, isDrawableSidc, symbolImage } from '../map-symbol';
import { draftComponents } from '../SymbolEditor';
import { APP6D_CATALOG } from './app6d-catalog-fixture';

const record = (sidc: string): AiAgentMapRecord => ({
  id: sidc,
  sidc,
  name: 'Точка',
  observationDatetime: null,
  coordinateSystem: 'msk2000',
  platformType: 'CAPDOC',
  originalX: '1',
  originalY: '2',
  x: '1',
  y: '2',
  latitude: 47,
  longitude: 35,
  comments: [],
  sources: [],
  warnings: [],
});

describe('#3064 map symbols', () => {
  it('draws every identity of a SIDC with milsymbol and frames codes it rejects', () => {
    const friend = symbolImage('10031000001211020000');
    const hostile = symbolImage('10061000001211020000');
    expect(friend.url.startsWith('data:image/svg+xml')).toBe(true);
    expect(friend.url).not.toBe(hostile.url);
    expect(isDrawableSidc('10031000001211020000')).toBe(true);
    expect(isDrawableSidc('123')).toBe(false);
    expect(symbolImage('123').url).toContain(encodeURIComponent(identityColor('123')));
  });

  it('splits, joins and describes SIDCs with the generated catalog', () => {
    const sidc = '10061000141211020000';
    expect(joinSidc(sidcParts(sidc))).toBe(sidc);
    expect(describeSidc(APP6D_CATALOG, sidc)).toBe('Ворожий · Механізована піхота · Взвод');
    expect(symbolTypeOf(APP6D_CATALOG, '10061500001202000000').label).toBe('Танк');
  });

  it('finds symbol types by Ukrainian alias and by English catalog path', () => {
    expect(searchSymbolTypes(APP6D_CATALOG, 'fpv')[0]).toMatchObject({
      symbolSet: '01',
      entity: '110300',
      label: 'БпЛА',
    });
    expect(searchSymbolTypes(APP6D_CATALOG, 'howitzer').map((item) => item.entity)).toContain(
      '110900',
    );
  });

  it('sends only components that differ from the selection', () => {
    const records = [record('10061000141211020000'), record('10031000141211020000')];
    const keep = { identity: '', status: '', echelon: '', type: null };
    expect(draftComponents(keep, records)).toEqual({});
    expect(draftComponents({ ...keep, identity: '6' }, records)).toEqual({ identity: '6' });
    expect(draftComponents({ ...keep, echelon: '14' }, records)).toEqual({});
    const tank = searchSymbolTypes(APP6D_CATALOG, 'танк')[0];
    expect(draftComponents({ ...keep, type: tank }, records)).toEqual({
      symbolSet: '15',
      mainIcon: '120200',
      modifier1: '00',
      modifier2: '00',
    });
  });
});
