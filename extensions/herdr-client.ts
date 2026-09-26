import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export type HerdrRequest = { method: string; params: Record<string, unknown> };

const MAX_RESPONSE_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One request per connection; endpoint normalization and retries belong to the caller. */
export async function requestHerdr(
  endpoint: string,
  request: HerdrRequest,
  signal?: AbortSignal,
  timeoutMs = 1000,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const id = randomUUID();
  const message = JSON.stringify({ id, method: request.method, params: request.params }) + "\n";

  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint });
    let pending = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: unknown, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending = Buffer.alloc(0);
      socket.destroy();
      if (result !== undefined) resolve(result);
      else reject(error);
    };
    const onAbort = () => finish(signal?.reason ?? new Error("Herdr request aborted"));

    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Herdr connection ended before a matching response")));
    socket.on("close", () => finish(new Error("Herdr connection closed before a matching response")));
    socket.on("connect", () => {
      if (!settled) socket.write(message);
    });
    socket.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (!settled && offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = pending.length + end - offset;
        if (length > MAX_RESPONSE_BYTES) {
          finish(new Error("Herdr response exceeds 64 KiB"));
          return;
        }
        pending = Buffer.concat([pending, chunk.subarray(offset, end)], length);
        if (newline === -1) return;
        const line = pending.toString("utf8");
        pending = Buffer.alloc(0);
        offset = newline + 1;
        let response: unknown;
        try {
          response = JSON.parse(line);
        } catch {
          finish(new Error("Malformed JSON in Herdr response"));
          return;
        }
        if (!isRecord(response) || response.id !== id) continue;
        if (response.error !== undefined && response.error !== null) {
          const detail = isRecord(response.error) && typeof response.error.message === "string"
            ? response.error.message
            : JSON.stringify(response.error);
          finish(new Error(`Herdr request failed: ${detail}`));
        } else if (!isRecord(response.result)) {
          finish(new Error("Herdr response result must be an object"));
        } else {
          finish(undefined, response.result);
        }
      }
    });

    timer = setTimeout(() => finish(new Error(`Herdr request timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Covers an abort during request serialization or connection setup.
    if (signal?.aborted) onAbort();
  });
}
