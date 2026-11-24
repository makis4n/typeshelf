/**
 * A book's fingerprint is the SHA-256 of the original file's bytes. Imported
 * books never leave the device, so the fingerprint is how a second device
 * recognises "the same file" when only progress has synced.
 */

const IMPORT_PREFIX = 'import:';

/** Lowercase hex SHA-256 of a file's bytes. */
export async function fingerprintOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The id of an imported book with this fingerprint. */
export function importId(fingerprint: string): string {
  return IMPORT_PREFIX + fingerprint;
}

/** The fingerprint inside an imported book's id, or `undefined` for any other id. */
export function fingerprintFromId(id: string): string | undefined {
  return id.startsWith(IMPORT_PREFIX) ? id.slice(IMPORT_PREFIX.length) : undefined;
}

/**
 * True when the file the reader picked is the book a fingerprint refers to.
 * `known` comes from elsewhere (progress synced from another device) and may
 * be a bare fingerprint or an `import:<fingerprint>` id.
 */
export async function isSameBook(known: string, bytes: Uint8Array): Promise<boolean> {
  const wanted = (fingerprintFromId(known.trim()) ?? known).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) return false;
  return wanted === (await fingerprintOf(bytes));
}
