import type {
  AiAgentMapEditTarget,
  AiAgentMapPatchOp,
  AiAgentMapSidcComponents,
  AiAgentMapSummary,
} from '../../../../Bindings';

export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function operation(op: string, patch: Partial<AiAgentMapPatchOp>): AiAgentMapPatchOp {
  return {
    op,
    selector: null,
    record: null,
    fields: null,
    components: null,
    sidc: null,
    title: null,
    ...patch,
  };
}

function idsSelector(ids: string[]) {
  return { ids, names: [], sidc: null, all: false, expect: 'many' };
}

export function removeOperation(ids: string[]): AiAgentMapPatchOp {
  return operation('remove', { selector: idsSelector(ids) });
}

export function titleOperation(title: string): AiAgentMapPatchOp {
  return operation('setTitle', { title });
}

export const EMPTY_COMPONENTS: AiAgentMapSidcComponents = {
  group1: null,
  context: null,
  identity: null,
  symbolSet: null,
  status: null,
  headquartersOrTaskForce: null,
  echelon: null,
  mainIcon: null,
  modifier1: null,
  modifier2: null,
};

/** Changes only the given SIDC components of every selected record. */
export function componentsOperation(
  ids: string[],
  components: Partial<AiAgentMapSidcComponents>,
): AiAgentMapPatchOp {
  return operation('setComponents', {
    selector: idsSelector(ids),
    components: { ...EMPTY_COMPONENTS, ...components },
  });
}

export function editingTarget(
  summary: Pick<AiAgentMapSummary, 'requestId' | 'id'>,
  revision: number,
  selectedPointIds: string[],
): AiAgentMapEditTarget {
  return { requestId: summary.requestId, mapId: summary.id, revision, selectedPointIds };
}

export function originLabel(origin: string): string {
  if (origin === 'agent') return 'ШІ';
  if (origin === 'user') return 'Ви';
  return 'Публікація';
}
