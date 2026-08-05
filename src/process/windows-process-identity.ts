const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;
const CIM_HANDLE_TOLERANCE_TICKS = 9n;
const CANONICAL_TICKS = /^(?:0|[1-9][0-9]*)$/;
const DMTF_DATETIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

export function parseCanonicalFileTime(value: unknown): bigint | null {
  if (typeof value !== "string" || !CANONICAL_TICKS.test(value)) return null;
  try {
    const ticks = BigInt(value);
    return ticks >= 0n && ticks <= 18_446_744_073_709_551_615n ? ticks : null;
  } catch {
    return null;
  }
}

export function canonicalFileTime(value: bigint): string {
  if (value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new RangeError("FILETIME is outside uint64 range");
  }
  return value.toString(10);
}

/** Convert a fully specified WMI DMTF datetime into Windows FILETIME ticks. */
export function dmtfDateTimeToFileTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DMTF_DATETIME.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, micros, sign, offsetMinutes] = match;
  const utcIgnoringOffset = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), 0,
  );
  if (!Number.isFinite(utcIgnoringOffset)) return null;
  // Date.UTC normalizes invalid calendar values, so round-trip every component.
  const normalized = new Date(utcIgnoringOffset);
  if (
    normalized.getUTCFullYear() !== Number(year)
    || normalized.getUTCMonth() + 1 !== Number(month)
    || normalized.getUTCDate() !== Number(day)
    || normalized.getUTCHours() !== Number(hour)
    || normalized.getUTCMinutes() !== Number(minute)
    || normalized.getUTCSeconds() !== Number(second)
  ) return null;
  const signedOffset = Number(offsetMinutes) * (sign === "+" ? 1 : -1);
  const utcMillis = utcIgnoringOffset - signedOffset * 60_000;
  const ticks = FILETIME_UNIX_EPOCH_TICKS
    + BigInt(utcMillis) * 10_000n
    + BigInt(micros!) * 10n;
  return ticks >= 0n ? canonicalFileTime(ticks) : null;
}

export function exactHandleIdentityMatches(expected: unknown, actual: unknown): boolean {
  const left = parseCanonicalFileTime(expected);
  const right = parseCanonicalFileTime(actual);
  return left !== null && right !== null && left === right;
}

export function cimIdentityMatchesHandle(cimExpected: unknown, handleActual: unknown): boolean {
  const left = parseCanonicalFileTime(cimExpected);
  const right = parseCanonicalFileTime(handleActual);
  if (left === null || right === null) return false;
  const delta = left >= right ? left - right : right - left;
  return delta <= CIM_HANDLE_TOLERANCE_TICKS;
}

export function creationOrderIsValid(parent: unknown, child: unknown): boolean {
  const parentTicks = parseCanonicalFileTime(parent);
  const childTicks = parseCanonicalFileTime(child);
  return parentTicks !== null && childTicks !== null && childTicks >= parentTicks;
}
