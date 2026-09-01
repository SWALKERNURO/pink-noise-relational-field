import { CANONICAL_COLORS, nearestCanonical } from "./analysis-engine.js?v=0.5.3";

const BLOCKING_STATES = new Set(["silence", "tonal", "mixed", "unstable", "clipping", "insufficient", "invalid", "paused", "unavailable", "listening"]);

export class ColorStateMachine {
  constructor({ alpha = 0.28, hysteresis = 0.12, requiredObservations = 2 } = {}) {
    this.alpha = alpha;
    this.hysteresis = hysteresis;
    this.requiredObservations = requiredObservations;
    this.reset();
  }

  reset(state = "listening", label = "Listening…") {
    this.state = state;
    this.label = label;
    this.displayBeta = null;
    this.pendingState = null;
    this.pendingCount = 0;
    return this.snapshot(null);
  }

  block(state, label, measurement = null) {
    this.state = state;
    this.label = label;
    this.pendingState = null;
    this.pendingCount = 0;
    this.displayBeta = null;
    return this.snapshot(measurement);
  }

  update(measurement) {
    if (!measurement) return this.block("unavailable", "Microphone unavailable");
    if (!measurement.reliable || BLOCKING_STATES.has(measurement.state)) {
      return this.block(measurement.state || "mixed", measurement.classification || "Mixed / non-power-law", measurement);
    }
    const rawBeta = measurement.beta;
    if (!Number.isFinite(rawBeta)) return this.block("mixed", "Mixed / non-power-law", measurement);
    this.displayBeta = this.displayBeta == null ? rawBeta : this.alpha * rawBeta + (1 - this.alpha) * this.displayBeta;
    const nearest = nearestCanonical(this.displayBeta);
    let proposed = nearest.key;
    if (CANONICAL_COLORS.some((color) => color.key === this.state)) {
      const current = CANONICAL_COLORS.find((color) => color.key === this.state);
      const currentDistance = Math.abs(this.displayBeta - current.beta);
      const proposedDistance = Math.abs(this.displayBeta - nearest.beta);
      if (proposed !== this.state && proposedDistance + this.hysteresis >= currentDistance) proposed = this.state;
    }
    if (proposed !== this.state) {
      if (this.pendingState === proposed) this.pendingCount += 1;
      else {
        this.pendingState = proposed;
        this.pendingCount = 1;
      }
      if (this.pendingCount >= this.requiredObservations) {
        this.state = proposed;
        this.label = CANONICAL_COLORS.find((color) => color.key === proposed)?.label || measurement.classification;
        this.pendingState = null;
        this.pendingCount = 0;
      }
    } else {
      this.pendingState = null;
      this.pendingCount = 0;
      this.label = nearest.label;
    }
    return this.snapshot(measurement);
  }

  snapshot(measurement) {
    return {
      state: this.state,
      label: this.label,
      displayBeta: this.displayBeta,
      rawBeta: measurement?.beta ?? null,
      reliable: CANONICAL_COLORS.some((color) => color.key === this.state),
      pendingState: this.pendingState,
      confidence: measurement?.confidence || "None",
      detail: measurement?.qualityDetail || "",
    };
  }
}

export function createStatusState(state, label, detail = "") {
  return { state, label, detail, displayBeta: null, rawBeta: null, reliable: false, confidence: "None" };
}
