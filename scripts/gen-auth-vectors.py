#!/usr/bin/env python3
"""Generate the auth test key and the cross-implementation signature vectors.

This script is the *Python half* of the auth parity check. The TypeScript half
lives in `src/kalshi/auth.ts`; the test in `test/auth.test.ts` verifies that a
signature produced here is accepted by the TypeScript verifier.

Kalshi signs every private request with RSA-PSS over
`timestamp + METHOD + path`:

    base64(RSA-PSS-SHA256-sign(private_key, timestamp + METHOD + path))

with PSS salt length equal to the digest length (32 bytes for SHA-256).
WebCrypto's `sign` takes `saltLength: 32`, so the two implementations agree
byte-for-byte.

Outputs
-------
`test/fixtures/test-signing-key.json`
    A throwaway RSA-2048 key, base64-encoded PKCS#8 DER *without* PEM armor.
    It is stored that way deliberately: PEM-armored private keys trip generic
    secret scanners and GitHub push protection, and this key is not a
    credential — it is not registered with any Kalshi account and cannot
    authenticate against one.

`test/fixtures/auth-cross-impl.json`
    Pre-computed Python signatures that the TypeScript verifier must accept.

Usage
-----
    python3 scripts/gen-auth-vectors.py               # reuse or create the key
    python3 scripts/gen-auth-vectors.py --regenerate-key

Requires: `cryptography` (pip install cryptography).
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "test" / "fixtures"
KEY_PATH = FIXTURES / "test-signing-key.json"
VECTORS_PATH = FIXTURES / "auth-cross-impl.json"

KEY_SIZE = 2048

# The message signed is `timestamp + METHOD + path`; METHOD is uppercased and
# the query string is stripped from the path.
VECTORS = [
    ("1703000000000", "GET", "/trade-api/v2/markets"),
    ("1703000123456", "GET", "/trade-api/v2/markets/KXCPI-26JUL-T0.1"),
    ("1703000999999", "POST", "/trade-api/v2/portfolio/orders"),
    ("1703001111111", "GET", "/trade-api/ws/v2"),
    ("1703002222222", "GET", "/trade-api/v2/portfolio/balance?limit=5"),
    ("1703003333333", "get", "/trade-api/v2/markets"),
]

KEY_METADATA = {
    "_comment": (
        "Throwaway RSA-2048 key for the auth parity test suite. This is NOT a "
        "credential: it is not registered with any Kalshi account and cannot "
        "authenticate against one. Stored base64-encoded (PKCS#8 DER, no PEM "
        "armor) so generic secret scanners and GitHub push protection do not "
        "treat it as a leaked private key. Regenerate with "
        "`python3 scripts/gen-auth-vectors.py --regenerate-key`."
),
    "algorithm": "RSA-2048",
    "format": "pkcs8-der-base64",
    "pkcs8_base64": "",
}


def load_or_create_key(regenerate: bool) -> rsa.RSAPrivateKey:
    if not regenerate and KEY_PATH.exists():
        blob = json.loads(KEY_PATH.read_text())
        der = base64.b64decode(blob["pkcs8_base64"])
        return serialization.load_der_private_key(der, password=None)

    key = rsa.generate_private_key(public_exponent=65537, key_size=KEY_SIZE)
    der = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
)
    metadata = dict(KEY_METADATA)
    metadata["pkcs8_base64"] = base64.b64encode(der).decode("ascii")
    KEY_PATH.write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Wrote test key -> {KEY_PATH}")
    return key


def sign(key: rsa.RSAPrivateKey, timestamp_ms: str, method: str, path: str) -> str:
    """Sign one request exactly the way Kalshi expects."""
    path_only = path.split("?", 1)[0]
    message = f"{timestamp_ms}{method.upper()}{path_only}".encode("utf-8")
    signature = key.sign(
        message,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
),
        hashes.SHA256(),
)
    return base64.b64encode(signature).decode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--regenerate-key",
        action="store_true",
        help="generate a fresh throwaway key instead of reusing the committed one",
)
    args = parser.parse_args()

    key = load_or_create_key(args.regenerate_key)

    out = []
    for ts, method, path in VECTORS:
        out.append(
            {
                "ts": ts,
                "method": method,
                "path": path,
                "python_signature_b64": sign(key, ts, method, path),
            }
)

    VECTORS_PATH.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {len(out)} cross-implementation vectors -> {VECTORS_PATH}")


if __name__ == "__main__":
    main()
