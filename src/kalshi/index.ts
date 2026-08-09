/**
 * pm-bot — Kalshi integration entry point.
 * Re-exports auth, client, and models for convenient import:
 *   import { KalshiClient, KalshiCredentials } from "./kalshi.js";
 *
 * 2026-08-09: WS re-export removed. The Kalshi WebSocket
 * data feed was replaced with REST polling via the SDK
 * adapter (see src/kalshi/sdk-adapter.ts + the
 * `LiveBot.startPolling` method). The ws.ts module and
 * KalshiWSClient are gone — no caller needs them.
 */

export * from "./auth.js";
export * from "./client.js";
export * from "./models.js";
