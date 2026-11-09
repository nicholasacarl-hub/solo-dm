/**
 * Dotted paths into a record's data ("hp", "speeds.walk", "features.2.text"), read and written
 * immutably. Setting `undefined` removes the key, so optional fields stay absent rather than null.
 */

type Container = Record<string, unknown> | unknown[];

const isIndex = (key: string) => /^\d+$/.test(key);

export function getPath(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

export function setPath<T>(value: T, path: string, next: unknown): T {
  const keys = path.split('.');
  const write = (node: unknown, i: number): unknown => {
    const key = keys[i];
    const base: Container =
      Array.isArray(node) ? [...node] : node !== null && typeof node === 'object' ? { ...(node as Record<string, unknown>) } : isIndex(key) ? [] : {};
    if (i === keys.length - 1) {
      if (Array.isArray(base)) {
        if (next === undefined) base.splice(Number(key), 1);
        else base[Number(key)] = next;
      } else if (next === undefined) delete base[key];
      else base[key] = next;
      return base;
    }
    const child = Array.isArray(base) ? base[Number(key)] : base[key];
    const written = write(child, i + 1);
    if (Array.isArray(base)) base[Number(key)] = written;
    else base[key] = written;
    return base;
  };
  return write(value, 0) as T;
}

/** True when a field at `path` is named by `checks` (the field itself, a parent, or a part of it). */
export function isNamed(checks: ReadonlySet<string>, path: string): boolean {
  for (const c of checks) {
    if (c === path || path.startsWith(`${c}.`) || c.startsWith(`${path}.`)) return true;
  }
  return false;
}
