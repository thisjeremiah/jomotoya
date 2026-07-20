// Layer — sound. Procedural (no asset files): a low engine/wind drone while
// driving, a soft filter-sweep sting on focus transitions, near-silence while
// reading. High cinematic value for very little effort.

export class RoadAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneGain: GainNode | null = null;
  private started = false;

  /** Must be called from a user gesture (autoplay policy). Idempotent. */
  start(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.started = true;

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // --- Drone: two detuned low oscillators + filtered noise "wind". ---
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.5;
    this.droneGain.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.Q.value = 0.7;
    lp.connect(this.droneGain);

    const o1 = ctx.createOscillator();
    o1.type = "sawtooth";
    o1.frequency.value = 55;
    const o2 = ctx.createOscillator();
    o2.type = "sawtooth";
    o2.frequency.value = 55 * 1.005; // slight detune -> slow beat
    const og = ctx.createGain();
    og.gain.value = 0.16;
    o1.connect(og);
    o2.connect(og);
    og.connect(lp);
    o1.start();
    o2.start();

    // Wind: white noise through a bandpass.
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500;
    bp.Q.value = 0.5;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.droneGain);
    noise.start();

    // Fade the master in gently.
    this.master.gain.setTargetAtTime(0.5, ctx.currentTime, 1.2);
  }

  /** Engine pitch/intensity tracks speed (0..1). */
  setSpeed(t: number): void {
    if (!this.droneGain || !this.ctx) return;
    this.droneGain.gain.setTargetAtTime(0.28 + t * 0.5, this.ctx.currentTime, 0.15);
  }

  /** Duck the whole bed toward silence while reading, restore while driving. */
  setReading(reading: boolean): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(reading ? 0.06 : 0.5, this.ctx.currentTime, 0.4);
  }

  /** Soft filter-sweep sting on a focus transition. */
  sting(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(300, now);
    f.frequency.exponentialRampToValueAtTime(2400, now + 0.9);
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.9);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.22, now + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
    osc.connect(f);
    f.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + 1.2);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
