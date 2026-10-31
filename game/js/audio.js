// Ricochet Rumble — sound effects and music, synthesized with WebAudio
// (no audio files needed).
window.RR = window.RR || {};

(function () {
  class Audio {
    constructor() {
      this.ctx = null;
      this.musicOn = true;
      this.sfxVolume = 0.8;
      this.musicVolume = 0.22;
      this.step = 0;
      this.nextNoteTime = 0;
      this.timer = null;
    }

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 1;
        this.master.connect(this.ctx.destination);
        this.sfx = this.ctx.createGain();
        this.sfx.gain.value = this.sfxVolume;
        this.sfx.connect(this.master);
        this.music = this.ctx.createGain();
        this.music.gain.value = this.musicOn ? this.musicVolume : 0;
        this.music.connect(this.master);
        const len = this.ctx.sampleRate * 2; // > longest burst + random start offset
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.startMusic();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    get ready() {
      return this.ctx && this.ctx.state === 'running';
    }

    setMusic(on) {
      this.musicOn = on;
      if (this.music) this.music.gain.setTargetAtTime(on ? this.musicVolume : 0, this.ctx.currentTime, 0.1);
    }

    // ---- primitives ----------------------------------------------------------------
    tone({ freq = 440, to = null, type = 'sine', dur = 0.15, vol = 0.3, attack = 0.005, at = 0, dest = null }) {
      if (!this.ready) return;
      const t0 = this.ctx.currentTime + at;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(dest || this.sfx);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }

    burst({ dur = 0.2, vol = 0.3, freq = 1000, to = null, q = 1, type = 'bandpass', at = 0, dest = null }) {
      if (!this.ready) return;
      const t0 = this.ctx.currentTime + at;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(freq, t0);
      if (to) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(g);
      g.connect(dest || this.sfx);
      src.start(t0, Math.random() * 0.5);
      src.stop(t0 + dur + 0.05);
    }

    // ---- effects ----------------------------------------------------------------------
    fire() {
      this.burst({ dur: 0.12, vol: 0.45, freq: 2200, to: 500, q: 0.8 });
      this.tone({ freq: 180, to: 60, type: 'triangle', dur: 0.12, vol: 0.4 });
    }

    bounce() {
      this.tone({ freq: 1500 + Math.random() * 300, to: 900, type: 'square', dur: 0.06, vol: 0.06 });
      this.tone({ freq: 2600, type: 'sine', dur: 0.08, vol: 0.08 });
    }

    puff() {
      this.burst({ dur: 0.15, vol: 0.18, freq: 800, to: 300, q: 0.7 });
    }

    clash() {
      this.tone({ freq: 2200, to: 1200, type: 'square', dur: 0.08, vol: 0.08 });
      this.burst({ dur: 0.18, vol: 0.25, freq: 3000, to: 800, q: 1.2 });
    }

    dry() {
      this.tone({ freq: 300, type: 'square', dur: 0.03, vol: 0.05 });
    }

    mineLay() {
      this.tone({ freq: 140, to: 90, type: 'triangle', dur: 0.12, vol: 0.35 });
      this.tone({ freq: 1200, type: 'square', dur: 0.03, vol: 0.05, at: 0.05 });
    }

    mineBeep(urgent) {
      this.tone({ freq: urgent ? 1320 : 990, type: 'square', dur: 0.05, vol: urgent ? 0.09 : 0.05 });
    }

    explosion(big) {
      const v = big ? 0.9 : 0.7;
      this.burst({ dur: big ? 1.1 : 0.8, vol: v, freq: 1200, to: 60, q: 0.5, type: 'lowpass' });
      this.tone({ freq: big ? 110 : 140, to: 30, type: 'sine', dur: big ? 0.7 : 0.5, vol: v * 0.8 });
      this.burst({ dur: 0.25, vol: 0.3, freq: 4000, to: 1500, q: 0.6, at: 0.02 });
    }

    crate() {
      this.burst({ dur: 0.35, vol: 0.35, freq: 500, to: 150, q: 1.5 });
    }

    countdown() {
      this.tone({ freq: 660, type: 'square', dur: 0.12, vol: 0.08 });
    }

    go() {
      this.tone({ freq: 880, type: 'square', dur: 0.25, vol: 0.1 });
      this.tone({ freq: 1320, type: 'triangle', dur: 0.3, vol: 0.08 });
    }

    roundStart() {
      [523, 659, 784].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.16, vol: 0.12, at: i * 0.11 }));
    }

    roundWin() {
      [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, type: 'square', dur: 0.14, vol: 0.06, at: i * 0.09 }));
      this.tone({ freq: 1046, type: 'triangle', dur: 0.5, vol: 0.1, at: 0.36 });
    }

    roundDraw() {
      [494, 466, 440].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.2, vol: 0.12, at: i * 0.16 }));
    }

    matchWin() {
      const seq = [523, 523, 523, 659, 784, 659, 784, 1046];
      seq.forEach((f, i) => this.tone({ freq: f, type: 'square', dur: 0.16, vol: 0.07, at: i * 0.13 }));
      this.tone({ freq: 1046, type: 'triangle', dur: 0.9, vol: 0.12, at: seq.length * 0.13 });
    }

    click() {
      this.tone({ freq: 700, to: 500, type: 'triangle', dur: 0.05, vol: 0.12 });
    }

    connect() {
      this.tone({ freq: 660, type: 'triangle', dur: 0.1, vol: 0.12 });
      this.tone({ freq: 990, type: 'triangle', dur: 0.14, vol: 0.12, at: 0.09 });
    }

    disconnect() {
      this.tone({ freq: 660, type: 'triangle', dur: 0.1, vol: 0.12 });
      this.tone({ freq: 440, type: 'triangle', dur: 0.16, vol: 0.12, at: 0.09 });
    }

    // ---- music: a little original snare-drum march -----------------------------------------
    startMusic() {
      this.bpm = 112;
      this.nextNoteTime = this.ctx.currentTime + 0.2;
      this.step = 0;
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.schedule(), 30);
    }

    schedule() {
      if (!this.ready) return;
      const stepDur = 60 / this.bpm / 4; // sixteenth notes
      while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
        this.playStep(this.step, this.nextNoteTime - this.ctx.currentTime);
        this.nextNoteTime += stepDur;
        this.step = (this.step + 1) % 128;
      }
    }

    playStep(step, at) {
      if (!this.musicOn) return;
      const dest = this.music;
      const beat = step % 16;
      const bar = Math.floor(step / 16) % 8;
      // snare cadence
      const snare = [1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0];
      if (snare[beat]) this.burst({ dur: 0.07, vol: beat % 4 === 0 ? 0.35 : 0.18, freq: 3500, q: 0.9, at, dest });
      if (beat % 8 === 0) this.tone({ freq: 70, to: 40, type: 'sine', dur: 0.18, vol: 0.5, at, dest });
      // bass line
      const roots = [48, 48, 53, 55, 48, 48, 53, 55];
      if (beat % 4 === 0) {
        const n = roots[bar] + (beat === 8 ? 7 : 0) - 12;
        this.tone({ freq: midi(n), type: 'triangle', dur: 0.22, vol: 0.32, at, dest });
      }
      // melody on bars 4-7 only, so it does not get tiresome
      if (bar >= 4) {
        const mel = [
          [72, 0, 76, 0, 79, 0, 76, 0, 77, 0, 0, 0, 76, 0, 74, 0],
          [72, 0, 76, 0, 79, 0, 81, 0, 79, 0, 0, 0, 0, 0, 0, 0],
          [77, 0, 76, 0, 74, 0, 72, 0, 74, 0, 76, 0, 77, 0, 79, 0],
          [76, 0, 74, 0, 71, 0, 74, 0, 72, 0, 0, 0, 0, 0, 0, 0],
        ][bar - 4];
        if (mel[beat]) this.tone({ freq: midi(mel[beat]), type: 'square', dur: 0.14, vol: 0.06, at, dest });
      }
    }
  }

  function midi(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  RR.Audio = Audio;
})();
