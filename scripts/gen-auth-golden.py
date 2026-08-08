"""Generate golden signatures for the auth parity test.

Run this once to produce `test/fixtures/auth-golden.json`. The TS
port of the Kalshi auth signs the same inputs and asserts byte-
equality with these values.

Re-run only if:
- The signing algorithm changes (it shouldn't — Kalshi mandates PSS)
- The demo private key is rotated (unlikely)

Usage:
    python3 scripts/gen-auth-golden.py

Output: test/fixtures/auth-golden.json
"""
import base64
import json
import sys
from pathlib import Path

# Re-use the Python auth implementation.
sys.path.insert(0, str(Path(__file__).parent.parent / "Prediction Market Lab" / "tools" / "predictive-markets" / "src"))
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding


# Hand-rolled sign_request that matches src/kalshi/auth.ts.
# We can't import from the live repo (it's a different process), so
# we replicate the algorithm here. If you change this, also change
# src/kalshi/auth.ts and the golden test.
def sign(private_key: rsa.RSAPrivateKey, timestamp_ms: str, method: str, path: str) -> str:
    path_only = path.split("?", 1)[0]
    message = f"{timestamp_ms}{method.upper()}{path_only}".encode("utf-8")
    sig = private_key.sign(
        message,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return base64.b64encode(sig).decode("utf-8")


def main():
    repo = Path(__file__).parent.parent
    demo_pem = (repo / "test" / "fixtures" / "kalshi-demo.pkcs8.pem").read_bytes()
    key = serialization.load_pem_private_key(demo_pem, password=None)

    # Test vectors — keep them stable. The TS test signs the same.
    vectors = [
        {
            "name": "simple-get",
            "timestamp_ms": "1703000000000",
            "method": "GET",
            "path": "/trade-api/v2/markets",
        },
        {
            "name": "with-kxcpi-ticker",
            "timestamp_ms": "1703000123456",
            "method": "GET",
            "path": "/trade-api/v2/markets/KXCPI-26JUL-T0.1",
        },
        {
            "name": "post-portfolio-orders",
            "timestamp_ms": "1703000999999",
            "method": "POST",
            "path": "/trade-api/v2/portfolio/orders",
        },
        {
            "name": "ws-handshake",
            "timestamp_ms": "1703001111111",
            "method": "GET",
            "path": "/trade-api/ws/v2",
        },
        {
            "name": "with-query-stripped",
            "timestamp_ms": "1703002222222",
            "method": "GET",
            "path": "/trade-api/v2/portfolio/balance?limit=5",
        },
        {
            "name": "lowercase-method-uppercased",
            "timestamp_ms": "1703003333333",
            "method": "get",  # TS should uppercase before signing
            "path": "/trade-api/v2/markets",
        },
    ]

    out = []
    for v in vectors:
        sig = sign(key, v["timestamp_ms"], v["method"], v["path"])
        out.append({**v, "expected_signature": sig})

    out_path = repo / "test" / "fixtures" / "auth-golden.json"
    out_path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {len(out)} golden signatures to {out_path}")


if __name__ == "__main__":
    main()
