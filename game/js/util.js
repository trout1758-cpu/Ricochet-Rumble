window.RR = window.RR || {};

RR.util = {
  TAU: Math.PI * 2,

  clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  },

  lerp(a, b, t) {
    return a + (b - a) * t;
  },

  wrapAngle(a) {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
  },

  // Signed shortest rotation from `from` to `to`, in (-PI, PI].
  angleDiff(to, from) {
    return RR.util.wrapAngle(to - from);
  },

  approachAngle(current, target, maxStep) {
    const d = RR.util.angleDiff(target, current);
    if (Math.abs(d) <= maxStep) return RR.util.wrapAngle(target);
    return RR.util.wrapAngle(current + Math.sign(d) * maxStep);
  },

  // Small deterministic PRNG so textures look the same every frame.
  rng(seed) {
    let s = seed >>> 0 || 1;
    return function next() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  },

  hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },

  shade(hex, amt) {
    const [r, g, b] = RR.util.hexToRgb(hex);
    const f = (v) => RR.util.clamp(Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt), 0, 255);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  },
};
