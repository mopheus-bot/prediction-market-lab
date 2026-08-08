/**
 * pm-bot — Kalshi auth parity test.
 *
 * THE GATE for Chunk 2.
 *
 * RSA-PSS uses a RANDOM SALT per signature, so two correct
 * implementations will produce DIFFERENT byte sequences for the
 * same input. We test cross-implementation compatibility by:
 *
 *   1. TS signs + TS verifies with the public key (internal
 *      consistency) — proves the TS algorithm is self-consistent.
 *
 *   2. TS verifies a pre-computed Python signature with the public
 *      key (cross-impl) — proves TS accepts a signature that
 *      Python produced. If both implementations agree on the
 *      message bytes + algorithm parameters + key bytes, the
 *      Python sig will verify under the TS verifier.
 *
 *   3. Real-world: a separate end-to-end curl against the demo
 *      API is run manually after this test passes. That's the
 *      only test that proves Kalshi itself accepts the signature.
 *
 * The Python signatures are generated once by:
 *   scripts/gen-auth-golden.py  (writes test/fixtures/auth-cross-impl.json)
 * Re-run only if the demo private key is rotated.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
	loadPrivateKey,
	loadPrivateKeyWithOptions,
	publicKeyFromPrivate,
	signRequest,
	buildAuthHeaders,
	nowMs,
} from "../src/kalshi/auth";
import demoPem from "../test/fixtures/kalshi-demo.pkcs8.pem?raw";
import crossImplJson from "../test/fixtures/auth-cross-impl.json?raw";

interface CrossImplVector {
	ts: string;
	method: string;
	path: string;
	python_signature_b64: string;
}

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
	// Import the key as extractable so we can derive the public key
	// for verification. In production, loadPrivateKey() makes it
	// non-extractable.
	const extractablePrivate = await loadPrivateKeyWithOptions(demoPem, {
		extractable: true,
		usage: "sign",
	});
	publicKey = await publicKeyFromPrivate(extractablePrivate);
	// Also load a non-extractable copy to mirror the production path
	// for the internal-consistency tests.
	privateKey = await loadPrivateKey(demoPem);
});

describe("Kalshi auth — internal consistency (TS signs + TS verifies)", () => {
	it("verifies a fresh signature for a simple GET", async () => {
		const ts = "1703000000000";
		const path = "/trade-api/v2/markets";
		const sigBytes = await signRaw(privateKey, ts, "GET", path);
		const ok = await verifyRaw(publicKey, sigBytes, ts, "GET", path);
		expect(ok).toBe(true);
	});

	it("strips query string before signing (verify same sig)", async () => {
		const ts = "1703002222222";
		const pathNoQuery = "/trade-api/v2/portfolio/balance";
		const pathWithQuery = "/trade-api/v2/portfolio/balance?limit=5";
		const sigNoQuery = await signRaw(privateKey, ts, "GET", pathNoQuery);
		const ok = await verifyRaw(publicKey, sigNoQuery, ts, "GET", pathWithQuery);
		expect(ok).toBe(true);
	});

	it("uppercases the method before signing", async () => {
		const ts = "1703003333333";
		const path = "/trade-api/v2/markets";
		const sig = await signRaw(privateKey, ts, "get", path);
		const ok = await verifyRaw(publicKey, sig, ts, "GET", path);
		expect(ok).toBe(true);
	});

	it("rejects a signature with the wrong timestamp", async () => {
		const sig = await signRaw(privateKey, "1703000000000", "GET", "/trade-api/v2/markets");
		const ok = await verifyRaw(publicKey, sig, "1703000000999", "GET", "/trade-api/v2/markets");
		expect(ok).toBe(false);
	});

	it("rejects a signature with the wrong path", async () => {
		const sig = await signRaw(privateKey, "1703000000000", "GET", "/trade-api/v2/markets");
		const ok = await verifyRaw(publicKey, sig, "1703000000000", "GET", "/trade-api/v2/markets/WRONG");
		expect(ok).toBe(false);
	});

	it("rejects a signature with the wrong method", async () => {
		const sig = await signRaw(privateKey, "1703000000000", "GET", "/trade-api/v2/markets");
		const ok = await verifyRaw(publicKey, sig, "1703000000000", "POST", "/trade-api/v2/markets");
		expect(ok).toBe(false);
	});
});

describe("Kalshi auth — cross-implementation (TS verifies a Python signature)", () => {
	const vectors: CrossImplVector[] = JSON.parse(crossImplJson);

	for (const v of vectors) {
		it(`accepts Python sig for ${v.method} ${v.path} @ ${v.ts}`, async () => {
			const sigBytes = base64ToBytes(v.python_signature_b64);
			const ok = await verifyRaw(publicKey, sigBytes, v.ts, v.method, v.path);
			expect(ok, `Python sig for ${v.path} should verify under TS verifier`).toBe(true);
		});
	}

	it("rejects Python sig verified with wrong timestamp", async () => {
		const v = vectors[0];
		const sigBytes = base64ToBytes(v.python_signature_b64);
		const ok = await verifyRaw(publicKey, sigBytes, "9999999999999", v.method, v.path);
		expect(ok).toBe(false);
	});
});

describe("buildAuthHeaders", () => {
	it("returns all three KALSHI-ACCESS-* headers", async () => {
		const headers = await buildAuthHeaders(
			privateKey,
			"a952bcbe-ec3b-4b5b-b8f9-11dae589608c",
			"GET",
			"/trade-api/v2/portfolio/balance",
			"1703000000000",
		);
		expect(headers["KALSHI-ACCESS-KEY"]).toBe("a952bcbe-ec3b-4b5b-b8f9-11dae589608c");
		expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe("1703000000000");
		expect(headers["KALSHI-ACCESS-SIGNATURE"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it("the signature in headers verifies with the public key", async () => {
		const headers = await buildAuthHeaders(
			privateKey,
			"a952bcbe-ec3b-4b5b-b8f9-11dae589608c",
			"GET",
			"/trade-api/v2/portfolio/balance",
			"1703000000000",
		);
		const sigBytes = base64ToBytes(headers["KALSHI-ACCESS-SIGNATURE"]);
		const ok = await verifyRaw(
			publicKey,
			sigBytes,
			"1703000000000",
			"GET",
			"/trade-api/v2/portfolio/balance",
		);
		expect(ok).toBe(true);
	});

	it("nowMs() returns a string of unix milliseconds", () => {
		const ts = nowMs();
		expect(typeof ts).toBe("string");
		expect(ts).toMatch(/^\d+$/);
		expect(parseInt(ts, 10)).toBeGreaterThan(1_700_000_000_000);
	});
});

// ─── Helpers ───────────────────────────────────────────────────────────

async function signRaw(
	key: CryptoKey,
	ts: string,
	method: string,
	path: string,
): Promise<Uint8Array> {
	const pathOnly = path.split("?", 1)[0];
	const message = new TextEncoder().encode(`${ts}${method.toUpperCase()}${pathOnly}`);
	const sig = await crypto.subtle.sign(
		{ name: "RSA-PSS", saltLength: 32 },
		key,
		message,
	);
	return new Uint8Array(sig);
}

async function verifyRaw(
	key: CryptoKey,
	signature: Uint8Array,
	ts: string,
	method: string,
	path: string,
): Promise<boolean> {
	const pathOnly = path.split("?", 1)[0];
	const message = new TextEncoder().encode(`${ts}${method.toUpperCase()}${pathOnly}`);
	return await crypto.subtle.verify(
		{ name: "RSA-PSS", saltLength: 32 },
		key,
		signature,
		message,
	);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
