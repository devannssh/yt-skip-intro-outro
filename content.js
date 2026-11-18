(() => {
  const FPS = 20;          // audio fingerprint frames per second
  const WIN = 120;         // frames compared when matching (6 seconds)
  const BER_MAX = 0.35;    // max bit-error rate to count as a match (random audio ≈ 0.5)
  const LABEL = { intro: 'Skip intro', outro: 'Skip outro', recap: 'Skip recap' };

  let cfg = { auto: false, sb: true, chapters: true, learn: true };
  let tpls = [], segs = [], frames = new Map();
  let video, vid, ui, ctx, analyser, fbuf, edges, audioFailed = false;
  let pd = null, lastSlot = -1, mk = null, shown = null, chapDone = false, loadedAt = 0, toastTimer;

  chrome.storage.local.get(['cfg', 'tpls'], r => { cfg = { ...cfg, ...r.cfg }; tpls = r.tpls || []; });
  chrome.storage.onChanged.addListener(c => {
    if (c.cfg) cfg = { ...cfg, ...c.cfg.newValue };
    if (c.tpls) tpls = c.tpls.newValue || [];
  });

  const pc = x => { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24; };
  const channel = () => (document.querySelector('ytd-watch-metadata #owner ytd-channel-name a')?.textContent || '').trim();

  // ---------- Source 1 + 2: community data & chapters ----------
  function load(id) {
    vid = id; segs = []; frames.clear(); pd = null; lastSlot = -1; mk = null;
    chapDone = false; loadedAt = Date.now(); shown = null;
    if (!id || !cfg.sb) return;
    chrome.runtime.sendMessage({ type: 'sb', videoId: id }, r => {
      void chrome.runtime.lastError;
      if (id === vid && Array.isArray(r)) segs.push(...r);
    });
  }

  function kindOf(t) {
    if (/\b(recap|previously)\b/i.test(t)) return 'recap';
    if (/\b(intro(duction)?|opening|title (sequence|card)|prologue)\b/i.test(t) || /\bOP\d?\b/.test(t)) return 'intro';
    if (/\b(outro|ending|credits|end card|preview|next episode)\b/i.test(t) || /\bED\d?\b/.test(t)) return 'outro';
    return null;
  }

  function chapters() {
    const el = document.querySelector('#description-inline-expander');
    if (!el || !video.duration) return [];
    const rows = [], re = /(\d{1,2}(?::\d{2}){1,2})\s*[-–—:)\]]*\s*([^\n]*)/g;
    let m;
    while ((m = re.exec(el.innerText))) {
      const t = m[1].split(':').reduce((a, n) => a * 60 + +n, 0);
      if (!rows.length || t > rows[rows.length - 1].t) rows.push({ t, title: m[2] });
    }
    if (rows.length < 2) return [];
    return rows.map((r, i) => ({
      start: r.t, end: i + 1 < rows.length ? rows[i + 1].t : video.duration,
      kind: kindOf(r.title), src: 'Chapter'
    })).filter(s => s.kind);
  }

  // ---------- Source 3: learn from you (audio fingerprint) ----------
  function initAudio() {
    if (ctx || audioFailed) return;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(video);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 16384; analyser.smoothingTimeConstant = 0;
      src.connect(analyser); analyser.connect(ctx.destination);
      fbuf = new Float32Array(analyser.frequencyBinCount);
      const bw = ctx.sampleRate / analyser.fftSize, lo = Math.log(300 / bw), hi = Math.log(5000 / bw);
      edges = [];
      for (let i = 0; i <= 33; i++)
        edges.push(Math.max(i ? edges[i - 1] + 1 : 0, Math.round(Math.exp(lo + (hi - lo) * i / 33))));
    } catch (e) { audioFailed = true; ctx = analyser = null; }
  }

  function sample() {
    if (!analyser || video.paused || video.seeking || video.playbackRate !== 1 || ctx.state !== 'running') { pd = null; return; }
    const slot = Math.floor(video.currentTime * FPS);
    if (slot === lastSlot) return;
    analyser.getFloatFrequencyData(fbuf);
    const e = []; let tot = 0;
    for (let b = 0; b < 33; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += Math.pow(10, fbuf[k] / 10);
      e.push(s); tot += s;
    }
    if (tot < 1e-7) { pd = null; lastSlot = slot; return; }   // silence / DRM-muted audio
    const d = []; for (let b = 0; b < 32; b++) d.push(e[b] - e[b + 1]);
    if (pd && slot === lastSlot + 1) {
      let h = 0; for (let b = 0; b < 32; b++) if (d[b] - pd[b] > 0) h |= 1 << b;
      frames.set(slot, h);
      frames.delete(slot - FPS * 600);          // keep ~10 minutes of history
      match(slot);
    }
    pd = d; lastSlot = slot;
  }

  function match(slot) {
    const ch = channel();
    for (const t of tpls) {
      if (t.channel && ch && t.channel !== ch) continue;
      let best = 1;
      for (const sh of [-1, 0, 1]) {
        let err = 0;
        for (let i = 0; i < WIN; i++) {
          const f = frames.get(slot - WIN + 1 + i + sh);
          err += f === undefined ? 16 : pc(f ^ t.f[i]);
        }
        best = Math.min(best, err / (WIN * 32));
      }
      if (best < BER_MAX) {
        const start = (slot - WIN + 1) / FPS;
        if (!segs.some(s => s.src === 'Learned' && s.kind === t.kind && Math.abs(s.start - start) < 10))
          segs.push({ start, end: start + t.dur, kind: t.kind, src: 'Learned' });
      }
    }
  }

  function mark(kind) {
    initAudio();
    if (!ctx) return toast('Audio capture is not available on this video.');
    ctx.resume();
    if (!mk) { mk = { kind, t: video.currentTime }; return toast('Marking ' + kind + '… click again where it ends.', true); }
    if (mk.kind !== kind) return toast('Finish marking the ' + mk.kind + ' first.');
    const t0 = mk.t, t1 = video.currentTime, dur = t1 - t0; mk = null;
    if (dur < WIN / FPS + 0.5) return toast('Too short. Mark at least 7 seconds.');
    const s0 = Math.floor(t0 * FPS), f = []; let miss = 0;
    for (let i = 0; i < WIN; i++) { let h = frames.get(s0 + i); if (h === undefined) { miss++; h = f[i - 1] || 0; } f.push(h); }
    if (miss > WIN * 0.15) return toast('Could not hear it. Keep this tab in front and play it normally.');
    tpls = [...tpls, { id: Date.now(), channel: channel(), kind, dur, f, title: document.title.slice(0, 50) }];
    chrome.storage.local.set({ tpls });
    segs.push({ start: t0, end: t1, kind, src: 'Learned', done: true });
    toast('Saved! I will now spot this ' + kind + ' when it plays again.');
  }

  // ---------- UI ----------
  function mount() {
    const p = document.getElementById('movie_player');
    if (!p) return;
    ui = document.createElement('div');
    ui.className = 'sio';
    ui.innerHTML = '<button class="sio-skip" hidden></button>' +
      '<div class="sio-tools"><button data-k="intro">Mark intro</button><button data-k="outro">Mark outro</button></div>' +
      '<div class="sio-toast"></div>';
    ['click', 'dblclick', 'mousedown'].forEach(ev => ui.addEventListener(ev, e => e.stopPropagation()));
    ui.querySelector('.sio-skip').onclick = () => shown && skip(shown);
    ui.querySelector('.sio-tools').onclick = e => { const k = e.target.dataset.k; if (k) { mark(k); refreshTools(); } };
    p.appendChild(ui);
  }

  function refreshTools() {
    ui.querySelector('.sio-tools').classList.toggle('on', !!mk);
    ui.querySelectorAll('.sio-tools button').forEach(b => {
      b.textContent = mk && mk.kind === b.dataset.k ? '■ End ' + b.dataset.k : 'Mark ' + b.dataset.k;
    });
  }

  function toast(msg) {
    if (!ui) return;
    const el = ui.querySelector('.sio-toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  function skip(s) {
    video.currentTime = Math.min(s.end, (video.duration || s.end) - 0.1);
    toast(LABEL[s.kind].replace('Skip', 'Skipped'));
  }

  // ---------- main loop ----------
  setInterval(() => {
    const v = document.querySelector('video.html5-main-video');
    if (!v) return;
    video = v;
    const id = new URLSearchParams(location.search).get('v');
    if (id !== vid) load(id);
    if (!ui || !ui.isConnected) mount();
    if (!ui) return;
    if (!ctx && cfg.learn && !video.paused && tpls.length) initAudio();
    if (ctx && ctx.state === 'suspended' && !video.paused) ctx.resume();
    if (cfg.learn) sample();
    if (cfg.chapters && !chapDone && Date.now() - loadedAt > 2500) {
      const c = chapters();
      if (c.length || Date.now() - loadedAt > 9000) { segs.push(...c); chapDone = true; }
    }
    const t = video.currentTime;
    const s = segs.find(s => s.kind && s.end - s.start > 1 && t >= s.start - 0.3 && t < s.end - 0.5);
    if (s !== shown) {
      shown = s;
      const b = ui.querySelector('.sio-skip');
      b.hidden = !s;
      if (s) b.textContent = LABEL[s.kind] + ' ⏭';
    }
    if (s && cfg.auto && !s.done) { s.done = true; skip(s); }
  }, 25);
})();
