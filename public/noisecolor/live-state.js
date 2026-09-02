import { CANONICAL_COLORS, nearestCanonical } from "./analysis-engine.js?v=0.6.7";

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
    this.candidateBeta = null;
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
    this.candidateBeta = null;
    return this.snapshot(measurement);
  }

  update(measurement) {
    if (!measurement) return this.block("unavailable", "Microphone unavailable");
    if (!measurement.reliable || BLOCKING_STATES.has(measurement.state)) {
      return this.block(measurement.state || "mixed", measurement.classification || "Mixed / non-power-law", measurement);
    }
    const rawBeta = measurement.beta;
    if (!Number.isFinite(rawBeta)) return this.block("mixed", "Mixed / non-power-law", measurement);
    this.candidateBeta = this.candidateBeta == null ? rawBeta : this.alpha * rawBeta + (1 - this.alpha) * this.candidateBeta;
    const nearest = nearestCanonical(this.candidateBeta);
    let proposed = nearest.key;
    if (CANONICAL_COLORS.some((color) => color.key === this.state)) {
      const current = CANONICAL_COLORS.find((color) => color.key === this.state);
      const currentDistance = Math.abs(this.candidateBeta - current.beta);
      const proposedDistance = Math.abs(this.candidateBeta - nearest.beta);
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
        this.displayBeta = this.candidateBeta;
        this.pendingState = null;
        this.pendingCount = 0;
      }
    } else {
      this.pendingState = null;
      this.pendingCount = 0;
      this.label = CANONICAL_COLORS.find((color) => color.key === this.state)?.label || nearest.label;
      this.displayBeta = this.candidateBeta;
    }
    return this.snapshot(measurement);
  }

  snapshot(measurement) {
    const canonical = CANONICAL_COLORS.find((color) => color.key === this.state);
    const reliable = Boolean(canonical);
    const detail = reliable && Number.isFinite(this.displayBeta)
      ? `Smoothed stable β ${this.displayBeta.toFixed(2)} is reported as ${canonical.label}; latest stable-window β ${Number.isFinite(measurement?.beta) ? measurement.beta.toFixed(2) : "—"}.${this.pendingState ? " A possible transition is still being confirmed." : ""}`
      : measurement?.qualityDetail || "";
    let confidence = "None";
    if (reliable && Number.isFinite(this.displayBeta)) {
      if (this.pendingState) confidence = "Provisional";
      else {
        const distance = Math.abs(this.displayBeta - canonical.beta);
        if (measurement?.rmseDb <= 2.2 && distance <= 0.3 && (measurement?.temporalSd || 0) <= 0.16) confidence = "High";
        else if (measurement?.rmseDb <= 3.8 && distance <= 0.55 && (measurement?.temporalSd || 0) <= 0.35) confidence = "Moderate";
        else confidence = "Low";
      }
    }
    return {
      state: this.state,
      label: reliable ? canonical.label : this.label,
      displayBeta: this.displayBeta,
      rawBeta: measurement?.beta ?? null,
      candidateBeta: this.candidateBeta,
      reliable,
      pendingState: this.pendingState,
      confidence,
      detail,
    };
  }
}

export function createStatusState(state, label, detail = "") {
  return { state, label, detail, displayBeta: null, rawBeta: null, reliable: false, confidence: "None" };
}
