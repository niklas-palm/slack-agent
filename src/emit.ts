// JSON-line stdout writer. One event per line:
//   {"event": ..., "ts": ..., ...fields}
// `ts` is unix epoch seconds (fractional).
export function emit(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ts: Date.now() / 1000, ...fields });
  process.stdout.write(line + '\n');
}

/** Errors arrive as `unknown`; this is the only shape we ever want from one. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
