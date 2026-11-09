// Turns the group names a model passes into Echo group keys, so a guessed value
// can never reach a search as a filter Echo cannot apply.

export const GROUP_LOOKUP_SKILL = "accessible_group_details";
export const GROUP_LOOKUP_BODY = { skip_group_stats: true };
const GROUP_CANDIDATE_LIMIT = 12;
const GROUP_SCOPE_DROPPED =
  "Invalid Echo tool arguments: this request already selected a group, so this read needs selectedGroups too. Keep the group the user named. To include other groups, name them in selectedGroups. If the group was not found, tell the user instead of reading other groups.";

export interface EchoGroup {
  master_key: string;
  name: string;
}

export interface GroupOutcome {
  problems?: string[];
  read?: string[];
}

export function groupCatalog(value: unknown): EchoGroup[] {
  if (!Array.isArray(value)) throw new Error("Echo group list is unavailable");
  const groups = new Map<string, EchoGroup>();
  for (const entry of value) {
    const { master_key, name } = (entry ?? {}) as Partial<EchoGroup>;
    if (typeof master_key === "string" && typeof name === "string")
      groups.set(master_key, { master_key, name });
  }
  return [...groups.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.master_key.localeCompare(right.master_key),
  );
}

function folded(value: string): string {
  return value.trim().toLocaleLowerCase("uk");
}

function groupKeys(groups: EchoGroup[]): string[] {
  return groups.map((group) => group.master_key);
}

function matchGroup(value: string, groups: EchoGroup[]): string[] | null {
  const byKey = groups.filter((group) => group.master_key === value);
  if (byKey.length > 0) return groupKeys(byKey);
  const byName = groups.filter((group) => group.name === value.trim());
  if (byName.length > 0) return groupKeys(byName);
  const similar = groups.filter((group) => folded(group.name) === folded(value));
  return new Set(similar.map((group) => group.name)).size === 1
    ? groupKeys(similar)
    : null;
}

function groupProblem(value: string, groups: EchoGroup[]): string {
  const names = groups
    .filter((group) => folded(group.name) === folded(value))
    .map((group) => group.name);
  return names.length > 0
    ? `Group ${JSON.stringify(value)} is ambiguous between ${JSON.stringify([...new Set(names)])}.`
    : `Group ${JSON.stringify(value)} is not among the accessible groups.`;
}

function groupCandidates(values: string[], groups: EchoGroup[]): string[] {
  const names = [...new Set(groups.map((group) => group.name))];
  const wanted = values.map(folded).filter(Boolean);
  const close = names.filter((name) =>
    wanted.some(
      (value) => folded(name).includes(value) || value.includes(folded(name)),
    ),
  );
  return [...new Set([...close, ...names])].slice(0, GROUP_CANDIDATE_LIMIT);
}

function unresolvedGroups(values: string[], groups: EchoGroup[]): string[] {
  return values.filter((value) => !matchGroup(value, groups));
}

export function resolveGroups(values: string[], groups: EchoGroup[]): string[] {
  const unresolved = unresolvedGroups(values, groups);
  if (unresolved.length > 0) {
    const problems = unresolved.map((value) => groupProblem(value, groups));
    throw new Error(
      `Invalid Echo tool arguments: ${problems.join(" ")} Accessible groups include ${JSON.stringify(groupCandidates(unresolved, groups))}. Retry with a listed name only if it is clearly the group the user meant; otherwise tell the user that group was not found. Never drop the group filter to work around this.`,
    );
  }
  return [...new Set(values.flatMap((value) => matchGroup(value, groups) ?? []))];
}

export function compactGroupCatalog(
  value: unknown,
  maxCharacters: number,
): string {
  const groups = groupCatalog(value);
  let items = groups;
  while (true) {
    const serialized = JSON.stringify(
      items.length < groups.length ? { items, truncated: true } : items,
    );
    if (serialized.length <= maxCharacters) return serialized;
    if (items.length === 0) return maxCharacters >= 2 ? "{}" : "";
    items = items.slice(0, Math.floor(items.length / 2));
  }
}

/**
 * Resolves selectedGroups once per request from one cached group list. A lookup
 * failure rejects the tool call: passing the raw value on would read as "no
 * messages" in a group that exists. Once a request selects a group, even one
 * that was rejected, a read that omits the selection is refused, because that
 * is how a scope gets silently dropped. Naming another group stays allowed, so
 * groups can be compared, and messageIds already pin a read to known messages.
 */
export function createGroupScope(
  loadGroups: ((signal?: AbortSignal) => Promise<unknown>) | null,
  rememberGroups: (groups: EchoGroup[]) => void,
  noteGroups: (outcome: GroupOutcome) => void = () => {},
) {
  let catalog: Promise<EchoGroup[]> | null = null;
  let scoped = false;
  const load = (read: NonNullable<typeof loadGroups>, signal?: AbortSignal) => {
    catalog ??= read(signal)
      .then(groupCatalog)
      .catch((error) => {
        catalog = null;
        throw error;
      });
    return catalog;
  };
  return {
    async resolve<T extends Record<string, unknown>>(
      params: T,
      acceptsGroups: boolean,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!loadGroups || !acceptsGroups) return params;
      const values = params.selectedGroups;
      if (!Array.isArray(values) || values.length === 0) {
        const pinned = Array.isArray(params.messageIds) && params.messageIds.length > 0;
        if (scoped && !pinned) throw new Error(GROUP_SCOPE_DROPPED);
        return params;
      }
      if (!values.every((value) => typeof value === "string")) return params;
      scoped = true;
      const groups = await load(loadGroups, signal);
      rememberGroups(groups);
      noteGroups({
        problems: unresolvedGroups(values, groups).map((value) => groupProblem(value, groups)),
      });
      const selected = resolveGroups(values, groups);
      noteGroups({
        read: groups
          .filter((group) => selected.includes(group.master_key))
          .map((group) => group.name),
      });
      return { ...params, selectedGroups: selected };
    },
  };
}
