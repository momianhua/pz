import { GatewayError } from "./errors.js";

export class CircuitBreaker {
  constructor({ name, failureThreshold = 3, resetTimeoutMs = 30_000, now = Date.now }) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  state() {
    if (!this.openedAt) return "closed";
    if (this.now() - this.openedAt >= this.resetTimeoutMs) return "half-open";
    return "open";
  }

  assertAvailable() {
    const state = this.state();
    if (state === "open" || (state === "half-open" && this.probeInFlight)) {
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt));
      throw new GatewayError("ENGINE_CIRCUIT_OPEN", `Engine ${this.name} is temporarily unavailable`, 503, { retryAfterMs });
    }
    if (state === "half-open") this.probeInFlight = true;
  }

  success() {
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  failure(error) {
    this.probeInFlight = false;
    // Only infrastructure failures should make the whole engine unavailable.
    // Provider/model/task errors may be deterministic for one request and must
    // not block unrelated conversations.
    if (!["ENGINE_UNAVAILABLE", "ENGINE_TIMEOUT", "ENGINE_PROTOCOL_ERROR"].includes(error?.code)) return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAt = this.now();
  }

  releaseProbe() {
    this.probeInFlight = false;
  }

  snapshot() {
    return { state: this.state(), failures: this.failures };
  }
}
