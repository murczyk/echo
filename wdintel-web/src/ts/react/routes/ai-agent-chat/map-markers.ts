export type MarkerSignature = {
  id: string;
  signature: string;
};

export type MarkerSyncPlan = {
  keep: string[];
  update: string[];
  add: string[];
  remove: string[];
};

export function markerSignature(parts: Array<string | number | boolean | null>): string {
  return parts.map((part) => String(part ?? '')).join('\u001f');
}

export function planMarkerSync(
  existing: ReadonlyMap<string, string>,
  desired: readonly MarkerSignature[],
): MarkerSyncPlan {
  const next = new Map(desired.map((marker) => [marker.id, marker.signature]));
  const plan: MarkerSyncPlan = { keep: [], update: [], add: [], remove: [] };
  for (const [id, signature] of next) {
    const previous = existing.get(id);
    if (previous === undefined) plan.add.push(id);
    else if (previous === signature) plan.keep.push(id);
    else plan.update.push(id);
  }
  for (const id of existing.keys()) {
    if (!next.has(id)) plan.remove.push(id);
  }
  return plan;
}
