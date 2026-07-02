const PELENG_NO_DATA_LABEL = '—';

export type PelengLabelPoint = {
  lat: number;
  lng: number;
  freq?: string | null;
};

export type PelengLabelGroup<TPoint extends PelengLabelPoint = PelengLabelPoint> = {
  centroid: { lat: number; lng: number };
  points: TPoint[];
  uniqueFreqs: string[];
  pointsCount: number;
  knownFreqCount: number;
  displayKind: 'single-point' | 'single-freq-cluster' | 'multi-freq-cluster' | null;
  displayLabel: string | null;
};

type PelengLabelGroupFormatter<TPoint extends PelengLabelPoint> = (group: {
  centroid: { lat: number; lng: number };
  points: TPoint[];
  uniqueFreqs: string[];
}) => string;

type ProjectedPoint<TPoint extends PelengLabelPoint> = {
  point: TPoint;
  x: number;
  y: number;
  freq: string;
};

export function buildPelengLabelGroups<TPoint extends PelengLabelPoint>(
  points: TPoint[],
  projectPoint: (point: TPoint) => { x: number; y: number },
  maxDistancePx: number,
  labelFormatter?: PelengLabelGroupFormatter<TPoint>,
): PelengLabelGroup<TPoint>[] {
  if (points.length === 0) {
    return [];
  }

  const distanceThreshold = Math.max(0, maxDistancePx);
  const projectedPoints = points.map((point) => {
    const projected = projectPoint(point);
    return {
      point,
      x: projected.x,
      y: projected.y,
      freq: normalizePelengFreq(point.freq),
    };
  });
  const gridSize = Math.max(1, distanceThreshold || 1);
  const buckets = buildSpatialBuckets(projectedPoints, gridSize);
  const assigned = new Array(projectedPoints.length).fill(false);
  const groups: PelengLabelGroup<TPoint>[] = [];

  for (let index = 0; index < projectedPoints.length; index += 1) {
    if (assigned[index]) {
      continue;
    }

    const componentIndexes = collectClusterFromSeed({
      projectedPoints,
      buckets,
      seedIndex: index,
      maxDistancePx: distanceThreshold,
      gridSize,
      assigned,
    });
    const componentPoints = componentIndexes.map(
      (componentIndex) => projectedPoints[componentIndex].point,
    );
    const centroid = getCentroid(componentPoints);
    const uniqueFreqs = [
      ...new Set(componentIndexes.map((componentIndex) => projectedPoints[componentIndex].freq)),
    ].filter(isKnownPelengFreq);
    const pointsCount = componentPoints.length;
    const knownFreqCount = uniqueFreqs.length;
    const displayKind = getDisplayKind({ pointsCount, knownFreqCount });
    const defaultLabel = formatPelengLabel({
      points: componentPoints,
      uniqueFreqs,
    });

    groups.push({
      centroid,
      points: componentPoints,
      uniqueFreqs,
      pointsCount,
      knownFreqCount,
      displayKind,
      displayLabel:
        knownFreqCount === 0
          ? null
          : labelFormatter
            ? labelFormatter({
                centroid,
                points: componentPoints,
                uniqueFreqs,
              })
            : defaultLabel,
    });
  }

  return groups;
}

function buildSpatialBuckets<TPoint extends PelengLabelPoint>(
  points: ProjectedPoint<TPoint>[],
  gridSize: number,
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  points.forEach((point, index) => {
    const cell = getBucketCell(point.x, point.y, gridSize);
    const key = getCellKey(cell.x, cell.y);
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  });
  return buckets;
}

function collectClusterFromSeed<TPoint extends PelengLabelPoint>(params: {
  projectedPoints: ProjectedPoint<TPoint>[];
  buckets: Map<string, number[]>;
  seedIndex: number;
  maxDistancePx: number;
  gridSize: number;
  assigned: boolean[];
}): number[] {
  const { projectedPoints, buckets, seedIndex, maxDistancePx, gridSize, assigned } = params;
  const seed = projectedPoints[seedIndex];
  const clusterIndexes = [seedIndex];
  assigned[seedIndex] = true;

  for (const neighborIndex of getNeighborCandidateIndexes(seed.x, seed.y, buckets, gridSize)) {
    if (assigned[neighborIndex]) {
      continue;
    }

    const candidate = projectedPoints[neighborIndex];
    if (distanceBetween(seed, candidate) > maxDistancePx) {
      continue;
    }

    assigned[neighborIndex] = true;
    clusterIndexes.push(neighborIndex);
  }

  return clusterIndexes;
}

function getNeighborCandidateIndexes(
  x: number,
  y: number,
  buckets: Map<string, number[]>,
  gridSize: number,
): number[] {
  const baseCell = getBucketCell(x, y, gridSize);
  const indexes: number[] = [];

  for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      const bucket = buckets.get(getCellKey(baseCell.x + deltaX, baseCell.y + deltaY));
      if (!bucket) {
        continue;
      }
      indexes.push(...bucket);
    }
  }

  return indexes;
}

function getBucketCell(x: number, y: number, gridSize: number): { x: number; y: number } {
  return {
    x: Math.floor(x / gridSize),
    y: Math.floor(y / gridSize),
  };
}

function getCellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function distanceBetween<TPoint extends PelengLabelPoint>(
  left: ProjectedPoint<TPoint>,
  right: ProjectedPoint<TPoint>,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function getCentroid<TPoint extends PelengLabelPoint>(
  points: TPoint[],
): { lat: number; lng: number } {
  if (points.length === 0) {
    return { lat: 0, lng: 0 };
  }

  const sum = points.reduce(
    (accumulator, point) => ({
      lat: accumulator.lat + point.lat,
      lng: accumulator.lng + point.lng,
    }),
    { lat: 0, lng: 0 },
  );

  return {
    lat: sum.lat / points.length,
    lng: sum.lng / points.length,
  };
}

function formatPelengLabel(group: { points: PelengLabelPoint[]; uniqueFreqs: string[] }): string {
  if (group.points.length === 1) {
    return group.uniqueFreqs[0] ?? PELENG_NO_DATA_LABEL;
  }

  if (group.uniqueFreqs.length === 1) {
    return `${group.points.length} (${group.uniqueFreqs[0]})`;
  }

  return `${group.points.length} (${group.uniqueFreqs.length} частоти)`;
}

function normalizePelengFreq(freq?: string | null): string {
  const trimmed = freq?.trim() ?? '';
  return trimmed === '' ? PELENG_NO_DATA_LABEL : trimmed;
}

export function isKnownPelengFreq(freq: string): boolean {
  return freq !== PELENG_NO_DATA_LABEL;
}

function getDisplayKind(group: {
  pointsCount: number;
  knownFreqCount: number;
}): PelengLabelGroup['displayKind'] {
  if (group.knownFreqCount === 0) {
    return null;
  }

  if (group.pointsCount === 1) {
    return 'single-point';
  }

  return group.knownFreqCount === 1 ? 'single-freq-cluster' : 'multi-freq-cluster';
}
