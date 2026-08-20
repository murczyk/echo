import type { Login, Organism, SignalGroupLogin } from '../../../../Bindings';

export type ZoneGroupAccessItem =
  { kind: 'user'; id: string; label: string } | { kind: 'organism'; id: number; label: string };

export function buildAccessItems(
  users: string[] | null | undefined,
  userDetails: SignalGroupLogin[] | null | undefined,
  organismIds: number[] | null | undefined,
  organismById: Map<number, Organism>,
  loginById: Map<string, Login>,
): ZoneGroupAccessItem[] {
  const detailsById = new Map((userDetails ?? []).map((detail) => [detail.loginId, detail]));
  return [
    ...(users ?? []).map((id) => ({
      kind: 'user' as const,
      id,
      label: `Користувач: ${detailsById.get(id)?.login ?? loginById.get(id)?.login ?? id}`,
    })),
    ...(organismIds ?? []).map((id) => ({
      kind: 'organism' as const,
      id,
      label: `Організм: ${organismById.get(id)?.name || `#${id}`}`,
    })),
  ];
}
