/**
 * Convert a snake_case string to camelCase.
 * e.g. "unit_ids" -> "unitIds", "created_at" -> "createdAt"
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Recursively transform an object/array from backend snake_case keys to frontend camelCase.
 * - Plain objects: keys are converted, values are processed recursively.
 * - Arrays: each element is processed recursively.
 * - Primitives, null, undefined: returned as-is.
 *
 * Use for API responses when the backend sends snake_case (e.g. Rust/Serde default)
 * and the frontend expects camelCase 
 */
export function snakeToCamelBody<T>(value: unknown): T {
  if (value === null || value === undefined) {
    return value as T;
  }
  if (typeof value !== 'object') {
    return value as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => snakeToCamelBody(item)) as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = toCamelCase(key);
    out[camelKey] = snakeToCamelBody(obj[key]);
  }
  return out as T;
}
