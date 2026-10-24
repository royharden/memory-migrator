/** Content id for merge-by-id imports. Not a security hash. */
export function stableId(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x01000193);
  }
  const hex = (valueToHex: number) => (valueToHex >>> 0).toString(16).padStart(8, "0");
  return `f_${hex(h1)}${hex(h2)}`;
}

export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function factId(slot: string, value: string, polarity: string): string {
  return stableId(`${slot}|${polarity}|${normalizeValue(value)}`);
}

export function auditId(action: string, factKey: string, at: string, salt: string): string {
  return stableId(`${action}|${factKey}|${at}|${salt}`);
}
