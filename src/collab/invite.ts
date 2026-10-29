// Invitations to a shared session: a join code (the host's IPv4 address, port and session secret
// in Crockford base32, `XXXXXX-XXXXXX-XXXXXX`) or a link `http://<ip>:<port>/#join=<code>`.
// Must match `src-tauri/src/collab/code.rs`.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_BYTES = 11;
const CODE_CHARS = Math.ceil((CODE_BYTES * 8) / 5);

export interface Invite {
  /** As typed, normalized: what the host checks. */
  code: string;
  /** `ip:port` to connect to. */
  host: string;
}

/** The code's bytes, or null when it is not a well-formed code. */
function decode(code: string): Uint8Array | null {
  let value = 0n;
  let count = 0;
  for (const raw of code.toUpperCase()) {
    if (raw === "-" || /\s/.test(raw)) continue;
    const c = raw === "I" || raw === "L" ? "1" : raw === "O" ? "0" : raw;
    const digit = ALPHABET.indexOf(c);
    if (digit < 0 || ++count > CODE_CHARS) return null;
    value = (value << 5n) | BigInt(digit);
  }
  if (count !== CODE_CHARS || value >> BigInt(CODE_BYTES * 8) !== 0n) return null;
  const bytes = new Uint8Array(CODE_BYTES);
  for (let i = CODE_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function normalize(code: string): string {
  const plain = code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return plain.match(/.{1,6}/g)?.join("-") ?? plain;
}

/** A code or an invitation link; null when it is neither. */
export function parseInvite(input: string): Invite | null {
  const text = input.trim();
  const link = /^https?:\/\/([^/#?]+)[^#]*#join=([^&\s]+)/i.exec(text);
  const code = link ? decodeURIComponent(link[2]) : text;
  const bytes = decode(code);
  if (!bytes) return null;
  const port = (bytes[4] << 8) | bytes[5];
  return { code: normalize(code), host: link ? link[1] : `${bytes.slice(0, 4).join(".")}:${port}` };
}

/** The invitation in this page's address, when the page was opened from a link. */
export function inviteInLocation(): string | null {
  const match = /^#join=(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}
