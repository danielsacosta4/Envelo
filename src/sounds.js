// Sounds, made with the Web Audio API: no files to download.
//
// They follow the Poster look: paper, ink and print. Rubber stamps, paper
// slides and crumples, metal coins, a till bell, and warm wooden mallets
// (a marimba) for the happy moments, all through a small room echo so they
// sound like objects on a desk rather than beeps.
//
// Off by default; the choice and volume are per device. Nothing plays while
// the tab is hidden.

(function (root) {
  const KEY = 'envelo.sound';
  let ctx = null;
  let chain = null;
  let settings = { on: false, volume: 0.6 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') settings = { on: !!saved.on, volume: Math.min(1, Math.max(0, Number(saved.volume) || 0)) };
  } catch { /* storage blocked: stay off */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* applies until reload */ }
  }

  // Output chain: dry + a short room echo, gently compressed.
  function buildChain(a, volume) {
    const master = a.createGain();
    master.gain.value = volume;
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    const input = a.createGain();
    const dry = a.createGain();
    dry.gain.value = 0.85;
    const wet = a.createGain();
    wet.gain.value = 0.22;
    const room = a.createConvolver();
    room.buffer = roomImpulse(a, 0.9);
    input.connect(dry).connect(comp);
    input.connect(room).connect(wet).connect(comp);
    comp.connect(master).connect(a.destination);
    return { input, master };
  }

  // A small wooden room: decaying noise, darker as it fades.
  function roomImpulse(a, seconds) {
    const len = Math.floor(a.sampleRate * seconds);
    const buf = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = Math.random() * 2 - 1;
        last = last + (n - last) * (0.6 - 0.5 * t); // low-pass that closes as it decays
        d[i] = last * (1 - t) ** 3.2;
      }
    }
    return buf;
  }

  function audio() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      chain = buildChain(ctx, settings.volume);
    }
    if (ctx.state === 'suspended') ctx.resume();
    chain.master.gain.value = settings.volume;
    return ctx;
  }

  // Building blocks. Every voice takes the context, an output node and a
  // start time in seconds from now.

  function env(a, g, t0, attack, peak, decay) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // Marimba-like mallet: a sine with a quick, slightly sharp attack and the
  // bar's 4th partial, decaying fast. Warm and wooden, not electronic.
  function mallet(a, out, t, freq, { gain = 0.35, decay = 0.6 } = {}) {
    const t0 = a.currentTime + t;
    const g = a.createGain();
    env(a, g, t0, 0.004, gain, decay);
    const body = a.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(freq * 1.01, t0);
    body.frequency.exponentialRampToValueAtTime(freq, t0 + 0.03);
    const p4 = a.createOscillator();
    p4.type = 'sine';
    p4.frequency.value = freq * 3.98;
    const p4g = a.createGain();
    env(a, p4g, t0, 0.002, gain * 0.35, decay * 0.18);
    body.connect(g).connect(out);
    p4.connect(p4g).connect(out);
    // The mallet hitting the bar.
    noise(a, out, t, { dur: 0.012, gain: gain * 0.25, freq: freq * 6, q: 1.5 });
    for (const o of [body, p4]) { o.start(t0); o.stop(t0 + decay + 0.05); }
  }

  // Metal: inharmonic partials, like a coin or a small bell.
  function metal(a, out, t, freq, { gain = 0.2, decay = 0.35, ratios = [1, 2.76, 5.4, 8.93] } = {}) {
    const t0 = a.currentTime + t;
    ratios.forEach((r, k) => {
      const o = a.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * r;
      const g = a.createGain();
      env(a, g, t0, 0.002, gain / (k + 1), decay / (1 + k * 0.6));
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + decay + 0.05);
    });
  }

  // Filtered noise burst, for paper, ink and thumps. `sweep` slides the
  // filter to another frequency over the burst.
  function noise(a, out, t, { dur = 0.1, gain = 0.25, freq = 1500, q = 0.8, type = 'bandpass', sweep = null, attack = 0.004 }) {
    const t0 = a.currentTime + t;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
    f.Q.value = q;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t0);
  }

  // A low, round knock: a pitch-dropping sine, like a hand on a table.
  function knock(a, out, t, { freq = 120, to = 55, gain = 0.6, decay = 0.16 } = {}) {
    const t0 = a.currentTime + t;
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + decay);
    const g = a.createGain();
    env(a, g, t0, 0.003, gain, decay);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + decay + 0.05);
  }

  // Notes (Hz) of a warm C major, used by the happy sounds.
  const N = { G3: 196, C4: 261.63, E4: 329.63, G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, C6: 1046.5 };

  const SOUNDS = {
    // A coin dropping into the envelope: a small metal ting and a paper tap.
    coin(a, out, t = 0) {
      metal(a, out, t, 2350 + Math.random() * 180, { gain: 0.22, decay: 0.3 });
      noise(a, out, t + 0.012, { dur: 0.03, gain: 0.12, freq: 3200, q: 1.2 });
    },
    // Rubber stamp: a soft thump, the ink slap, and a little paper.
    stamp(a, out, t = 0) {
      knock(a, out, t, { freq: 150, to: 60, gain: 0.55, decay: 0.14 });
      noise(a, out, t, { dur: 0.06, gain: 0.32, freq: 900, q: 0.7 });
      noise(a, out, t + 0.03, { dur: 0.09, gain: 0.08, freq: 4200, q: 0.6, sweep: 2500 });
    },
    // Every euro has a job: a rising marimba run, then the stamp.
    fanfare(a, out, t = 0) {
      [N.C5, N.E5, N.G5, N.C6].forEach((f, i) => mallet(a, out, t + i * 0.085, f, { gain: 0.3, decay: 0.55 }));
      [N.C4, N.E4, N.G4].forEach((f) => mallet(a, out, t + 0.36, f, { gain: 0.16, decay: 0.9 }));
      SOUNDS.stamp(a, out, t + 0.42);
    },
    // Goal reached or loan paid off: a longer run and a bell on top.
    bigFanfare(a, out, t = 0) {
      [N.G3, N.C4, N.E4, N.G4, N.C5, N.E5, N.G5].forEach((f, i) => mallet(a, out, t + i * 0.07, f, { gain: 0.26, decay: 0.6 }));
      [N.C4, N.E4, N.G4, N.C5].forEach((f) => mallet(a, out, t + 0.55, f, { gain: 0.15, decay: 1.3 }));
      metal(a, out, t + 0.55, N.C6, { gain: 0.1, decay: 1.4, ratios: [1, 2.0, 3.01, 4.2] });
    },
    // Reconciled: the till bell and the drawer sliding shut.
    register(a, out, t = 0) {
      metal(a, out, t, 1568, { gain: 0.16, decay: 0.9, ratios: [1, 2.0, 2.98, 4.1] });
      noise(a, out, t + 0.18, { dur: 0.16, gain: 0.16, freq: 700, q: 0.6, sweep: 300 });
      knock(a, out, t + 0.33, { freq: 110, to: 70, gain: 0.35, decay: 0.12 });
    },
    // Milestone: three mallet notes going up.
    chime(a, out, t = 0) {
      [N.E5, N.G5, N.C6].forEach((f, i) => mallet(a, out, t + i * 0.11, f, { gain: 0.26, decay: 0.7 }));
    },
    // Saved: a sheet of paper sliding into place.
    tick(a, out, t = 0) {
      noise(a, out, t, { dur: 0.11, gain: 0.24, freq: 2600, q: 0.7, sweep: 1400, attack: 0.02 });
      noise(a, out, t + 0.1, { dur: 0.02, gain: 0.2, freq: 2000, q: 1.5 });
    },
    // Overspent: a soft, low wooden knock. A nudge, not an alarm.
    thud(a, out, t = 0) {
      knock(a, out, t, { freq: 95, to: 62, gain: 0.45, decay: 0.2 });
      mallet(a, out, t + 0.01, N.G3, { gain: 0.08, decay: 0.3 });
    },
    // Deleted: paper being crumpled.
    crumple(a, out, t = 0) {
      for (let i = 0; i < 9; i++) {
        noise(a, out, t + i * 0.028 + Math.random() * 0.012, {
          dur: 0.025 + Math.random() * 0.03, gain: 0.1 + Math.random() * 0.12, freq: 1200 + Math.random() * 3800, q: 0.9 + Math.random() * 1.5,
        });
      }
    },
    // Undo: the paper slide in reverse, going up.
    undo(a, out, t = 0) {
      noise(a, out, t, { dur: 0.12, gain: 0.12, freq: 1300, q: 0.7, sweep: 2800, attack: 0.03 });
      mallet(a, out, t + 0.09, N.G4, { gain: 0.1, decay: 0.25 });
    },
    // The panel opening: a quick paper whoosh.
    whoosh(a, out, t = 0) {
      noise(a, out, t, { dur: 0.18, gain: 0.14, freq: 600, q: 0.5, sweep: 2200, attack: 0.06 });
    },
  };

  function play(name, ...args) {
    if (!settings.on || settings.volume <= 0) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const fn = SOUNDS[name];
    const a = fn && audio();
    if (!a) return;
    try { fn(a, chain.input, ...args); } catch { /* audio is a nicety; never break the app */ }
  }

  // Render a sound without playing it (used to make preview files).
  async function render(name, sampleRate = 44100) {
    const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const a = new OAC(2, Math.floor(sampleRate * 2.4), sampleRate);
    const c = buildChain(a, 0.8);
    SOUNDS[name](a, c.input, 0.02);
    return a.startRendering();
  }

  const api = {
    play,
    render,
    get on() { return settings.on; },
    get volume() { return settings.volume; },
    set(next) {
      settings = { ...settings, ...next };
      if (chain) chain.master.gain.value = settings.volume;
      save();
    },
    names: Object.keys(SOUNDS),
  };
  root.Sounds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
