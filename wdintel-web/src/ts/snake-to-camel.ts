/**
 * Convert a snake_case string to camelCase.
 * e.g. "unit_ids" -> "unitIds", "created_at" -> "createdAt"
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Convert a camelCase string to snake_case.
 * e.g. "unitIds" -> "unit_ids", "createdAt" -> "created_at"
 */
export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, (_, letter) => `_${letter.toLowerCase()}`);
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
export function transformSnakeToCamel<T>(value: unknown): T {
  if (value === null || value === undefined) {
    return value as T;
  }
  if (typeof value !== 'object') {
    return value as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformSnakeToCamel(item)) as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = toCamelCase(key);
    out[camelKey] = transformSnakeToCamel(obj[key]);
  }
  return out as T;
}

/**
 * Recursively transform an object/array from frontend camelCase keys to backend snake_case.
 * - Plain objects: keys are converted, values are processed recursively.
 * - Arrays: each element is processed recursively.
 * - Primitives, null, undefined: returned as-is.
 *
 * Use for API request bodies when the frontend uses camelCase and the backend expects
 * snake_case (e.g. Rust/Serde default).
 */
export function transformCamelToSnake<T>(value: unknown): T {
  if (value === null || value === undefined) {
    return value as T;
  }
  if (typeof value !== 'object') {
    return value as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformCamelToSnake(item)) as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const snakeKey = toSnakeCase(key);
    out[snakeKey] = transformCamelToSnake(obj[key]);
  }
  return out as T;
}
