"""
pm-bot — Kalshi WebSocket relay (chunk 10.6).

This is the bridge that unblocks live numbers in the pm-bot
dashboard. CF Workers can't add custom headers to outbound
WebSocket connections, so the bot can't auth directly with
Kalshi. This relay accepts an unauthenticated WebSocket from
the bot, signs the Kalshi WS path with the demo creds, and
forwards messages both ways.

Wire-up:
  - Bot (CF Worker) connects to `wss://<relay-host>/`
  - Relay signs the path `/trade-api/ws/v2` with the RSA
    private key + key id, opens a WS to
    `wss://external-api-ws.{demo.,}kalshi.{co,com}/trade-api/ws/v2`
  - Messages are forwarded bidirectionally. The bot's
    subscription lands on Kalshi; Kalshi's frames land on the
    bot.
  - On disconnect (any side), the other side is closed.

This is a ~30-line Python service. It runs on Fly.io as
`pm-bot-relay` (shared-cpu-1x, 1GB RAM, $1.94/mo, currently
free with the user's $0.83 Fly.io trial credit).

**Security note:** the relay is a public endpoint. Anyone
with the URL can connect and proxy through to Kalshi. The
risk is bandwidth + a small amount of auth-quota usage. For
a personal trading bot, that's acceptable. If you want to
lock it down, add a shared-secret header check (see the
`--token` arg below).

Usage:
  KALSHI_KEY_ID="..." \\
  KALSHI_PRIVATE_KEY="$(cat ~/keys/kalshi-demo.pem)" \\
  KALSHI_WS_URL="wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2" \\
  PORT=8080 \\
  python server.py
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import logging
import os
import time
from pathlib import Path

import websockets
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("kalshi-relay")


# The literal WebSocket path to sign. Per Kalshi's spec, this
# is the path portion of the WS URL (same as the Python tool's
# `kalshi_ws.py`).
WS_PATH = "/trade-api/ws/v2"


def _load_private_key() -> "serialization.load_pem_private_key":
    """Load the PEM from KALSHI_PRIVATE_KEY (inline PEM) or
    KALSHI_PRIVATE_KEY_PATH (path to a .pem file)."""
    inline = os.environ.get("KALSHI_PRIVATE_KEY")
    if inline:
        return serialization.load_pem_private_key(inline.encode(), password=None)
    path = os.environ.get("KALSHI_PRIVATE_KEY_PATH")
    if not path:
        raise SystemExit(
            "either KALSHI_PRIVATE_KEY (inline PEM) or KALSHI_PRIVATE_KEY_PATH (file) is required"
        )
    return serialization.load_pem_private_key(Path(path).read_bytes(), password=None)


def _sign(ws_path: str) -> dict[str, str]:
    """Sign the WS path with the loaded key. Returns the three
    KALSHI-ACCESS-* headers.

    Per Kalshi's spec, the signature is RSA-PSS over SHA-256
    with `saltLength = digest length` (32 for SHA-256). The
    message is `timestamp + METHOD + path_without_query`.
    Anything else gets 401.
    """
    key_id = os.environ.get("KALSHI_KEY_ID")
    if not key_id:
        raise SystemExit("KALSHI_KEY_ID is required")
    pk = _load_private_key()
    ts = str(int(time.time() * 1000))
    # Strip query string if present (defensive — caller shouldn't
    # pass one for the WS, but just in case).
    path_only = ws_path.split("?", 1)[0]
    msg = f"{ts}GET{path_only}".encode()
    # RSA-PSS, SHA-256, salt length = 32 (matches digest length).
    # cryptography's PSS salt length: must be <= digest length.
    sig = pk.sign(
        msg,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.DIGEST_LENGTH,
        ),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
        "KALSHI-ACCESS-TIMESTAMP": ts,
    }


def _check_token(headers: dict) -> bool:
    """Optional shared-secret check. The CF Worker includes
    `X-Relay-Token: <token>` if RELAY_TOKEN is set in the
    Worker's env. Returns True if the token matches (or if
    RELAY_TOKEN is unset = open relay)."""
    expected = os.environ.get("RELAY_TOKEN")
    if not expected:
        return True
    provided = headers.get("x-relay-token") or headers.get("X-Relay-Token") or headers.get("X-RELAY-TOKEN")
    return provided == expected


async def _relay_one(client_ws, kalshi_ws_url: str) -> None:
    """One client connection. Opens an authed WS to Kalshi and
    forwards messages both ways until either side closes."""
    auth = _sign(WS_PATH)
    log.info("connecting to Kalshi WS: %s", kalshi_ws_url)
    # websockets 13+ uses `extra_headers` (a list of tuples);
    # websockets 11-12 used `additional_headers`. Pin >=12.0
    # in requirements.txt and use the new API.
    extra = [(k, v) for k, v in auth.items()]
    try:
        async with websockets.connect(
            kalshi_ws_url,
            extra_headers=extra,
            ping_interval=20,
            ping_timeout=20,
        ) as kalshi_ws:
            log.info("Kalshi WS open, forwarding")

            async def k_to_c() -> None:
                try:
                    async for msg in kalshi_ws:
                        await client_ws.send(msg)
                except websockets.ConnectionClosed:
                    pass
                except Exception as e:
                    log.exception("k_to_c error: %s", e)

            async def c_to_k() -> None:
                try:
                    async for msg in client_ws:
                        await kalshi_ws.send(msg)
                except websockets.ConnectionClosed:
                    pass
                except Exception as e:
                    log.exception("c_to_k error: %s", e)

            done, pending = await asyncio.wait(
                [asyncio.create_task(k_to_c()), asyncio.create_task(c_to_k())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    except websockets.exceptions.InvalidStatus as e:
        log.error("Kalshi rejected the connection: %s", e)
    except Exception as e:
        log.exception("relay error: %s", e)
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass


async def _handler(client_ws) -> None:
    """Per-connection handler for the relay server."""
    headers = dict(client_ws.request_headers or {})
    if not _check_token(headers):
        log.warning("rejecting client: bad or missing relay token")
        await client_ws.close(code=1008, reason="unauthorized")
        return
    kalshi_url = os.environ.get(
        "KALSHI_WS_URL",
        "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2",
    )
    log.info("client connected from %s", client_ws.remote_address)
    try:
        await _relay_one(client_ws, kalshi_url)
    finally:
        log.info("client disconnected")


async def _main(port: int) -> None:
    log.info("starting relay on 0.0.0.0:%d", port)
    async with websockets.serve(_handler, "0.0.0.0", port):
        log.info("relay ready")
        await asyncio.Future()  # run forever


def main() -> None:
    parser = argparse.ArgumentParser(description="pm-bot Kalshi WebSocket relay")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8080")),
        help="port to listen on (default: $PORT or 8080)",
    )
    args = parser.parse_args()
    try:
        asyncio.run(_main(args.port))
    except KeyboardInterrupt:
        log.info("shutting down")


if __name__ == "__main__":
    main()
