/*
  Sky background — one rotating sky, two looks.

  Both themes share the same motion: the sky turns slowly and continuously
  around a pivot below the bottom of the screen (clockwise, one revolution
  every CONFIG.revolutionSeconds), and scrolling adds a little extra turn on
  top, like a timelapse.

  Light mode: a deep blue daytime sky with photographic cumulus clouds
  (images/sky/*.webp) in three depths. Near clouds are towering cumulus with a
  soft glow; mid and far clouds are small fair-weather cumulus, paler and
  softer, and turn a little slower, which gives a parallax feel. Clouds low in
  the sky shrink, flatten and fade into the pale band at the horizon. Clouds
  stay upright as they travel along their arcs, and are only placed on the
  page while they are on screen.

  Dark mode: a Milky Way night sky drawn with WebGL, turning around the same
  pivot. The horizon glow and hills stay put while the stars turn.

  Switching themes crossfades between the two, and only the visible sky is
  animated. With reduced motion turned on, both skies hold still.

  Include it at the end of <body>:  <script src="sky.js"></script>
*/
(function () {
  'use strict';

  // ================================================================ settings

  var CONFIG = {
    // --- motion shared by both skies ---
    pivot: { x: -0.15, y: -1.25 },   // centre of rotation, in sky units from the screen centre (y up)
    skyUnit: 1.6,                    // a sky unit is one screen height, or at most this × screen width on tall
                                     // narrow screens, so a phone shows about as much sky as a laptop
    revolutionSeconds: 480,          // one full turn of the sky (8 minutes)
    scrollTurn: 0.35,                // extra turn (radians) across the whole page, per unit of screen width/height…
    scrollTurnRange: [0.18, 0.55],   // …kept within this range so narrow screens don't overshoot
    idleFps: 30,                     // redraw rate while only the slow rotation is moving (scrolling uses every frame)
    crossfadeMs: 500,                // light ↔ dark fade

    // --- light mode ---
    day: {
      // gradient from the top of the screen to the horizon: [color, position]. The last stop is the bright pale band.
      sky: [['#0a4a8f', 0], ['#1765b1', 0.34], ['#4a90d2', 0.68], ['#9dcbee', 0.9], ['#d9edf9', 1]],
      sunGlow: [255, 246, 225, 0.3],                       // faint glow in the top-left corner (the clouds are lit from there): r, g, b, strength
      // Clouds low in the sky look farther away: near the horizon they shrink, flatten and fade.
      // shrink/flatten/haze are the size, height and opacity at the very bottom; reach is how far up the effect goes.
      horizon: { shrink: 0.6, flatten: 0.8, haze: 0.45, reach: 0.7 },
      cloudSize: { perScreenWidth: 0.11, min: 70, max: 170 }, // px per cloud unit — scales every cloud
      ring: [0.45, 2.7],             // clouds are scattered over this ring around the pivot (sky units)
      // count: how many clouds of this depth are on screen at once, on a typical laptop screen
      // rate:  how fast this depth turns compared with the stars (1 = same speed)
      // look:  a fixed CSS filter — far clouds are softer, paler and lower in contrast
      layers: [
        { count: 4,   scale: 0.4,  opacity: 0.72, rate: 0.8, look: 'blur(1.3px) contrast(0.82) brightness(1.06)',
          shapes: ['fair2', 'fair3', 'fair4', 'fair1'] },                  // far: small fair-weather cumulus
        { count: 3,   scale: 0.64, opacity: 0.9,  rate: 0.9, look: 'blur(0.4px) contrast(0.9) brightness(1.03)',
          shapes: ['fair1', 'fair5', 'fair3', 'fair2'] },                  // mid
        { count: 1.8, scale: 1,    opacity: 1,    rate: 1,   look: '',
          shapes: ['tower', 'bank', 'mound', 'tower2'] }                   // near: towering cumulus
      ]
    },

    // --- dark mode ---
    night: {
      maxPixelRatio: 1.5             // render resolution cap; lowered automatically on slow devices
    }
  };

  // Cloud images and their size in cloud units (rendered at ~512px per unit). The near clouds'
  // images include a soft glow around them, so they are wider than the cloud itself.
  var CLOUD_DIR = 'images/sky/';
  var SPRITES = {
    tower:  { w: 3.92,  h: 3.996 },
    tower2: { w: 3.416, h: 4.034 },
    bank:   { w: 5.41,  h: 3.191 },
    mound:  { w: 4.338, h: 3.471 },
    fair1:  { w: 2.588, h: 1.064 },
    fair2:  { w: 2.197, h: 0.992 },
    fair3:  { w: 3.307, h: 1.0 },
    fair4:  { w: 1.598, h: 0.891 },
    fair5:  { w: 2.494, h: 1.322 }
  };

  // ================================================================ shared state

  var TAU = Math.PI * 2;
  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var isDark = function () { return root.getAttribute('data-theme') === 'dark'; };

  var viewW = 0, viewH = 0, maxScroll = 0;
  var scrollNow = 0;
  var frozenTime = Date.now() / 1000;   // used instead of the clock when motion is reduced
  var lastFrame = 0, lastDraw = 0, rafId = 0;
  var day = null, night = null;

  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function measure() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    maxScroll = Math.max(0, root.scrollHeight - viewH);
  }

  // CSS px per sky unit for a sky layer of the given height
  function skyUnitPx(height) {
    return Math.min(height, viewW * CONFIG.skyUnit);
  }

  function scrollTarget() {
    return reduceMotion.matches ? 0 : Math.min(maxScroll, Math.max(0, window.scrollY));
  }

  // The sky's angle for a layer turning at `rate`. The slow spin is taken from the
  // wall clock, so it loops seamlessly and carries on smoothly from page to page.
  function skyAngle(rate) {
    var t = reduceMotion.matches ? frozenTime : Date.now() / 1000;
    var spin = ((t * rate / CONFIG.revolutionSeconds) % 1) * TAU;
    var range = CONFIG.scrollTurnRange;
    var turnSize = Math.min(range[1], Math.max(range[0], CONFIG.scrollTurn * viewW / Math.max(1, viewH)));
    var progress = maxScroll > 0 ? scrollNow / maxScroll : 0.5;
    return spin + (progress - 0.5) * turnSize * rate;
  }

  // ================================================================ styles

  var fade = CONFIG.crossfadeMs + 'ms';
  var skyStops = CONFIG.day.sky.map(function (s) { return s[0] + ' ' + (s[1] * 100) + '%'; }).join(', ');
  var sun = CONFIG.day.sunGlow;
  var sunAt = function (a) { return 'rgba(' + sun[0] + ', ' + sun[1] + ', ' + sun[2] + ', ' + (sun[3] * a).toFixed(3) + ')'; };
  var style = document.createElement('style');
  style.textContent =
    '.sky-layer { position: fixed; left: 0; top: 0; width: 100%; height: 100vh; height: 100lvh; z-index: -2;' +
    ' pointer-events: none; overflow: hidden; opacity: 0; visibility: hidden;' +
    ' transition: opacity ' + fade + ' ease, visibility 0s linear ' + fade + '; }' +
    '.sky-layer.is-active { opacity: 1; visibility: visible; transition: opacity ' + fade + ' ease, visibility 0s; }' +
    '.sky-day { background: radial-gradient(circle at 4% 0%, ' + sunAt(1) + ' 0%, ' + sunAt(0.55) + ' 10%, ' + sunAt(0.22) + ' 22%, ' +
    sunAt(0.06) + ' 34%, ' + sunAt(0) + ' 46%),' +
    ' linear-gradient(to bottom, ' + skyStops + '); }' +
    '.sky-cloud { position: absolute; left: 0; top: 0; max-width: none; opacity: 0; will-change: transform, opacity;' +
    ' transform-origin: 50% 100%; -webkit-user-select: none; user-select: none; }' +
    '@media (prefers-reduced-motion: reduce) { .sky-layer, .sky-layer.is-active { transition: none; } }';
  document.head.appendChild(style);

  // ================================================================ light mode: clouds

  function makeDay() {
    var el = document.createElement('div');
    el.className = 'sky-layer sky-day';
    el.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(el, document.body.firstChild);

    var cfg = CONFIG.day;
    var inner = cfg.ring[0], outer = cfg.ring[1];
    var ringArea = Math.PI * (outer * outer - inner * inner);
    var LAPTOP_AREA = 1.6;          // a 16:10 screen, in sky units squared
    var unit = 0;                   // px per cloud unit, set in resize()
    var skyH = 0;                   // px height of the sky layer, set in resize()
    var spare = {};                 // detached <img> elements, reused by sprite name

    // Scatter each depth's clouds over the ring (evenly by area, not too close together).
    // Positions are in "sky" coordinates around the pivot, so resizing only rescales them.
    var layers = cfg.layers.map(function (layerCfg, li) {
      var layer = { cfg: layerCfg, el: document.createElement('div'), clouds: [] };
      el.appendChild(layer.el);
      var rand = rng(7919 + li * 101);
      var total = Math.round(layerCfg.count * ringArea / LAPTOP_AREA);
      var minGap = 0.55 / Math.sqrt(total / ringArea);
      var tries = 0;
      while (layer.clouds.length < total && tries++ < total * 40) {
        var r = Math.sqrt(inner * inner + rand() * (outer * outer - inner * inner));
        var a = rand() * TAU;
        var x = r * Math.cos(a), y = r * Math.sin(a);
        var crowded = layer.clouds.some(function (c) { return Math.hypot(c.x - x, c.y - y) < minGap; });
        if (crowded) continue;
        var name = layerCfg.shapes[Math.floor(rand() * layerCfg.shapes.length)];
        var s = SPRITES[name];
        var w = s.w * layerCfg.scale * (0.85 + 0.3 * rand());
        layer.clouds.push({ name: name, x: x, y: y, w: w, h: w * s.h / s.w * (0.92 + 0.16 * rand()), img: null });
      }
      return layer;
    });

    function size(img, c) {
      img.style.width = (c.w * unit).toFixed(1) + 'px';
      img.style.height = (c.h * unit).toFixed(1) + 'px';
      img.sizes = Math.round(c.w * unit) + 'px';
    }

    function attach(layer, c) {
      var list = spare[c.name] || (spare[c.name] = []);
      var img = list.pop();
      if (!img) {
        img = document.createElement('img');
        img.className = 'sky-cloud';
        img.alt = '';
        img.decoding = 'async';
        img.draggable = false;
        img.loadedAt = 0;            // fades in over a second once the image has loaded
        img.onload = function () {
          img.loadedAt = reduceMotion.matches ? -1e9 : performance.now();
          lastDraw = 0;
          kick();
        };
        img.srcset = CLOUD_DIR + c.name + '-half.webp 1024w, ' + CLOUD_DIR + c.name + '.webp 2048w';
        img.src = CLOUD_DIR + c.name + '-half.webp';
        if (img.complete && img.naturalWidth) img.loadedAt = -1e9;
      }
      img.style.filter = layer.cfg.look;
      img.drawnOpacity = -1;
      size(img, c);
      layer.el.appendChild(img);
      c.img = img;
    }

    function detach(c) {
      c.img.remove();
      spare[c.name].push(c.img);
      c.img = null;
    }

    function resize() {
      var s = cfg.cloudSize;
      unit = Math.min(s.max, Math.max(s.min, viewW * s.perScreenWidth));
      skyH = el.clientHeight || viewH;
      layers.forEach(function (layer) {
        layer.clouds.forEach(function (c) { if (c.img) size(c.img, c); });
      });
    }

    var P = CONFIG.pivot;
    var hz = cfg.horizon;
    function draw() {
      var W = viewW, H = skyH, S = skyUnitPx(skyH);
      var now = performance.now();
      layers.forEach(function (layer) {
        var angle = skyAngle(layer.cfg.rate);
        var cos = Math.cos(angle), sin = Math.sin(angle);
        layer.clouds.forEach(function (c) {
          // turn the cloud's sky position clockwise around the pivot (same as the stars), keep it upright
          var px = P.x + cos * c.x + sin * c.y;
          var py = P.y - sin * c.x + cos * c.y;
          var w = c.w * unit, h = c.h * unit;
          var left = W / 2 + px * S - w / 2;
          var top = H / 2 - py * S - h / 2;
          var onScreen = left < W + 2 && left + w > -2 && top < H + 2 && top + h > -2;
          if (onScreen && !c.img) attach(layer, c);
          else if (!onScreen && c.img) detach(c);
          if (!c.img) return;
          // how high the cloud sits: 0 at the horizon (bottom of the screen), 1 once it is `reach` of the way up
          var up = Math.min(1, Math.max(0, (H - (top + h)) / (H * hz.reach)));
          up = up * up * (3 - 2 * up);
          var sx = hz.shrink + (1 - hz.shrink) * up;
          var sy = sx * (hz.flatten + (1 - hz.flatten) * up);
          c.img.style.transform = 'translate3d(' + left.toFixed(2) + 'px,' + top.toFixed(2) + 'px,0) scale(' +
            sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
          var fadeIn = c.img.loadedAt ? Math.min(1, (now - c.img.loadedAt) / 1000) : 0;
          var opacity = layer.cfg.opacity * (hz.haze + (1 - hz.haze) * up) * fadeIn;
          if (Math.abs(opacity - c.img.drawnOpacity) > 0.004) {
            c.img.style.opacity = opacity.toFixed(3);
            c.img.drawnOpacity = opacity;
          }
        });
      });
    }

    return { el: el, resize: resize, draw: draw };
  }

  // ================================================================ dark mode: Milky Way

  var NIGHT_VERT = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  var NIGHT_FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 uRes;',       // canvas size in device pixels
    'uniform float uSkyPx;',    // device pixels per sky unit
    'uniform float uSkyCss;',   // CSS pixels per sky unit
    'uniform float uAngle;',    // how far the sky has turned
    'uniform vec2 uPivot;',     // centre of rotation (sky units from the screen centre)

    'float hash12(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'vec2 hash22(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.xx + p3.yz) * p3.zy);',
    '}',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);',
    'float fbm(vec2 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = ROT * p; a *= 0.5; }',
    '  return s;',
    '}',
    'float fbm3(vec2 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = ROT * p; a *= 0.5; }',
    '  return s / 0.875;',
    '}',

    // one star per grid cell, with a gaussian profile measured in CSS pixels
    'vec3 stars(vec2 s, float cell, float prob, float bright, float sigma, float seed) {',
    '  vec2 g = s / cell;',
    '  vec2 id = floor(g);',
    '  if (hash12(id + seed) > prob) return vec3(0.0);',
    '  vec2 pos = 0.25 + 0.5 * hash22(id + seed * 1.7);',
    '  float d = length(fract(g) - pos) * cell * uSkyCss;',
    '  float mag = hash12(id + seed * 3.1);',
    '  float b = bright * (0.2 + 0.8 * mag * mag * mag);',
    '  float temp = hash12(id + seed * 5.3);',
    '  vec3 tint = temp < 0.2 ? vec3(0.72, 0.82, 1.0) : temp < 0.78 ? vec3(1.0) : temp < 0.94 ? vec3(1.0, 0.88, 0.72) : vec3(1.0, 0.7, 0.55);',
    '  return tint * b * exp(-d * d / (2.0 * sigma * sigma));',
    '}',

    // The Milky Way is an arch: a band along a circle that encloses the pivot,
    // so some of it is always in view however far the sky has turned.
    'const vec2 BAND_CENTER = vec2(0.23, 0.19);',
    'const float BAND_R = 1.35;',
    'const float CORE_ANG = 1.2;',     // where the bright core sits along the arch
    'const float PI = 3.14159265;',

    'void main() {',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uSkyPx;',   // sky units, y up
    '  vec2 ps = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;',  // screen heights, for things fixed to the screen
    '  float y01 = ps.y + 0.5;',
    '  float aa = 1.0 / uRes.y;',

    // sky coordinates turn around the pivot
    '  float c = cos(uAngle), sn = sin(uAngle);',
    '  vec2 s = mat2(c, sn, -sn, c) * (p - uPivot);',

    // background: deep blue overhead, violet toward the horizon
    '  vec3 col = mix(vec3(0.055, 0.03, 0.09), vec3(0.012, 0.02, 0.055), smoothstep(0.05, 0.85, y01));',
    '  float tone = fbm3(s * 1.3 + 4.0);',
    '  col += vec3(0.0, 0.012, 0.035) * tone + vec3(0.03, 0.0, 0.025) * (1.0 - tone) * (1.0 - y01);',

    // the band, in its own coordinates: `across` is the distance from the arch, `along` the distance from the core
    '  vec2 bq = s - BAND_CENTER;',
    '  float bandDist = length(bq);',
    '  vec2 dir = bq / bandDist;',
    '  float ang = atan(bq.y, bq.x);',
    '  float across = bandDist - BAND_R + 0.018 * sin(ang * 5.0);',
    '  float along = (mod(ang - CORE_ANG + PI, 2.0 * PI) - PI) * BAND_R;',
    '  float coreW = exp(-along * along / 0.06);',
    // a second, softer bright region on the far side of the arch, so it looks rich at every angle
    '  float along2 = (mod(ang - CORE_ANG, 2.0 * PI) - PI) * BAND_R;',
    '  float cloud2 = exp(-along2 * along2 / 0.35);',
    '  float width = 0.085 + 0.085 * coreW + 0.03 * cloud2;',
    '  float halo = exp(-across * across / (2.0 * 5.0 * width * width));',
    '  float band = 0.0, dust = 0.0;',
    '  if (halo > 0.004) {',
    '    across += 0.05 * (fbm3(s * 2.5 + 7.0) - 0.5);',
    '    band = exp(-across * across / (2.0 * width * width));',
    '    float clumps = fbm(s * 6.0 + 11.0);',
    '    float grain = 0.75 + 0.5 * vnoise(s * 380.0);',            // the glow is made of countless faint stars
    '    float glow = band * (0.35 + 1.1 * clumps * clumps) * (0.7 + 0.8 * coreW + 0.35 * cloud2) * grain + halo * 0.12 * (0.6 + coreW + 0.4 * cloud2);',
    '    vec2 w = vec2(fbm3(s * 3.0), fbm3(s * 3.0 + 5.2));',
    // dust lanes run along the arch: sample the noise in a space stretched along it
    '    vec2 bc = dir * (BAND_R * 4.2 + across * 10.0) + w * 0.8;',
    '    float rift = exp(-pow((across - 0.008 - 0.01 * sin(ang * 10.0)) / (width * 0.36), 2.0));',
    '    float ridges = 1.0 - abs(2.0 * fbm(bc * 1.4) - 1.0);',
    '    dust = smoothstep(0.72, 0.98, ridges) * 0.5;',                                        // fine filaments
    '    dust += smoothstep(0.42, 0.68, fbm(dir * (BAND_R * 2.4 + across * 7.0) + w)) * rift * 0.85;',   // the great rift
    '    dust = clamp(dust * smoothstep(0.05, 0.5, band), 0.0, 1.0);',
    '    glow *= 1.0 - 0.82 * dust;',
    '    vec3 tint = mix(vec3(0.74, 0.8, 1.0), vec3(1.0, 0.8, 0.58), clamp(coreW * 1.15 + 0.3 * clumps - 0.15, 0.0, 1.0));',
    '    col += tint * glow * 0.85;',
    '    float neb = smoothstep(0.64, 0.86, fbm3(s * 6.0 + 21.0));',
    '    col += vec3(0.85, 0.3, 0.45) * neb * band * 0.14 * (1.0 - dust);',
    '  }',

    // stars: most are faint, a few are bright; denser inside the band, dimmed by dust
    '  float boost = 1.0 + 1.6 * band;',
    '  vec3 st = stars(s, 1.0 / 230.0, 0.14 * boost, 0.38, 0.42, 1.0)',
    '          + stars(s, 1.0 / 120.0, 0.11 * boost, 0.6, 0.48, 7.0)',
    '          + stars(s, 1.0 / 50.0, 0.16, 1.15, 0.58, 13.0)',
    '          + stars(s, 1.0 / 22.0, 0.2, 2.2, 0.75, 29.0);',
    '  col += st * (1.0 - 0.8 * dust);',

    // horizon (fixed to the screen): violet airglow, then a golden glow over the hills
    '  col += vec3(0.14, 0.04, 0.13) * exp(-pow((y01 - 0.2) / 0.13, 2.0));',
    '  col += vec3(0.02, 0.06, 0.035) * exp(-pow((y01 - 0.32) / 0.08, 2.0));',
    '  float ridge = 0.07 + 0.055 * exp(-pow((ps.x - 0.22) / 0.3, 2.0)) + 0.035 * (fbm3(vec2(ps.x * 2.6, 1.7)) - 0.5)',
    '              + 0.01 * (vnoise(vec2(ps.x * 22.0, 3.0)) - 0.5);',
    '  col += vec3(0.95, 0.62, 0.26) * 0.5 * exp(-max(y01 - ridge, 0.0) / 0.055);',
    '  col += vec3(0.9, 0.55, 0.3) * 0.12 * exp(-max(y01 - ridge, 0.0) / 0.2);',
    '  vec3 ground = vec3(0.01, 0.012, 0.022);',
    '  col = mix(col, ground, smoothstep(ridge + aa, ridge - aa, y01));',

    // dither so the dark gradients don't band
    '  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function makeNight() {
    var canvas = document.createElement('canvas');
    canvas.className = 'sky-layer sky-night';
    canvas.setAttribute('aria-hidden', 'true');
    var gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) return null;

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('sky.js:', gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    }
    var vs = compile(gl.VERTEX_SHADER, NIGHT_VERT);
    var fs = compile(gl.FRAGMENT_SHADER, NIGHT_FRAG);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    var uRes = gl.getUniformLocation(prog, 'uRes');
    var uSkyPx = gl.getUniformLocation(prog, 'uSkyPx');
    var uSkyCss = gl.getUniformLocation(prog, 'uSkyCss');
    var uAngle = gl.getUniformLocation(prog, 'uAngle');
    gl.uniform2f(gl.getUniformLocation(prog, 'uPivot'), CONFIG.pivot.x, CONFIG.pivot.y);

    document.body.insertBefore(canvas, document.body.firstChild);

    var quality = 1;            // lowered automatically if frames take too long
    var slowFrames = 0;
    var lost = false;

    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost = true; canvas.style.display = 'none'; });

    function resize() {
      var scale = Math.min(window.devicePixelRatio || 1, CONFIG.night.maxPixelRatio) * quality;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // frameGap: time since the previous animation frame, used to spot a struggling device
    function draw(frameGap) {
      if (lost) return;
      if (frameGap > 28) {
        if (++slowFrames > 20 && quality > 0.55) { quality *= 0.8; slowFrames = 0; resize(); }
      } else {
        slowFrames = 0;
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      var unitCss = skyUnitPx(canvas.clientHeight);
      gl.uniform1f(uSkyPx, unitCss * canvas.height / Math.max(1, canvas.clientHeight));
      gl.uniform1f(uSkyCss, unitCss);
      gl.uniform1f(uAngle, skyAngle(1));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return { el: canvas, resize: resize, draw: draw };
  }

  // ================================================================ driving it all

  function drawActive(frameGap) {
    if (isDark()) { if (night) night.draw(frameGap); }
    else if (day) day.draw();
  }

  function showTheme() {
    var dark = isDark();
    if (dark && night === null) {
      night = makeNight() || false;   // false: no WebGL, the CSS gradient behind stays visible
      if (night) night.resize();
    }
    if (!dark && day === null) {
      day = makeDay();
      day.resize();
    }
    drawActive(16);                   // paint the incoming sky before it fades in
    if (day) day.el.classList.toggle('is-active', !dark);
    if (night) night.el.classList.toggle('is-active', dark);
    kick();
  }

  function frame(now) {
    rafId = 0;
    var gap = lastFrame ? now - lastFrame : 16;
    var dt = Math.min(0.1, gap / 1000);
    lastFrame = now;

    var target = scrollTarget();
    scrollNow += (target - scrollNow) * (1 - Math.exp(-dt * 9));
    if (Math.abs(target - scrollNow) < 0.1) scrollNow = target;
    var settling = scrollNow !== target;

    // redraw every frame while scrolling eases in; otherwise the slow spin only needs CONFIG.idleFps
    if (settling || now - lastDraw >= 1000 / CONFIG.idleFps - 2) {
      drawActive(gap);
      lastDraw = now;
    }

    var active = isDark() ? night : day;
    if (active && (settling || !reduceMotion.matches)) rafId = requestAnimationFrame(frame);
    else lastFrame = 0;
  }

  function kick() {
    if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame);
  }

  function onResize() {
    measure();
    if (day) day.resize();
    if (night) night.resize();
    lastDraw = 0;
    drawActive(16);
    kick();
  }

  measure();
  scrollNow = scrollTarget();
  showTheme();

  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', onResize);
  // the page can grow after load (fonts, images), which changes how far a scroll turns the sky
  if (window.ResizeObserver) new ResizeObserver(function () { measure(); kick(); }).observe(document.body);
  new MutationObserver(showTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(rafId); rafId = 0; lastFrame = 0; }
    else kick();
  });
  var onMotionChange = function () { frozenTime = Date.now() / 1000; onResize(); };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
  else if (reduceMotion.addListener) reduceMotion.addListener(onMotionChange);
})();
