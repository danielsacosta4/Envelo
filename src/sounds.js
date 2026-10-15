// Sounds made with the Web Audio API: no files to download. Off by default;
// the choice and volume are per device. Nothing plays while the tab is hidden.

(function (root) {
  const KEY = 'envelo.sound';
  let ctx = null;
  let settings = { on: false, volume: 0.6 };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') settings = { on: !!saved.on, volume: Math.min(1, Math.max(0, Number(saved.volume) || 0)) };
  } catch { /* storage blocked: stay off */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* applies until reload */ }
  }

  function audio() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // One note: oscillator through a gain envelope.
  function tone(a, { freq, type = 'sine', start = 0, dur = 0.15, gain = 0.3, slide = null, attack = 0.005 }) {
    const t0 = a.currentTime + start;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    const peak = gain * settings.volume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Short burst of filtered noise, for paper and stamp sounds.
  function noise(a, { start = 0, dur = 0.12, gain = 0.25, freq = 1200, q = 0.8, type = 'bandpass' }) {
    const t0 = a.currentTime + start;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = a.createGain();
    g.gain.value = gain * settings.volume;
    src.connect(f).connect(g).connect(a.destination);
    src.start(t0);
  }

  const SOUNDS = {
    // A coin clink: two bright partials, slightly detuned.
    coin(a, i = 0) {
      const s = i * 0.07;
      tone(a, { freq: 1976, type: 'triangle', start: s, dur: 0.12, gain: 0.22 });
      tone(a, { freq: 2637, type: 'sine', start: s + 0.035, dur: 0.22, gain: 0.16 });
    },
    // Rubber stamp: a low thump with a papery slap.
    stamp(a) {
      tone(a, { freq: 140, type: 'sine', dur: 0.14, gain: 0.5, slide: 60 });
      noise(a, { dur: 0.08, gain: 0.35, freq: 900, q: 0.6 });
    },
    // Short fanfare: a rising major arpeggio and a held chord.
    fanfare(a) {
      [523, 659, 784].forEach((f, i) => tone(a, { freq: f, type: 'square', start: i * 0.09, dur: 0.12, gain: 0.09 }));
      [523, 659, 784, 1047].forEach((f) => tone(a, { freq: f, type: 'triangle', start: 0.3, dur: 0.6, gain: 0.12 }));
    },
    // Bigger fanfare for goals reached and loans paid off.
    bigFanfare(a) {
      [392, 523, 659, 784, 1047].forEach((f, i) => tone(a, { freq: f, type: 'square', start: i * 0.08, dur: 0.11, gain: 0.08 }));
      [523, 659, 784, 1047, 1319].forEach((f) => tone(a, { freq: f, type: 'triangle', start: 0.45, dur: 0.9, gain: 0.1 }));
      noise(a, { start: 0.45, dur: 0.5, gain: 0.08, freq: 6000, q: 0.3, type: 'highpass' });
    },
    // Cash register: bell plus drawer.
    register(a) {
      tone(a, { freq: 2093, type: 'sine', dur: 0.5, gain: 0.25 });
      tone(a, { freq: 3136, type: 'sine', dur: 0.4, gain: 0.12 });
      noise(a, { start: 0.12, dur: 0.18, gain: 0.25, freq: 500, q: 0.7 });
    },
    // Rising chime for milestones.
    chime(a) {
      [880, 1109, 1319].forEach((f, i) => tone(a, { freq: f, type: 'sine', start: i * 0.1, dur: 0.45, gain: 0.18 }));
    },
    // Soft paper tick when a transaction is saved.
    tick(a) {
      noise(a, { dur: 0.04, gain: 0.3, freq: 3500, q: 1.2 });
      tone(a, { freq: 1200, type: 'sine', dur: 0.05, gain: 0.08 });
    },
    // Low, muted thud: a nudge when an envelope goes overspent.
    thud(a) {
      tone(a, { freq: 110, type: 'sine', dur: 0.25, gain: 0.35, slide: 70 });
    },
    // Paper crumple for deletes.
    crumple(a) {
      for (let i = 0; i < 4; i++) noise(a, { start: i * 0.045, dur: 0.06, gain: 0.22, freq: 1800 + i * 700, q: 0.9 });
    },
    // Undo: a quick downward blip.
    undo(a) {
      tone(a, { freq: 880, type: 'triangle', dur: 0.12, gain: 0.15, slide: 440 });
    },
  };

  function play(name, ...args) {
    if (!settings.on || settings.volume <= 0) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const fn = SOUNDS[name];
    const a = fn && audio();
    if (!a) return;
    try { fn(a, ...args); } catch { /* audio is a nicety; never break the app */ }
  }

  const api = {
    play,
    get on() { return settings.on; },
    get volume() { return settings.volume; },
    set(next) {
      settings = { ...settings, ...next };
      save();
    },
    names: Object.keys(SOUNDS),
  };
  root.Sounds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
