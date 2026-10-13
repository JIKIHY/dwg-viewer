// 인쇄용: CTB 플롯 스타일 해석 + 벡터(SVG) 용지 생성
(function (global) {
  'use strict';

  // AutoCAD 기본 선가중치 표 (mm)
  const DEFAULT_LW = [0, 0.05, 0.09, 0.1, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.53, 0.6, 0.65, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11];
  const OBJECT_COLORS = new Set([-1, -1006632961]);

  // CTB 압축 해제 텍스트 → { styles[aci] = { objColor, rgb, gray, screen, lwmm } }
  function parseCtb(txt, name) {
    const root = {};
    const stack = [root];
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line) continue;
      if (line.endsWith('{')) {
        const o = {};
        stack[stack.length - 1][line.slice(0, -1).trim()] = o;
        stack.push(o);
      } else if (line === '}') {
        if (stack.length > 1) stack.pop();
      } else {
        const i = line.indexOf('=');
        if (i > 0) {
          let v = line.slice(i + 1);
          if (v.startsWith('"')) v = v.slice(1).replace(/"$/, '');
          stack[stack.length - 1][line.slice(0, i).trim()] = v;
        }
      }
    }
    const lwt = [];
    const t = root.custom_lineweight_table || {};
    for (const k of Object.keys(t)) lwt[+k] = parseFloat(t[k]);
    const table = lwt.length ? lwt : DEFAULT_LW;
    const styles = new Array(256).fill(null);
    const ps = root.plot_style || {};
    for (const k of Object.keys(ps)) {
      const st = ps[k];
      const aci = +k + 1;
      if (!(aci >= 1 && aci <= 255)) continue;
      const color = parseInt(st.color, 10);
      const lw = parseInt(st.lineweight, 10);
      styles[aci] = {
        objColor: isNaN(color) || OBJECT_COLORS.has(color),
        rgb: color & 0xffffff,
        gray: (parseInt(st.color_policy, 10) & 2) !== 0,
        screen: st.screen === undefined ? 100 : Math.max(0, Math.min(100, parseInt(st.screen, 10))),
        lwmm: isNaN(lw) || lw === 255 || lw < 0 || table[lw] === undefined ? null : table[lw],
      };
    }
    return { name, description: root.description || '', styles };
  }

  const BUILTIN = {
    '@mono': { name: 'monochrome.ctb', styles: new Array(256).fill({ objColor: false, rgb: 0, gray: false, screen: 100, lwmm: null }) },
    '@gray': { name: 'grayscale.ctb', styles: new Array(256).fill({ objColor: true, rgb: 0, gray: true, screen: 100, lwmm: null }) },
    '@none': { name: '화면 색상', styles: new Array(256).fill(null) },
  };

  const lum = (c) => (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255;
  // ACI·화면색·선가중치 → 인쇄 색과 굵기(mm)
  function makeStyler(ctb, useLw, lwDefaultMm) {
    const cache = new Map();
    return function style(aci, rgb, lwCode) {
      const key = aci * 16777216 * 256 + rgb * 256 + lwCode;
      let r = cache.get(key);
      if (r) return r;
      const st = ctb.styles[aci] || null;
      let c = !st || st.objColor ? rgb : st.rgb;
      if (st && st.gray) { const g = Math.round(lum(c) * 255); c = (g << 16) | (g << 8) | g; }
      // 흰 종이에서 흰색/아주 밝은 색은 검정으로 (AutoCAD 7번 처리와 같음)
      if ((!st || st.objColor) && (aci === 7 || lum(c) > 0.92)) c = 0;
      if (st && st.screen < 100) {
        const f = st.screen / 100;
        const mix = (v) => Math.round(255 - (255 - v) * f);
        c = (mix((c >> 16) & 255) << 16) | (mix((c >> 8) & 255) << 8) | mix(c & 255);
      }
      let mm = st && st.lwmm !== null ? st.lwmm : lwCode === 255 ? lwDefaultMm : lwCode / 100;
      if (!useLw) mm = 0;
      mm = Math.max(mm, 0.06); // 0.00 선가중치 = 프린터 최소 굵기
      r = { hex: '#' + c.toString(16).padStart(6, '0'), mm: Math.round(mm * 1000) / 1000 };
      cache.set(key, r);
      return r;
    };
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const r2 = (v) => Math.round(v * 100) / 100;

  // 측정 치수 → 용지(mm) 위 선·화살표·문자. dims: [{ a, b, off, label }] (월드 좌표)
  const DIM = { txt: 2.5, arrow: 2.5, gap: 0.6, ext: 1.5, lw: 0.18 };
  function dimPrims(dims, toPaper) {
    const lines = [], tris = [], texts = [];
    for (const d of dims) {
      const [a, b] = d.pts;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(L > 0)) continue;
      const o = d.off || 0, n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      const pa = toPaper(a), pb = toPaper(b);
      const qa = toPaper([a[0] + n[0] * o, a[1] + n[1] * o]), qb = toPaper([b[0] + n[0] * o, b[1] + n[1] * o]);
      const sl = Math.hypot(qb[0] - qa[0], qb[1] - qa[1]);
      const ux = (qb[0] - qa[0]) / sl, uy = (qb[1] - qa[1]) / sl;
      let nx = -uy, ny = ux;
      const od = Math.hypot(qa[0] - pa[0], qa[1] - pa[1]);
      if (od > 1e-9 ? nx * (qa[0] - pa[0]) + ny * (qa[1] - pa[1]) < 0 : ny > 0) { nx = -nx; ny = -ny; }
      lines.push([qa[0], qa[1], qb[0], qb[1]]);
      for (const [p, q] of [[pa, qa], [pb, qb]]) {
        const s0 = od > DIM.gap ? DIM.gap : -DIM.ext;
        lines.push([p[0] + nx * s0, p[1] + ny * s0, q[0] + nx * DIM.ext, q[1] + ny * DIM.ext]);
      }
      const AL = DIM.arrow, AW = AL / 6;
      for (const [p, s] of [[qa, 1], [qb, -1]]) {
        tris.push([p[0], p[1], p[0] + ux * AL * s - uy * AW, p[1] + uy * AL * s + ux * AW, p[0] + ux * AL * s + uy * AW, p[1] + uy * AL * s - ux * AW]);
      }
      // 문자: 치수선 가운데, 바깥쪽에, 읽기 방향으로
      // ang: 용지에서 반시계 방향 각도 (용지 y는 아래로)
      let ang = (Math.atan2(-uy, ux) * 180) / Math.PI;
      if (ang > 90.01) ang -= 180; else if (ang < -89.99) ang += 180;
      const ra = (ang * Math.PI) / 180, g = DIM.txt * 0.35;
      // 문자의 '위' 방향이 바깥쪽이면 기준선 정렬, 반대면 윗선 정렬
      const below = -Math.sin(ra) * nx - Math.cos(ra) * ny < 0;
      texts.push({ x: (qa[0] + qb[0]) / 2 + nx * g, y: (qa[1] + qb[1]) / 2 + ny * g, ang, s: d.label, below });
    }
    return { lines, tris, texts };
  }
  function dimSvg(pr) {
    if (!pr.lines.length) return '';
    const d = pr.lines.map((l) => `M${r2(l[0])} ${r2(l[1])}L${r2(l[2])} ${r2(l[3])}`).join('');
    const t = pr.tris.map((v) => `M${r2(v[0])} ${r2(v[1])}L${r2(v[2])} ${r2(v[3])}L${r2(v[4])} ${r2(v[5])}Z`).join('');
    const tx = pr.texts.map((x) => `<text transform="translate(${r2(x.x)} ${r2(x.y)}) rotate(${r2(-x.ang)})" dominant-baseline="${x.below ? 'hanging' : 'alphabetic'}">${esc(x.s)}</text>`).join('');
    return `<g><path fill="none" stroke="#000" stroke-width="${DIM.lw}" stroke-linecap="round" d="${d}"/><path fill="#000" d="${t}"/>` +
      `<g fill="#000" font-family="${Scene.FONT.replace(/"/g, "'")}" font-size="${DIM.txt}" text-anchor="middle">${tx}</g></g>`;
  }
  // 이미지 방식 용지에 그리기 (k: px/mm)
  function drawDims(c, pr, k) {
    c.save();
    c.scale(k, k);
    c.strokeStyle = '#000'; c.fillStyle = '#000'; c.lineWidth = DIM.lw; c.lineCap = 'round';
    c.beginPath();
    for (const l of pr.lines) { c.moveTo(l[0], l[1]); c.lineTo(l[2], l[3]); }
    c.stroke();
    for (const v of pr.tris) { c.beginPath(); c.moveTo(v[0], v[1]); c.lineTo(v[2], v[3]); c.lineTo(v[4], v[5]); c.closePath(); c.fill(); }
    c.font = `${DIM.txt}px ${Scene.FONT}`;
    c.textAlign = 'center';
    for (const x of pr.texts) {
      c.save(); c.translate(x.x, x.y); c.rotate((-x.ang * Math.PI) / 180);
      c.textBaseline = x.below ? 'top' : 'alphabetic';
      c.fillText(x.s, 0, 0); c.restore();
    }
    c.restore();
  }

  // 용지 SVG (단위 mm). L: 용지 배치, vis(layer, group): 표시 여부
  function buildSvg(scene, L, opt) {
    const { styler, vis, margin, dims } = opt;
    const k = L.mmPerUnit;
    const cx = (L.rg[0] + L.rg[2]) / 2, cy = (L.rg[1] + L.rg[3]) / 2;
    const px0 = margin + L.iw / 2, py0 = margin + L.ih / 2;
    const ox = scene.origin[0] - cx, oy = scene.origin[1] - cy;
    const x0 = margin - 1, x1 = margin + L.iw + 1, y0 = margin - 1, y1 = margin + L.ih + 1;
    const pos = scene.linePos, col = scene.lineCol, lw = scene.lineLw;
    const strokes = new Map();
    let segCount = 0;

    for (const rg of scene.ranges) {
      if (!rg.lc || !vis(rg.layer, rg.group)) continue;
      const s0 = rg.ls >> 1, s1 = s0 + (rg.lc >> 1);
      for (let i = s0; i < s1; i++) {
        const ax = r2(px0 + (pos[i * 4] + ox) * k), ay = r2(py0 - (pos[i * 4 + 1] + oy) * k);
        const bx = r2(px0 + (pos[i * 4 + 2] + ox) * k), by = r2(py0 - (pos[i * 4 + 3] + oy) * k);
        if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
        const c = i * 8;
        const st = styler(col[c + 3], (col[c] << 16) | (col[c + 1] << 8) | col[c + 2], lw[i]);
        const key = st.hex + '|' + st.mm;
        let g = strokes.get(key);
        if (!g) { g = { st, d: [], lx: NaN, ly: NaN }; strokes.set(key, g); }
        if (ax === g.lx && ay === g.ly) {
          if (ax === bx && ay === by) continue;
          g.d.push('L' + bx + ' ' + by);
        } else g.d.push('M' + ax + ' ' + ay + 'L' + bx + ' ' + by);
        g.lx = bx; g.ly = by;
        segCount++;
      }
    }

    // 채움(솔리드 해치 등)
    const fills = new Map();
    const tp = scene.triPos, tc = scene.triCol;
    for (const rg of scene.ranges) {
      if (!rg.tc || !vis(rg.layer, rg.group)) continue;
      for (let v = rg.ts; v < rg.ts + rg.tc; v += 3) {
        const p = [];
        let out = 0;
        for (let q = 0; q < 3; q++) {
          const X = r2(px0 + (tp[(v + q) * 2] + ox) * k), Y = r2(py0 - (tp[(v + q) * 2 + 1] + oy) * k);
          if (X < x0 || X > x1 || Y < y0 || Y > y1) out++;
          p.push(X, Y);
        }
        if (out === 3 && ((p[0] < x0 && p[2] < x0 && p[4] < x0) || (p[0] > x1 && p[2] > x1 && p[4] > x1) || (p[1] < y0 && p[3] < y0 && p[5] < y0) || (p[1] > y1 && p[3] > y1 && p[5] > y1))) continue;
        const c = v * 4;
        const st = styler(tc[c + 3], (tc[c] << 16) | (tc[c + 1] << 8) | tc[c + 2], 255);
        let f = fills.get(st.hex);
        if (!f) { f = []; fills.set(st.hex, f); }
        f.push('M' + p[0] + ' ' + p[1] + 'L' + p[2] + ' ' + p[3] + 'L' + p[4] + ' ' + p[5] + 'Z');
      }
    }

    // 문자
    const texts = [];
    for (const t of scene.texts) {
      if (!vis(t.layer, t.group)) continue;
      if (t.h * k < 0.12) continue; // 0.12mm 미만은 인쇄해도 안 보임
      const b = t.bb;
      const bx0 = px0 + (b[0] - cx) * k, bx1 = px0 + (b[2] - cx) * k, by0 = py0 - (b[3] - cy) * k, by1 = py0 - (b[1] - cy) * k;
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
      const W = t.W;
      // 문자공간(y위) → 용지(mm, y아래): P·W·diag(1,-1)
      const m = [k * W[0], -k * W[1], -k * W[2], k * W[3], px0 + (W[4] - cx) * k, py0 - (W[5] - cy) * k];
      const st = styler(t.aci || 7, t.col, 255);
      let inner = '';
      for (const ln of t.lines) inner += `<text x="${r2(ln.dx)}" y="${r2(-ln.dy)}">${esc(ln.s)}</text>`;
      texts.push(`<g fill="${st.hex}" transform="matrix(${m.map((v) => +v.toFixed(5)).join(' ')})">${inner}</g>`);
    }

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.W}mm" height="${L.H}mm" viewBox="0 0 ${L.W} ${L.H}">`);
    parts.push(`<defs><clipPath id="pa"><rect x="${margin}" y="${margin}" width="${L.iw}" height="${L.ih}"/></clipPath></defs>`);
    parts.push(`<rect width="${L.W}" height="${L.H}" fill="#fff"/><g clip-path="url(#pa)">`);
    for (const [hex, f] of fills) parts.push(`<path fill="${hex}" d="${f.join('')}"/>`);
    // 가는 선을 먼저, 굵은 선을 나중에
    const sorted = [...strokes.values()].sort((a, b) => a.st.mm - b.st.mm);
    for (const g of sorted) parts.push(`<path fill="none" stroke="${g.st.hex}" stroke-width="${g.st.mm}" stroke-linecap="round" stroke-linejoin="round" d="${g.d.join('')}"/>`);
    parts.push(`<g font-family="${Scene.FONT.replace(/"/g, "'")}" font-size="${Scene.EM}" xml:space="preserve">${texts.join('')}</g>`);
    if (dims && dims.length) parts.push(dimSvg(dimPrims(dims, (p) => [px0 + (p[0] - cx) * k, py0 - (p[1] - cy) * k])));
    parts.push('</g></svg>');
    return { svg: parts.join('\n'), segCount, textCount: texts.length };
  }

  global.Plot = { parseCtb, BUILTIN, makeStyler, buildSvg, dimPrims, drawDims };
})(window);
