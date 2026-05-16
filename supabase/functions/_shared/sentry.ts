// Minimal Sentry wiring for Supabase edge functions.
//
// Usage inside a function:
//   import { captureEdgeError, flushSentry } from "../_shared/sentry.ts";
//   try { ... } catch (err) {
//     console.error("[function-name]", err);
//     captureEdgeError("function-name", err, { extraContext });
//     await flushSentry();
//     return errorResponse;
//   }
//
// Deployment:
//   - This project shares the-green-cart org's Sentry project with other codebases;
//     events are tagged `service=gc-finance` so they can be filtered apart.
//   - Copy the DSN from Sentry → Settings → Projects → [shared project] → Client Keys,
//     then set it on Supabase:
//       supabase secrets set SENTRY_DSN_EDGE=https://…@…ingest.sentry.io/…
//   - Optionally SENTRY_ENVIRONMENT (defaults to "production").
//   - If SENTRY_DSN_EDGE is unset, all calls here are no-ops — safe to
//     deploy code with captureEdgeError() before the secret is configured.

import * as Sentry from "https://esm.sh/@sentry/deno@8.47.0";

const SENTRY_DSN = Deno.env.get("SENTRY_DSN_EDGE");
const ENVIRONMENT = Deno.env.get("SENTRY_ENVIRONMENT") ?? "production";

let initialized = false;

function ensureInit() {
  if (initialized || !SENTRY_DSN) return;
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: ENVIRONMENT,
      tracesSampleRate: 0,
      defaultIntegrations: false,
      initialScope: {
        tags: { service: "gc-finance" },
      },
    });
    initialized = true;
  } catch (initErr) {
    console.error("[sentry] init failed:", initErr);
  }
}

export function captureEdgeError(
  functionName: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  if (!SENTRY_DSN) return;
  ensureInit();
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    Sentry.captureException(error, {
      tags: { edge_function: functionName, runtime: "deno" },
      extra,
    });
  } catch (captureErr) {
    console.error("[sentry] capture failed:", captureErr);
  }
}

/**
 * Send a non-error event to Sentry. Used for noteworthy-but-not-failure signals
 * — for example, scan-ramp uses this to alert when Ramp's email subject format
 * changes (drift detection) so we notice before the pipeline starts silently
 * dropping events.
 */
export function captureEdgeMessage(
  functionName: string,
  message: string,
  level: "info" | "warning" | "error" = "warning",
  extra?: Record<string, unknown>,
): void {
  if (!SENTRY_DSN) return;
  ensureInit();
  try {
    Sentry.captureMessage(message, {
      level,
      tags: { edge_function: functionName, runtime: "deno" },
      extra,
    });
  } catch (captureErr) {
    console.error("[sentry] message capture failed:", captureErr);
  }
}

// Edge functions die as soon as the response is returned — events queued by
// captureException must be flushed before that happens or they're lost.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!SENTRY_DSN || !initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Swallow — a failed flush shouldn't crash the handler.
  }
}
