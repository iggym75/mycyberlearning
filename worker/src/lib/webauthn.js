// Passkey (WebAuthn Level 2) verification with Web Crypto only: no runtime dependencies.
//
// Policy: attestation "none" (we don't care which brand of authenticator), user verification required
// (Face ID / Touch ID / PIN, which is what makes a passkey multi-factor), discoverable credentials,
// algorithms ES256 (-7), EdDSA/Ed25519 (-8) and RS256 (-257).
//
// Every check from the spec that matters for a relying party without attestation is done here:
// clientData type, challenge (single use, checked by the caller), origin, no cross-origin use,
// rpIdHash, user-present and user-verified flags, credential id consistency, algorithm allow-list,
// public key import, signature over authenticatorData || SHA-256(clientDataJSON), and the signature counter.

const te = new TextEncoder(), td = new TextDecoder("utf-8", { fatal: true });
export const ALGS = [-7, -8, -257];

export const b64u = {
  encode: bytes => {
    let s = ""; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode: str => {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str) || str.length > 8192) throw new WebAuthnError("bad base64url");
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
};

export class WebAuthnError extends Error {}
const fail = msg => { throw new WebAuthnError(msg); };
const sha256 = async data => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const bytesEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const strEqual = (a, b) => typeof a === "string" && typeof b === "string" && bytesEqual(te.encode(a), te.encode(b));

/** Minimal, strict CBOR decoder (RFC 8949): definite lengths only, depth and size limited. Returns { value, offset }. */
export function decodeCbor(bytes, start = 0, depth = 0) {
  if (depth > 16) fail("CBOR too deep");
  let p = start;
  const need = n => { if (p + n > bytes.length) fail("CBOR truncated"); };
  need(1);
  const ib = bytes[p++], major = ib >> 5, ai = ib & 31;
  let len;
  if (ai < 24) len = ai;
  else if (ai === 24) { need(1); len = bytes[p]; p += 1; }
  else if (ai === 25) { need(2); len = (bytes[p] << 8) | bytes[p + 1]; p += 2; }
  else if (ai === 26) { need(4); len = ((bytes[p] << 24) >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]; p += 4; }
  else if (ai === 27) { need(8); const hi = ((bytes[p] << 24) >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3]; if (hi > 0x1fffff) fail("CBOR int too large"); len = hi * 2 ** 32 + ((bytes[p + 4] << 24) >>> 0) + (bytes[p + 5] << 16) + (bytes[p + 6] << 8) + bytes[p + 7]; p += 8; }
  else fail("CBOR indefinite or reserved length");
  switch (major) {
    case 0: return { value: len, offset: p };
    case 1: return { value: -1 - len, offset: p };
    case 2: need(len); return { value: bytes.slice(p, p + len), offset: p + len };
    case 3: need(len); return { value: td.decode(bytes.subarray(p, p + len)), offset: p + len };
    case 4: {
      if (len > 1000) fail("CBOR array too long");
      const arr = [];
      for (let i = 0; i < len; i++) { const r = decodeCbor(bytes, p, depth + 1); arr.push(r.value); p = r.offset; }
      return { value: arr, offset: p };
    }
    case 5: {
      if (len > 1000) fail("CBOR map too long");
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const k = decodeCbor(bytes, p, depth + 1); p = k.offset;
        if (typeof k.value !== "number" && typeof k.value !== "string") fail("CBOR map key type");
        if (map.has(k.value)) fail("CBOR duplicate map key");
        const v = decodeCbor(bytes, p, depth + 1); p = v.offset;
        map.set(k.value, v.value);
      }
      return { value: map, offset: p };
    }
    case 7:
      if (ai === 20) return { value: false, offset: p };
      if (ai === 21) return { value: true, offset: p };
      if (ai === 22) return { value: null, offset: p };
      return fail("CBOR simple/float value not supported");
    default: return fail("CBOR tags not supported");
  }
}

/** authenticatorData: rpIdHash(32) flags(1) signCount(4) [attestedCredentialData] [extensions]. */
export function parseAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) fail("authenticator data too short");
  const flags = ad[32];
  const out = {
    rpIdHash: ad.slice(0, 32), flags,
    up: !!(flags & 0x01), uv: !!(flags & 0x04), be: !!(flags & 0x08), bs: !!(flags & 0x10), at: !!(flags & 0x40), ed: !!(flags & 0x80),
    signCount: ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36]
  };
  let p = 37;
  if (out.at) {
    if (ad.length < p + 18) fail("attested credential data truncated");
    p += 16; // AAGUID: not used (no attestation policy)
    const idLen = (ad[p] << 8) | ad[p + 1]; p += 2;
    if (idLen < 16 || idLen > 1023 || ad.length < p + idLen) fail("bad credential id length");
    out.credentialId = ad.slice(p, p + idLen); p += idLen;
    const key = decodeCbor(ad, p); out.coseKey = key.value; p = key.offset;
  }
  if (out.ed) { const ext = decodeCbor(ad, p); p = ext.offset; }
  if (p !== ad.length) fail("trailing bytes in authenticator data");
  return out;
}

/** COSE_Key -> { alg, jwk }. Only the three algorithms we offer are accepted. */
export function coseToJwk(m) {
  if (!(m instanceof Map)) fail("public key is not a COSE map");
  const kty = m.get(1), alg = m.get(3);
  const bytes = (k, n) => { const v = m.get(k); if (!(v instanceof Uint8Array) || (n && v.length !== n)) fail("bad COSE key parameter"); return b64u.encode(v); };
  if (alg === -7 && kty === 2 && m.get(-1) === 1) return { alg, jwk: { kty: "EC", crv: "P-256", x: bytes(-2, 32), y: bytes(-3, 32) } };
  if (alg === -8 && kty === 1 && m.get(-1) === 6) return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2, 32) } };
  if (alg === -257 && kty === 3) {
    const n = m.get(-1); if (!(n instanceof Uint8Array) || n.length < 256) fail("RSA key too small");
    return { alg, jwk: { kty: "RSA", n: b64u.encode(n), e: bytes(-2) } };
  }
  return fail("unsupported key type or algorithm");
}

const IMPORT = {
  [-7]: [{ name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  [-8]: [{ name: "Ed25519" }, { name: "Ed25519" }],
  [-257]: [{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }]
};
const importKey = (jwk, alg) => {
  if (!IMPORT[alg]) fail("unsupported algorithm");
  return crypto.subtle.importKey("jwk", { ...jwk, ext: true }, IMPORT[alg][0], false, ["verify"]);
};

/** ECDSA signatures arrive DER-encoded; Web Crypto wants raw r||s (32 bytes each for P-256). */
export function derToRaw(der) {
  const fixed = n => { while (n.length > 32 && n[0] === 0) n = n.slice(1); if (n.length > 32) fail("bad ECDSA integer"); const o = new Uint8Array(32); o.set(n, 32 - n.length); return o; };
  let p = 0;
  if (der[p++] !== 0x30) fail("bad ECDSA signature");
  let len = der[p++]; if (len & 0x80) { if (len !== 0x81) fail("bad ECDSA signature"); len = der[p++]; }
  if (p + len !== der.length) fail("bad ECDSA signature length");
  const int = () => { if (der[p++] !== 0x02) fail("bad ECDSA signature"); const l = der[p++]; if (l < 1 || l > 33 || p + l > der.length) fail("bad ECDSA signature"); const v = der.slice(p, p + l); p += l; return v; };
  const r = int(), s = int();
  if (p !== der.length) fail("bad ECDSA signature");
  return concat(fixed(r), fixed(s));
}

function checkClientData(raw, type, origin) {
  let cd;
  try { cd = JSON.parse(td.decode(raw)); } catch { fail("clientDataJSON is not JSON"); }
  if (cd?.type !== type) fail("wrong ceremony type");
  if (typeof cd.challenge !== "string") fail("missing challenge");
  if (!strEqual(cd.origin, origin)) fail("wrong origin");
  if (cd.crossOrigin === true) fail("cross-origin use is not allowed");
  if (cd.tokenBinding?.status === "present") fail("token binding not supported");
  return cd;
}

/** Reads the challenge from a credential's clientDataJSON so the caller can look it up (and consume it) first. */
export function challengeOf(credential) {
  try {
    const cd = JSON.parse(td.decode(b64u.decode(credential?.response?.clientDataJSON)));
    return typeof cd.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(cd.challenge) ? cd.challenge : null;
  } catch { return null; }
}

/**
 * Registration (navigator.credentials.create) response.
 * Returns { credentialId (base64url), jwk, alg, signCount, backedUp }.
 */
export async function verifyRegistration(credential, { expectedChallenge, origin, rpId }) {
  if (credential?.type !== "public-key") fail("not a public-key credential");
  const r = credential.response || {};
  const clientDataJSON = b64u.decode(r.clientDataJSON);
  const cd = checkClientData(clientDataJSON, "webauthn.create", origin);
  if (!strEqual(cd.challenge, expectedChallenge)) fail("challenge mismatch");
  const att = decodeCbor(b64u.decode(r.attestationObject));
  if (att.offset !== b64u.decode(r.attestationObject).length || !(att.value instanceof Map)) fail("bad attestation object");
  const authDataBytes = att.value.get("authData");
  if (!(authDataBytes instanceof Uint8Array)) fail("missing authData");
  const ad = parseAuthData(authDataBytes);
  if (!bytesEqual(ad.rpIdHash, await sha256(te.encode(rpId)))) fail("wrong relying party");
  if (!ad.up) fail("user presence missing");
  if (!ad.uv) fail("user verification missing");
  if (!ad.at || !ad.credentialId) fail("no credential in authenticator data");
  const rawId = b64u.decode(credential.rawId ?? credential.id);
  if (!bytesEqual(rawId, ad.credentialId) || credential.id !== b64u.encode(rawId)) fail("credential id mismatch");
  const { alg, jwk } = coseToJwk(ad.coseKey);
  await importKey(jwk, alg); // rejects keys that aren't valid points/moduli
  return { credentialId: b64u.encode(ad.credentialId), jwk, alg, signCount: ad.signCount, backedUp: ad.bs };
}

/**
 * Authentication (navigator.credentials.get) response for a stored credential.
 * Returns { signCount, backedUp }. Throws on any failure, including a cloned-authenticator counter.
 */
export async function verifyAuthentication(credential, { expectedChallenge, origin, rpId, jwk, alg, storedSignCount = 0 }) {
  if (credential?.type !== "public-key") fail("not a public-key credential");
  const r = credential.response || {};
  const clientDataJSON = b64u.decode(r.clientDataJSON);
  const cd = checkClientData(clientDataJSON, "webauthn.get", origin);
  if (!strEqual(cd.challenge, expectedChallenge)) fail("challenge mismatch");
  const authData = b64u.decode(r.authenticatorData);
  const ad = parseAuthData(authData);
  if (ad.at) fail("unexpected attested data in an assertion");
  if (!bytesEqual(ad.rpIdHash, await sha256(te.encode(rpId)))) fail("wrong relying party");
  if (!ad.up) fail("user presence missing");
  if (!ad.uv) fail("user verification missing");
  let sig = b64u.decode(r.signature);
  if (alg === -7) sig = derToRaw(sig);
  const key = await importKey(jwk, alg);
  const signed = concat(authData, await sha256(clientDataJSON));
  if (!(await crypto.subtle.verify(IMPORT[alg][1], key, sig, signed))) fail("bad signature");
  // Counter: synced passkeys report 0; if either side is non-zero it must go up, or the key may have been cloned.
  if ((ad.signCount !== 0 || storedSignCount !== 0) && ad.signCount <= storedSignCount) fail("signature counter did not increase");
  return { signCount: ad.signCount, backedUp: ad.bs };
}

export const newChallenge = () => b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
