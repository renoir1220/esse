export function compactToolArgs(value: Record<string, unknown>): Record<string, unknown> {
  return compactValue(value) as Record<string, unknown>;
}

function compactValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (Array.isArray(value)) return value.map(compactValue).filter((entry) => entry !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      const compacted = compactValue(entry);
      return compacted === undefined ? [] : [[key, compacted]];
    }));
  }
  return value;
}
