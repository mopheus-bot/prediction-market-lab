/**
 * pm-bot — Kalshi RSA-signed auth headers.
 *
 * The Kalshi API authenticates every private request
 * (portfolio, orders, WebSocket handshake) with three headers:
 *
 *   KALSHI-ACCESS-KEY       — your API Key ID
 *   KALSHI-ACCESS-TIMESTAMP — Unix milliseconds (as a string)
 *   KALSHI-ACCESS-SIGNATURE — base64 RSA-PSS signature
 *
 * Signature:
 *   base64(RSA-PSS-SHA256-sign(private_key, timestamp + METHOD + path))
 *
 * Padding: PSS with MGF1-SHA256, salt length = DIGEST_LENGTH (32 bytes).
 *
 * The `path` is the FULL HTTP request path from the URL root,
 * INCLUDING the API prefix. For example, with base URL
 * `https://demo-api.kalshi.co/trade-api/v2` and a request to
 * `/portfolio/balance`, the HTTP path is
 * `/trade-api/v2/portfolio/balance` — that whole string is what
 * gets signed. The function defensively strips `?...` from the
 * passed path, so passing the full URL path is safe.
 *
 * **PKCS#8 PEM required.** The .pem files Kalshi issues are PKCS#1
 * (`BEGIN RSA PRIVATE KEY`). Web Crypto API only accepts
 * PKCS#8 (`BEGIN PRIVATE KEY`). Convert once with the
 * helper at `scripts/gen-auth-golden.py` (or `openssl pkcs8 -topk8`).
 *
 * **Parity:** the bytes that get signed match the Python
 * `cryptography` implementation byte-for-byte. Verified two ways in
 * `test/auth.test.ts`:
 *  - Internal: TS signs + TS verifies (self-consistent algorithm)
 *  - Cross-impl: TS verifies a pre-computed Python signature
 *  - Real-world: `scripts/smoke-demo-auth.mjs` hits demo.kalshi.co
 *    with TS-generated headers; 200 OK confirms Kalshi accepts.
 */

// ─── Web Crypto types (we use the runtime's global `crypto.subtle`) ──

declare const crypto: {
	subtle: SubtleCrypto;
};

// ─── Key loading ────────────────────────────────────────────────────────

/**
 * Load an RSA private key from a PKCS#8 PEM string. Returns a
 * `CryptoKey` ready for `crypto.subtle.sign("RSA-PSS", ...)`.
 *
 * The input must be PKCS#8 PEM. If you have PKCS#1 (`-----BEGIN
 * RSA PRIVATE KEY-----`), convert first — see scripts/convert-pem-to-pkcs8.py.
 */
export async function loadPrivateKey(
	pem: string,
	usage: "sign" | "verify" = "sign",
): Promise<CryptoKey> {
	return loadPrivateKeyWithOptions(pem, { extractable: false, usage });
}

/**
 * Lower-level loader. Pass `extractable: true` if you need to
 * derive the public key (e.g. for verification in tests). In
 * production, keep `extractable: false` — non-extractable keys
 * can't be stolen via `crypto.subtle.exportKey()`.
 */
export async function loadPrivateKeyWithOptions(
	pem: string,
	opts: { extractable: boolean; usage?: "sign" | "verify" } = { extractable: false },
): Promise<CryptoKey> {
	const stripped = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const bytes = base64ToBytes(stripped);

	return await crypto.subtle.importKey(
		"pkcs8",
		bytes,
		{ name: "RSA-PSS", hash: "SHA-256" },
		opts.extractable,
		[opts.usage ?? "sign"],
	);
}

/**
 * Derive the public key from a private key. The private key must
 * have been imported as `extractable: true`. In production, the
 * private key is non-extractable and you can't get the public key
 * this way — load it from a separate file/secret instead.
 */
export async function publicKeyFromPrivate(
	privateKey: CryptoKey,
): Promise<CryptoKey> {
	// exportKey("jwk") returns JsonWebKey (not ArrayBuffer) when
	// the format is "jwk", so the type union doesn't include ArrayBuffer
	// in practice — but TypeScript doesn't know that.
	const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
	// Strip the private components (d, p, q, dp, dq, qi) and re-import.
	// jwk has these for RSA private keys.
	const pubJwk: JsonWebKey = {
		kty: jwk.kty,
		n: jwk.n,
		e: jwk.e,
		alg: jwk.alg,
		ext: true,
	};
	return await crypto.subtle.importKey(
		"jwk",
		pubJwk,
		{ name: "RSA-PSS", hash: "SHA-256" },
		true,
		["verify"],
	);
}

// ─── Signing ────────────────────────────────────────────────────────────

/**
 * Sign a Kalshi API request. Returns the base64-encoded signature
 * ready to put in `KALSHI-ACCESS-SIGNATURE`.
 *
 * The message signed is `timestamp + METHOD + path` where METHOD is
 * uppercased and path is the request path WITHOUT the query string.
 */
export async function signRequest(
	privateKey: CryptoKey,
	timestampMs: string,
	method: string,
	path: string,
): Promise<string> {
	// Defensive: strip query string even if caller passed it.
	const pathOnly = path.split("?", 1)[0];
	const message = `${timestampMs}${method.toUpperCase()}${pathOnly}`;
	const data = new TextEncoder().encode(message);

	// saltLength = 32 matches `padding.PSS.DIGEST_LENGTH` for SHA-256
	// in the Python reference. This is mandatory — Kalshi rejects any
	// other salt length.
	const signature = await crypto.subtle.sign(
		{ name: "RSA-PSS", saltLength: 32 },
		privateKey,
		data,
	);

	return bytesToBase64(new Uint8Array(signature));
}

// ─── Header builder ─────────────────────────────────────────────────────

export interface AuthHeaders {
	"KALSHI-ACCESS-KEY": string;
	"KALSHI-ACCESS-TIMESTAMP": string;
	"KALSHI-ACCESS-SIGNATURE": string;
}

export async function buildAuthHeaders(
	privateKey: CryptoKey,
	keyId: string,
	method: string,
	path: string,
	timestampMs?: string,
): Promise<AuthHeaders> {
	const ts = timestampMs ?? nowMs();
	const sig = await signRequest(privateKey, ts, method, path);
	return {
		"KALSHI-ACCESS-KEY": keyId,
		"KALSHI-ACCESS-TIMESTAMP": ts,
		"KALSHI-ACCESS-SIGNATURE": sig,
	};
}

// ─── Time helper ────────────────────────────────────────────────────────

/** Current Unix time in milliseconds, as a string. */
export function nowMs(): string {
	return String(Date.now());
}

// ─── Credentials bundle ─────────────────────────────────────────────────

export class KalshiCredentials {
	constructor(
		public readonly keyId: string,
		public readonly privateKey: CryptoKey,
	) {
		if (!keyId) throw new Error("keyId is required");
	}

	static async fromPem(keyId: string, pem: string): Promise<KalshiCredentials> {
		const privateKey = await loadPrivateKey(pem);
		return new KalshiCredentials(keyId, privateKey);
	}

	async authHeaders(
		method: string,
		path: string,
		timestampMs?: string,
	): Promise<AuthHeaders> {
		return buildAuthHeaders(this.privateKey, this.keyId, method, path, timestampMs);
	}
}

// ─── Internal: base64 helpers (Workers don't have Buffer) ─────────────

function bytesToBase64(bytes: Uint8Array): string {
	// `btoa` works on latin-1 strings — perfect for binary bytes
	// (each byte is a latin-1 char).
	let bin = "";
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i]);
	}
	return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}
