// Colour for the Image Editor, ported from ImageDB/src/image-editor.js:
// six adjustment dials, looks (presets), and tone curves with a histogram.
// Edits are ops in the same stack as crop/rotate: geometry folds into one
// transform, colour ops apply in stack order (runs of filter ops collapse into
// one Canvas filter pass; a curves op is a per-pixel pass between them).
(function (global) {
  'use strict';

  // Dials in user units centred on zero; mapped to Canvas filters at render time.
  const ADJUSTMENTS = [
    { key: 'brightness', label: 'Brightness', min: -100, max: 100, unit: '%', bipolar: true },
    { key: 'contrast',   label: 'Contrast',   min: -100, max: 100, unit: '%', bipolar: true },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, unit: '%', bipolar: true },
    { key: 'warmth',     label: 'Warmth',     min: -100, max: 100, unit: '%', bipolar: true },
    { key: 'hue',        label: 'Hue',        min: -180, max: 180, unit: '°', bipolar: true },
    // Blur has no meaningful negative side, so it starts at its end.
    { key: 'blur',       label: 'Blur',       min: 0,    max: 100, unit: '',  bipolar: false },
  ];
  const PRESETS = [
    { name: 'Mono',  params: { saturation: -100, contrast: 10 } },
    { name: 'Warm',  params: { warmth: 35, saturation: 15, brightness: 4 } },
    { name: 'Cool',  params: { warmth: -35, saturation: 10, brightness: 2 } },
    { name: 'Faded', params: { contrast: -15, saturation: -20, brightness: 8 } },
    { name: 'Punch', params: { contrast: 25, saturation: 35 } },
  ];
  const num = (value) => Number(value) || 0;
  function neutral() { return Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])); }
  function isNeutral(params) { return ADJUSTMENTS.every((a) => num(params && params[a.key]) === 0); }

  function filterString(ops) {
    const parts = [];
    for (const op of ops) {
      if (op.type !== 'adjust') continue;
      const p = op.params || {};
      if (num(p.brightness)) parts.push(`brightness(${(1 + num(p.brightness) / 100).toFixed(3)})`);
      if (num(p.contrast))   parts.push(`contrast(${(1 + num(p.contrast) / 100).toFixed(3)})`);
      if (num(p.saturation)) parts.push(`saturate(${Math.max(0, 1 + num(p.saturation) / 100).toFixed(3)})`);
      // Warmth is bipolar: the warm side leans sepia, the cool side turns toward blue.
      if (num(p.warmth) > 0) parts.push(`sepia(${(num(p.warmth) / 100 * 0.6).toFixed(3)})`);
      if (num(p.warmth) < 0) parts.push(`hue-rotate(${(num(p.warmth) * 0.25).toFixed(1)}deg)`);
      if (num(p.hue)) parts.push(`hue-rotate(${num(p.hue)}deg)`);
      if (num(p.blur) > 0) parts.push(`blur(${(num(p.blur) / 100 * 12).toFixed(2)}px)`);
    }
    return parts.join(' ');
  }

  // ── Curves ──
  // Monotone cubic (Fritsch–Carlson / PCHIP): unlike a natural spline it cannot
  // overshoot between control points, so no haloing or clipped highlights.
  function buildLut(points) {
    const lut = new Uint8ClampedArray(256);
    const pts = (Array.isArray(points) ? points : [])
      .map((p) => [Math.min(1, Math.max(0, num(p[0]))), Math.min(1, Math.max(0, num(p[1])))])
      .sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const delta = [];
    for (let i = 0; i < n - 1; i++) { const dx = xs[i + 1] - xs[i]; delta.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx); }
    const m = new Array(n).fill(0);
    m[0] = delta[0]; m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / delta[i], b = m[i + 1] / delta[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * delta[i]; m[i + 1] = t * b * delta[i]; }
    }
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let seg = n - 2;
      for (let s = 0; s < n - 1; s++) { if (x <= xs[s + 1]) { seg = s; break; } }
      const x0 = xs[seg], dx = xs[seg + 1] - x0;
      let y;
      if (dx === 0) y = ys[seg + 1];
      else {
        const t = Math.min(1, Math.max(0, (x - x0) / dx)), t2 = t * t, t3 = t2 * t;
        y = (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * dx * m[seg] + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * dx * m[seg + 1];
      }
      lut[i] = Math.round(Math.min(1, Math.max(0, y)) * 255);
    }
    return lut;
  }
  // Four independent curves: an RGB composite plus one per channel.
  const CHANNELS = ['rgb', 'r', 'g', 'b'];
  const IDENTITY = [[0, 0], [1, 1]];
  function newCurves() { return { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] }; }
  function curveSet(params) {
    const c = (params && params.curves) || {};
    const pick = (pts) => (Array.isArray(pts) && pts.length >= 2 ? pts : IDENTITY);
    return { rgb: pick(c.rgb), r: pick(c.r), g: pick(c.g), b: pick(c.b) };
  }
  function channelIsIdentity(points) {
    return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1;
  }
  function curvesAreIdentity(params) { const set = curveSet(params); return CHANNELS.every((k) => channelIsIdentity(set[k])); }
  function applyCurves(canvas, params) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height), data = image.data;
    const set = curveSet(params);
    // The composite runs first and feeds the per-channel curves (master, then trims).
    const master = buildLut(set.rgb), red = buildLut(set.r), green = buildLut(set.g), blue = buildLut(set.b);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = red[master[data[i]]];
      data[i + 1] = green[master[data[i + 1]]];
      data[i + 2] = blue[master[data[i + 2]]];
    }
    ctx.putImageData(image, 0, 0);
  }

  // Colour passes over a canvas already drawn with the geometry, in stack order.
  function applyColour(canvas, ops) {
    let pending = [];
    const flush = () => {
      const filter = filterString(pending); pending = [];
      if (!filter) return canvas;
      const next = document.createElement('canvas');
      next.width = canvas.width; next.height = canvas.height;
      const ctx = next.getContext('2d');
      if (!('filter' in ctx)) throw new Error('Image adjustments are unavailable in this browser.');
      ctx.filter = filter; ctx.drawImage(canvas, 0, 0);
      canvas.width = canvas.height = 1;
      return next;
    };
    for (const op of ops) {
      if (op.type === 'curves') { canvas = flush(); if (!curvesAreIdentity(op.params)) applyCurves(canvas, op.params); }
      else if (op.type === 'adjust') pending.push(op);
    }
    return flush();
  }

  // Histogram of what the curve is reshaping (the render beneath it).
  function histogram(canvas) {
    if (!canvas || !canvas.width) return null;
    try {
      const sample = document.createElement('canvas');
      const scale = Math.min(1, 220 / Math.max(canvas.width, canvas.height));
      sample.width = Math.max(1, Math.round(canvas.width * scale)); sample.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = sample.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
      const data = ctx.getImageData(0, 0, sample.width, sample.height).data;
      const bins = { rgb: new Array(256).fill(0), r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) };
      for (let i = 0; i < data.length; i += 4) {
        bins.r[data[i]]++; bins.g[data[i + 1]]++; bins.b[data[i + 2]]++;
        bins.rgb[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)]++;
      }
      sample.width = sample.height = 1;
      return bins;
    } catch (_) { return null; }
  }

  // Above the diagonal the channel is boosted, below it cut: the pad's gradient
  // tells which way a drag will push the colour.
  const GUIDE = {
    rgb: ['rgba(255,255,255,.16)', 'rgba(0,0,0,.28)'],
    r: ['rgba(248,113,113,.30)', 'rgba(34,211,238,.26)'],
    g: ['rgba(74,222,128,.30)', 'rgba(232,121,249,.26)'],
    b: ['rgba(96,165,250,.30)', 'rgba(250,204,21,.26)'],
  };
  function drawPad(canvas, channel, points, bins) {
    const size = canvas.width, ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const [boost, cut] = GUIDE[channel] || GUIDE.rgb;
    const guide = ctx.createLinearGradient(0, 0, size, size);
    guide.addColorStop(0, boost); guide.addColorStop(1, cut);
    ctx.fillStyle = '#16181d'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = guide; ctx.fillRect(0, 0, size, size);
    const b = bins && bins[channel];
    if (b) {
      const peak = Math.max(1, ...b), w = size / 256;
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      for (let i = 0; i < 256; i++) { const h = (b[i] / peak) * size * 0.9; ctx.fillRect(i * w, size - h, Math.ceil(w), h); }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const at = Math.round(size * i / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(at, 0); ctx.lineTo(at, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, at); ctx.lineTo(size, at); ctx.stroke();
    }
    ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke(); ctx.setLineDash([]);
    const lut = buildLut(points);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, size / 90);
    ctx.beginPath();
    for (let i = 0; i < 256; i++) { const x = (i / 255) * size, y = size - (lut[i] / 255) * size; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
    const r = Math.max(6, size / 26);
    for (const [px, py] of points) {
      const x = px * size, y = size - py * size;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r / 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }
  }
  // A small square preview of one channel's curve, for its button.
  function drawThumb(canvas, channel, points) {
    const size = canvas.width, ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#16181d'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = (GUIDE[channel] || GUIDE.rgb)[0]; ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();
    const lut = buildLut(points);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < 256; i += 4) { const x = (i / 255) * size, y = size - (lut[i] / 255) * size; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
  }

  // A step's name in the history list (English key; the editor translates it).
  function stepLabel(op) {
    if (op.type === 'rotate') return ['Rotate {deg}°', { deg: ((num(op.params.turns) % 4 + 4) % 4) * 90 }];
    if (op.type === 'flip') return [op.params.axis === 'v' ? 'Flip vertical' : 'Flip horizontal'];
    if (op.type === 'crop') return ['Crop'];
    if (op.type === 'curves') {
      const set = curveSet(op.params);
      const touched = CHANNELS.filter((k) => !channelIsIdentity(set[k]));
      // The editor names the channels (All, R, G, B) in the reader's language.
      return touched.length && touched.length < 4 ? ['Curves · {channels}', { channels: touched }] : ['Curves'];
    }
    if (op.type === 'adjust') {
      if (op.params.preset) return [op.params.preset];
      const touched = ADJUSTMENTS.filter((a) => num(op.params[a.key]) !== 0);
      return touched.length === 1 ? [touched[0].label] : ['Adjust'];
    }
    return [op.type];
  }

  global.MemoImageColor = {
    ADJUSTMENTS, PRESETS, CHANNELS, neutral, isNeutral, filterString, buildLut, curveSet, newCurves,
    channelIsIdentity, curvesAreIdentity, applyCurves, applyColour, histogram, drawPad, drawThumb, stepLabel,
  };
})(window);
