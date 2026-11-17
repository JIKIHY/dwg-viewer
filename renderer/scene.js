// 장면 생성: 파싱된 DXF(+XREF 도면들)를 블록 전개·테셀레이션해서 GPU용 버퍼로 만든다.
(function (global) {
  'use strict';

  // ───────── ACI 색상표 ─────────
  const ACI = (() => {
    const t = new Array(256).fill(0xffffff);
    const base = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
    for (let i = 0; i < 10; i++) t[i] = base[i];
    const V = [255, 165, 127, 76, 38];
    const hueRgb = (h) => {
      const x = (h % 60) / 60;
      if (h < 60) return [1, x, 0];
      if (h < 120) return [1 - x, 1, 0];
      if (h < 180) return [0, 1, x];
      if (h < 240) return [0, 1 - x, 1];
      if (h < 300) return [x, 0, 1];
      return [1, 0, 1 - x];
    };
    for (let i = 10; i < 250; i++) {
      const [r, g, b] = hueRgb((Math.floor(i / 10) - 1) * 15);
      const k = i % 10, v = V[k >> 1], pale = k & 1;
      const ch = (c) => Math.floor(pale ? v * c + (v / 2) * (1 - c) : v * c);
      t[i] = (ch(r) << 16) | (ch(g) << 8) | ch(b);
    }
    [51, 91, 132, 173, 214, 255].forEach((v, k) => (t[250 + k] = (v << 16) | (v << 8) | v));
    return t;
  })();

  // ───────── 2D 아핀 행렬 [a,b,c,d,e,f]: x'=a x + c y + e, y'=b x + d y + f ─────────
  const I = [1, 0, 0, 1, 0, 0];
  const MX = [-1, 0, 0, 1, 0, 0]; // OCS 법선 (0,0,-1) → WCS
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }
  const trs = (tx, ty, rotDeg, sx, sy) => {
    const r = (rotDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [c * sx, s * sx, -s * sy, c * sy, tx, ty];
  };
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

  // ───────── 가변 배열 ─────────
  class F64 {
    constructor(n) { this.a = new Float64Array(n || 1024); this.n = 0; }
    push2(x, y) {
      if (this.n + 2 > this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
      this.a[this.n++] = x; this.a[this.n++] = y;
    }
  }
  // 화면용 선 좌표: 첫 점을 기준으로 한 Float32 차이값으로 쌓는다 (Float64의 절반 메모리).
  // 최종 linePos도 Float32라 표시 정밀도는 같다
  class F32B {
    constructor(n) { this.a = new Float32Array(n || 1024); this.n = 0; this.bx = 0; this.by = 0; }
    push2(x, y) {
      if (this.n === 0) { this.bx = x; this.by = y; }
      if (this.n + 2 > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
      this.a[this.n++] = x - this.bx; this.a[this.n++] = y - this.by;
    }
  }
  class U32 {
    constructor(n) { this.a = new Uint32Array(n || 512); this.n = 0; }
    push(v) {
      if (this.n + 1 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
      this.a[this.n++] = v;
    }
  }

  // lite(휴대폰)용 가변 배열: 두 배로 새로 만들고 옛 배열을 버리는 대신 조각을 이어 붙인다.
  // 옛 배열 쓰레기(최종 크기만큼)가 생기지 않아 화면 구성 중 순간 메모리가 크게 준다
  class Chunks {
    constructor(T, first) { this.T = T; this.cur = new T(first); this.chunks = [this.cur]; this.ci = 0; this.n = 0; this.bx = 0; this.by = 0; }
    _grow() { this.cur = new this.T(Math.min(this.cur.length * 2, 1 << 20)); this.chunks.push(this.cur); this.ci = 0; }
    push(v) { if (this.ci === this.cur.length) this._grow(); this.cur[this.ci++] = v; this.n++; }
    push2(x, y) { // 좌표: 첫 점 기준 차이값 (F32B와 같음)
      if (this.n === 0) { this.bx = x; this.by = y; }
      if (this.ci + 2 > this.cur.length) this._grow();
      this.cur[this.ci++] = x - this.bx; this.cur[this.ci++] = y - this.by; this.n += 2;
    }
    flat() {
      const out = new this.T(this.n);
      let o = 0;
      for (const c of this.chunks) { const k = Math.min(c.length, this.n - o); if (k <= 0) break; out.set(k === c.length ? c : c.subarray(0, k), o); o += k; }
      return out;
    }
  }
  class U8 {
    constructor(n) { this.a = new Uint8Array(n || 256); this.n = 0; }
    push(v) {
      if (this.n + 1 > this.a.length) { const b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; }
      this.a[this.n++] = v;
    }
  }
  // 트루컬러 → 가장 가까운 ACI (CTB 적용용)
  const aciCache = new Map();
  function nearestAci(rgb) {
    let v = aciCache.get(rgb);
    if (v !== undefined) return v;
    const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
    let best = 7, bd = Infinity;
    for (let i = 1; i < 256; i++) {
      const c = ACI[i];
      const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    aciCache.set(rgb, best);
    return best;
  }
  const pack = (aci, rgb) => ((aci & 255) * 16777216) + (rgb & 0xffffff);

  // ───────── 문자 ─────────
  const FONT = '"Apple SD Gothic Neo", "Helvetica Neue", Arial, sans-serif';
  const EM = 1.15; // 문자 높이(h) 대비 폰트 em 크기
  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `100px ${FONT}`;
  const widthCache = new Map();
  function textWidth(s) { // 단위: 문자높이 h
    let w = widthCache.get(s);
    if (w === undefined) {
      w = (measureCtx.measureText(s).width / 100) * EM;
      widthCache.set(s, w);
    }
    return w;
  }
  function dxfText(s) {
    return s
      .replace(/%%([cC])/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
      .replace(/%%[uUoOkK]/g, '').replace(/%%(\d{3})/g, (m, d) => String.fromCharCode(+d)).replace(/%%%/g, '%');
  }
  function mtextPlain(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') {
        const nx = s[i + 1];
        if (nx === 'P' || nx === 'X') { out += '\n'; i++; }
        else if (nx === '\\' || nx === '{' || nx === '}') { out += nx; i++; }
        else if (nx === '~') { out += ' '; i++; }
        else if ('LlOoKkN'.includes(nx)) i++;
        else if (nx === 'S') {
          const end = s.indexOf(';', i);
          const body = s.slice(i + 2, end < 0 ? s.length : end);
          out += body.replace(/[\^#]/, '/').replace(/^\//, '').replace(/\/$/, '');
          i = end < 0 ? s.length : end;
        } else if ('fFHWQTACcpa'.includes(nx)) {
          const end = s.indexOf(';', i);
          i = end < 0 ? i + 1 : end;
        } else { out += nx || ''; i++; }
      } else if (ch !== '{' && ch !== '}') out += ch;
    }
    return dxfText(out);
  }
  function wrapLine(line, maxW) {
    if (!(maxW > 0) || textWidth(line) <= maxW * 1.02) return [line];
    const out = [];
    let cur = '';
    const tokens = line.match(/\S+\s*|\s+/g) || [line];
    for (const tok of tokens) {
      if (textWidth(cur + tok) <= maxW * 1.02 || !cur) {
        if (!cur && textWidth(tok) > maxW * 1.02) { // 공백 없는 긴 문자열은 글자 단위로
          for (const c of tok) {
            if (cur && textWidth(cur + c) > maxW * 1.02) { out.push(cur); cur = ''; }
            cur += c;
          }
        } else cur += tok;
      } else { out.push(cur.trimEnd()); cur = tok.trimStart(); }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ───────── 곡선 ─────────
  function arcPts(cx, cy, r, a1, sweep, tol, out) { // 라디안, sweep 부호 = 방향
    const n = Math.max(2, Math.min(512, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, 1e-12)))) || 2)));
    for (let i = 0; i <= n; i++) {
      const a = a1 + (sweep * i) / n;
      out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  function bulgeTo(out, x1, y1, x2, y2, b, tol) {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(b) < 1e-9 || dx * dx + dy * dy < 1e-24) { out.push(x2, y2); return; }
    const f = (1 - b * b) / (4 * b);
    const cx = (x1 + x2) / 2 - f * dy, cy = (y1 + y2) / 2 + f * dx;
    const r = Math.hypot(x1 - cx, y1 - cy);
    const tmp = [];
    arcPts(cx, cy, r, Math.atan2(y1 - cy, x1 - cx), 4 * Math.atan(b), tol, tmp);
    tmp[tmp.length - 2] = x2; tmp[tmp.length - 1] = y2;
    for (let i = 2; i < tmp.length; i++) out.push(tmp[i]);
  }
  function polyPts(pts, closed, tol) { // [x,y,bulge,...] → [x,y,...]
    const out = [];
    const n = pts.length / 3;
    if (!n) return out;
    out.push(pts[0], pts[1]);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      bulgeTo(out, pts[i * 3], pts[i * 3 + 1], pts[j * 3], pts[j * 3 + 1], pts[i * 3 + 2], tol);
    }
    return out;
  }
  function ellipsePts(cx, cy, mx, my, ratio, t1, t2, nz, tol) {
    if (t2 <= t1) t2 += Math.PI * 2;
    const R = Math.hypot(mx, my);
    const vx = -nz * my * ratio, vy = nz * mx * ratio;
    const n = Math.max(8, Math.min(512, Math.ceil((t2 - t1) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(R, 1e-12)))))));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = t1 + ((t2 - t1) * i) / n, c = Math.cos(t), s = Math.sin(t);
      out.push(cx + mx * c + vx * s, cy + my * c + vy * s);
    }
    return out;
  }
  function splinePts(degree, knots, ctrl, w, fit) {
    const nc = ctrl.length / 2;
    const p = degree | 0;
    if (nc < 2 || knots.length !== nc + p + 1 || p < 1) return fit.length >= 4 ? fit.slice() : ctrl.slice();
    const lo = knots[p], hi = knots[nc];
    if (!(hi > lo)) return ctrl.slice();
    const samples = Math.min(800, Math.max(24, nc * 10));
    const out = [];
    const d = new Array(p + 1);
    for (let s = 0; s <= samples; s++) {
      let u = lo + ((hi - lo) * s) / samples;
      if (s === samples) u = hi - 1e-10 * (hi - lo);
      let k = p;
      while (k < nc - 1 && knots[k + 1] <= u) k++;
      for (let j = 0; j <= p; j++) {
        const idx = k - p + j, wt = w.length === nc ? w[idx] : 1;
        d[j] = [ctrl[idx * 2] * wt, ctrl[idx * 2 + 1] * wt, wt];
      }
      for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
          const i = k - p + j;
          const den = knots[i + p - r + 1] - knots[i];
          const a = den === 0 ? 0 : (u - knots[i]) / den;
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
        }
      }
      out.push(d[p][0] / d[p][2], d[p][1] / d[p][2]);
    }
    return out;
  }

  // 선종류 적용: 연속 폴리선을 대시 세그먼트들로 분해
  function dashPolyline(pts, pattern, scale, emit) {
    const total = pattern.reduce((s, v) => s + Math.abs(v), 0) * scale;
    let len = 0;
    for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (!(total > 0) || len / total > 2000 || len < total * 0.5) return false; // 너무 촘촘/짧으면 실선
    const el = pattern.map((v) => v * scale);
    const dot = total * 0.002;
    let k = 0, rem = Math.abs(el[0]) || dot, on = el[0] >= 0;
    let px = pts[0], py = pts[1];
    for (let i = 2; i < pts.length; i += 2) {
      const qx = pts[i], qy = pts[i + 1];
      let segLen = Math.hypot(qx - px, qy - py);
      let sx = px, sy = py;
      const ux = segLen > 0 ? (qx - px) / segLen : 0, uy = segLen > 0 ? (qy - py) / segLen : 0;
      while (segLen > 0) {
        const step = Math.min(rem, segLen);
        const ex = sx + ux * step, ey = sy + uy * step;
        if (on) emit(sx, sy, ex, ey);
        segLen -= step; rem -= step; sx = ex; sy = ey;
        if (rem <= 1e-12) {
          k = (k + 1) % el.length;
          on = el[k] >= 0;
          rem = el[k] === 0 ? dot : Math.abs(el[k]);
        }
      }
      px = qx; py = qy;
    }
    return true;
  }

  // ───────── 해치 ─────────
  function polyArea(p) {
    let a = 0;
    for (let i = 0, n = p.length; i < n; i += 2) {
      const j = (i + 2) % n;
      a += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    return a / 2;
  }
  function pointInPoly(x, y, p) {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hatchLoops(e, tol) {
    const loops = [];
    for (const lp of e.loops) {
      let pts = [];
      if (lp.poly) pts = polyPts(lp.poly, true, tol);
      else if (lp.edges) {
        for (const ed of lp.edges) {
          let seg;
          if (ed.t === 1) seg = [ed.x1, ed.y1, ed.x2, ed.y2];
          else if (ed.t === 2 || ed.t === 3) {
            const isArc = ed.t === 2;
            const R = isArc ? ed.r : Math.hypot(ed.mx, ed.my);
            const build = (a1, a2, ccw) => {
              const s = (a1 * Math.PI) / 180;
              let sw = ((a2 - a1) * Math.PI) / 180;
              if (ccw) { while (sw <= 0) sw += Math.PI * 2; } else { while (sw >= 0) sw -= Math.PI * 2; }
              if (Math.abs(a2 - a1) >= 359.999) sw = ccw ? Math.PI * 2 : -Math.PI * 2;
              const out = [];
              if (isArc) arcPts(ed.cx, ed.cy, R, s, sw, tol, out);
              else {
                const n = Math.max(8, Math.ceil(Math.abs(sw) / 0.05));
                const rot = Math.atan2(ed.my, ed.mx);
                for (let i = 0; i <= n; i++) {
                  const t = s + (sw * i) / n;
                  const lx = R * Math.cos(t), ly = R * ed.ratio * Math.sin(t);
                  out.push(ed.cx + lx * Math.cos(rot) - ly * Math.sin(rot), ed.cy + lx * Math.sin(rot) + ly * Math.cos(rot));
                }
              }
              return out;
            };
            // 시계방향 호의 각도 표기는 구현마다 달라서, 이전 끝점과 이어지는 후보를 고른다.
            const cands = ed.ccw ? [build(ed.a1, ed.a2, true)] : [build(-ed.a1, -ed.a2, false), build(ed.a2, ed.a1, true)];
            seg = cands[0];
            if (cands.length > 1 && pts.length) {
              const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
              const dist = (c) => Math.min(Math.hypot(c[0] - lx, c[1] - ly), Math.hypot(c[c.length - 2] - lx, c[c.length - 1] - ly));
              if (dist(cands[1]) < dist(cands[0])) seg = cands[1];
            }
          } else if (ed.t === 4) seg = splinePts(ed.degree, ed.knots, ed.ctrl, ed.w, ed.fit);
          if (!seg || seg.length < 4) continue;
          if (pts.length) {
            const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
            const d0 = Math.hypot(seg[0] - lx, seg[1] - ly), d1 = Math.hypot(seg[seg.length - 2] - lx, seg[seg.length - 1] - ly);
            if (d1 < d0) { // 역방향 이음
              const rev = [];
              for (let i = seg.length - 2; i >= 0; i -= 2) rev.push(seg[i], seg[i + 1]);
              seg = rev;
            }
            for (let i = 2; i < seg.length; i++) pts.push(seg[i]);
          } else pts = seg.slice();
        }
      }
      if (pts.length >= 6) {
        const n = pts.length;
        if (Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) pts.length = n - 2;
        if (pts.length >= 6) loops.push(pts);
      }
    }
    return loops;
  }
  function triangulate(loops) {
    const earcut = global.earcut.default || global.earcut;
    const info = loops.map((p) => ({ p, area: Math.abs(polyArea(p)), depth: 0, parent: null, holes: [] })).filter((l) => l.area > 0);
    info.sort((a, b) => b.area - a.area);
    for (let i = 0; i < info.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        if (pointInPoly(info[i].p[0], info[i].p[1], info[j].p)) { info[i].parent = info[j]; info[i].depth = info[j].depth + 1; break; }
      }
      if (info[i].depth % 2 === 1) info[i].parent.holes.push(info[i]);
    }
    const tris = [];
    for (const o of info) {
      if (o.depth % 2) continue;
      const flat = o.p.slice();
      const holeIdx = [];
      for (const h of o.holes) { holeIdx.push(flat.length / 2); for (const v of h.p) flat.push(v); }
      const idx = earcut(flat, holeIdx);
      for (const k of idx) tris.push(flat[k * 2], flat[k * 2 + 1]);
    }
    return tris;
  }
  function hatchPattern(loops, plines, emit, cap) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of loops) for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    }
    if (!isFinite(x0)) return 0;
    // 촘촘한 패턴은 미리 개수를 추정해 상한을 넘으면 생략
    let est = 0;
    const fam = [];
    for (const pl of plines) {
      const a = (pl.ang * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
      const sp = pl.ox * nx + pl.oy * ny, sh = pl.ox * ux + pl.oy * uy;
      if (Math.abs(sp) < 1e-9) continue;
      let dmin = Infinity, dmax = -Infinity;
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const d = (cx - pl.bx) * nx + (cy - pl.by) * ny;
        dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
      }
      const k0 = Math.floor(Math.min(dmin / sp, dmax / sp)), k1 = Math.ceil(Math.max(dmin / sp, dmax / sp));
      est += k1 - k0;
      fam.push({ pl, ux, uy, nx, ny, sp, sh, k0, k1 });
    }
    if (est > cap) return -1;
    let count = 0;
    const edges = [];
    for (const p of loops) for (let i = 0, n = p.length; i < n; i += 2) {
      const j = (i + 2) % n;
      edges.push(p[i], p[i + 1], p[j], p[j + 1]);
    }
    for (const f of fam) {
      const dash = f.pl.dash;
      const total = dash.reduce((s, v) => s + Math.abs(v), 0);
      for (let k = f.k0; k <= f.k1; k++) {
        const ox = f.pl.bx + f.pl.ox * k, oy = f.pl.by + f.pl.oy * k; // 이 줄 위의 기준점
        const ts = [];
        for (let i = 0; i < edges.length; i += 4) {
          const ax = edges[i] - ox, ay = edges[i + 1] - oy, bx = edges[i + 2] - ox, by = edges[i + 3] - oy;
          const da = ax * f.nx + ay * f.ny, db = bx * f.nx + by * f.ny;
          if ((da > 0) === (db > 0) || da === db) continue;
          const t = da / (da - db);
          ts.push((ax + (bx - ax) * t) * f.ux + (ay + (by - ay) * t) * f.uy);
        }
        if (ts.length < 2) continue;
        ts.sort((a, b) => a - b);
        for (let q = 0; q + 1 < ts.length; q += 2) {
          const t1 = ts[q], t2 = ts[q + 1];
          if (!dash.length || !(total > 0)) {
            emit(ox + f.ux * t1, oy + f.uy * t1, ox + f.ux * t2, oy + f.uy * t2);
            count++;
            continue;
          }
          let s = Math.floor(t1 / total) * total;
          while (s < t2) {
            for (const d of dash) {
              const L = Math.abs(d);
              if (d >= 0) {
                const a = Math.max(s, t1), b = Math.min(s + (d === 0 ? total * 0.01 : L), t2);
                if (b > a) { emit(ox + f.ux * a, oy + f.uy * a, ox + f.ux * b, oy + f.uy * b); count++; }
              }
              s += L;
              if (s >= t2) break;
            }
            if (count > cap * 4) return count;
          }
        }
      }
    }
    return count;
  }

  // ───────── XCLIP 잘라내기 (월드 좌표 다각형) ─────────
  function makeClip(m, local) {
    const p = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < local.length; i += 2) {
      const x = m[0] * local[i] + m[2] * local[i + 1] + m[4], y = m[1] * local[i] + m[3] * local[i + 1] + m[5];
      p.push(x, y);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { p, bb: [x0, y0, x1, y1] };
  }
  const inClip = (c, x, y) => x >= c.bb[0] && x <= c.bb[2] && y >= c.bb[1] && y <= c.bb[3] && pointInPoly(x, y, c.p);
  const inClips = (clips, x, y) => clips.every((c) => inClip(c, x, y));
  // 선분을 잘라 안쪽 구간만 emit
  function clipSeg(clips, x1, y1, x2, y2, emit) {
    let iv = [[0, 1]];
    for (const c of clips) {
      if (Math.max(x1, x2) < c.bb[0] || Math.min(x1, x2) > c.bb[2] || Math.max(y1, y2) < c.bb[1] || Math.min(y1, y2) > c.bb[3]) return;
      const ts = [0, 1];
      const p = c.p, dx = x2 - x1, dy = y2 - y1;
      for (let i = 0, n = p.length; i < n; i += 2) {
        const j = (i + 2) % n;
        const ex = p[j] - p[i], ey = p[j + 1] - p[i + 1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-18) continue;
        const t = ((p[i] - x1) * ey - (p[i + 1] - y1) * ex) / den;
        const u = ((p[i] - x1) * dy - (p[i + 1] - y1) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
      ts.sort((a, b) => a - b);
      const keep = [];
      for (let k = 0; k + 1 < ts.length; k++) {
        const a = ts[k], b = ts[k + 1];
        if (b - a < 1e-12) continue;
        const mt = (a + b) / 2;
        if (pointInPoly(x1 + dx * mt, y1 + dy * mt, p)) keep.push([a, b]);
      }
      const next = [];
      for (const [a, b] of iv) for (const [c2, d] of keep) { const lo = Math.max(a, c2), hi = Math.min(b, d); if (hi > lo) next.push([lo, hi]); }
      iv = next;
      if (!iv.length) return;
    }
    for (const [a, b] of iv) emit(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
  }

  // ───────── 장면 빌더 ─────────
  function build(opts) {
    const { mainDoc, docs, attached } = opts;
    // lite(휴대폰): 스냅 점은 Float32(기준점 차이)로, 스냅용 선분(segs)은 따로 모으지 않는다 — 화면용 linePos를 대신 쓴다
    const LITE = !!opts.lite;
    const H = mainDoc;
    let diag = Math.hypot(H.extmax[0] - H.extmin[0], H.extmax[1] - H.extmin[1]);
    if (!(diag > 0 && diag < 1e9)) diag = 100000;
    const TOL = diag * 4e-6;

    const layers = new Map(); // key → info
    const layerList = [];
    const groups = [{ key: '', name: '현재 도면' }];
    const groupIndex = new Map([['', 0]]);
    const buckets = new Map(); // "layerId:groupId" → {lines:F64, lcol:U32, tris:F64, tcol:U32}
    const texts = [];
    // 스냅용 점·선분. 큰 XREF 묶음은 수백만 개라 일반 배열 대신 타입 배열로 쌓는다 (휴대폰 메모리)
    const snapPts = LITE ? new Chunks(Float32Array, 4096) : new F64(4096), snapKind = LITE ? new Chunks(Uint8Array, 2048) : new U8(2048), snapLayer = LITE ? new Chunks(Uint16Array, 2048) : new U32(2048);
    const segs = LITE ? null : new F64(8192), segLayer = LITE ? null : new U32(2048);
    const stats = { entities: 0, skippedHatch: 0 };

    function layerInfo(ctx, rawName) {
      let key = rawName.toUpperCase();
      if (key === '0' && ctx.blockLayer !== null) return ctx.blockLayer;
      if (ctx.prefix) key = ctx.prefix + key;
      let info = layers.get(key);
      if (info) return info;
      const own = ctx.doc.layers[rawName.toUpperCase()];
      const host = ctx.prefix ? H.layers[key] : null;
      const src = host || own || { name: rawName, color: 7, tc: null, on: true, frozen: false, lt: 'CONTINUOUS' };
      info = {
        id: layerList.length,
        key,
        name: ctx.prefix ? ctx.prefix + (own ? own.name : rawName) : src.name || rawName,
        rgb: src.tc !== null && src.tc !== undefined ? src.tc & 0xffffff : ACI[src.color] || 0xffffff,
        aci: src.tc !== null && src.tc !== undefined ? nearestAci(src.tc & 0xffffff) : src.color || 7,
        lw: src.lw === undefined || isNaN(src.lw) ? -3 : src.lw,
        visible: src.on && !src.frozen,
        lt: (src.lt || 'CONTINUOUS').toUpperCase(),
        ltDoc: host ? H : ctx.doc,
        count: 0,
      };
      layers.set(key, info);
      layerList.push(info);
      return info;
    }
    // lite: 도면을 TS 크기 구역(타일)으로 나눠 버킷을 따로 둔다 → 휴대폰은 구역별로 GPU에 올리고 보이는 구역만 그린다
    const TS = diag / 6;
    const tileIds = new Map();
    function tileAt(x, y) {
      if (!LITE || !isFinite(x) || !isFinite(y)) return 0;
      const key = Math.floor(x / TS) + ',' + Math.floor(y / TS);
      let id = tileIds.get(key);
      if (id === undefined) { id = tileIds.size; tileIds.set(key, id); }
      return id;
    }
    function bucket(L, ctx, tile) {
      const t = tile || 0;
      const k = (t * 65536 + L.id) * 65536 + ctx.group;
      let b = buckets.get(k);
      if (!b) { b = { tile: t, layer: L.id, group: ctx.group, lines: LITE ? new Chunks(Float32Array, 256) : new F32B(256), lcol: LITE ? new Chunks(Uint32Array, 128) : new U32(128), llw: LITE ? null : new U8(64), tris: new F64(64), tcol: new U32(32) }; buckets.set(k, b); }
      return b;
    }
    const tileOfLocal = (m, x, y) => (LITE ? tileAt(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]) : 0);
    // 색상은 (ACI << 24 | RGB) 로 묶어 다닌다. ACI는 CTB 인쇄에 쓰인다.
    function colorOf(e, ctx, L) {
      if (e.tc !== null && e.tc !== undefined) return pack(nearestAci(e.tc & 0xffffff), e.tc);
      const c = e.color;
      if (c === 0) return ctx.blockColor;
      if (c === 256 || c === undefined || isNaN(c)) return pack(L.aci, L.rgb);
      const a = Math.abs(c);
      return pack(a, ACI[a] || 0xffffff);
    }
    // 선가중치(1/100mm). 255 = 기본값
    function lwOf(e, ctx, L) {
      let v = e.lw;
      if (v === -1 || v === undefined || isNaN(v)) v = L.lw;
      if (v === -2) return ctx.blockLw === undefined ? 255 : ctx.blockLw;
      return v >= 0 && v <= 211 ? v : 255;
    }
    let curLw = 255;
    function ltPattern(e, ctx, L) {
      let name = (e.lt || 'BYLAYER').toUpperCase();
      let doc = ctx.doc;
      if (name === 'BYLAYER') { name = L.lt; doc = L.ltDoc; }
      else if (name === 'BYBLOCK') { return ctx.blockLt; }
      if (!name || name === 'CONTINUOUS') return null;
      const pat = doc.ltypes[name];
      return pat && pat.length >= 2 ? pat : null;
    }
    const xf = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

    let curClips = null; // walk 중인 엔티티의 잘라내기 경계
    function addSnap(m, x, y, kind, L) {
      const p = xf(m, x, y);
      if (curClips && !inClips(curClips, p[0], p[1])) return;
      snapPts.push2(p[0], p[1]); snapKind.push(kind); snapLayer.push(L.id);
    }
    // 폴리선 출력 (로컬 좌표 → 월드)
    function emitPoly(ctx, pts, closed, col, L, pat, ltsc) {
      if (pts.length < 4) return;
      if (closed) pts = pts.concat([pts[0], pts[1]]);
      const m = ctx.m;
      const b = bucket(L, ctx, tileOfLocal(m, pts[0], pts[1]));
      const clips = ctx.clips;
      const put = LITE ? (ax, ay, bx, by) => { b.lines.push2(ax, ay); b.lines.push2(bx, by); b.lcol.push(col); }
        : (ax, ay, bx, by) => { b.lines.push2(ax, ay); b.lines.push2(bx, by); b.lcol.push(col); b.lcol.push(col); b.llw.push(curLw); };
      const seg = (x1, y1, x2, y2) => {
        const ax = m[0] * x1 + m[2] * y1 + m[4], ay = m[1] * x1 + m[3] * y1 + m[5];
        const bx = m[0] * x2 + m[2] * y2 + m[4], by = m[1] * x2 + m[3] * y2 + m[5];
        if (clips) clipSeg(clips, ax, ay, bx, by, put); else put(ax, ay, bx, by);
      };
      const putSnap = LITE ? () => {} : (ax, ay, bx, by) => { segs.push2(ax, ay); segs.push2(bx, by); segLayer.push(L.id); };
      let dashed = false;
      if (pat) dashed = dashPolyline(pts, pat, ltsc, seg);
      for (let i = 2; i < pts.length; i += 2) {
        if (!dashed) seg(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
        if (LITE) continue;
        const a = xf(m, pts[i - 2], pts[i - 1]), c = xf(m, pts[i], pts[i + 1]);
        if (clips) clipSeg(clips, a[0], a[1], c[0], c[1], putSnap); else putSnap(a[0], a[1], c[0], c[1]);
      }
      L.count++;
    }
    function emitTris(ctx, tri, col, L) {
      const m = ctx.m;
      const b = bucket(L, ctx, tri.length >= 2 ? tileOfLocal(m, tri[0], tri[1]) : 0);
      for (let i = 0; i + 5 < tri.length; i += 6) {
        const w = [];
        for (let k = 0; k < 6; k += 2) w.push(m[0] * tri[i + k] + m[2] * tri[i + k + 1] + m[4], m[1] * tri[i + k] + m[3] * tri[i + k + 1] + m[5]);
        if (ctx.clips && !inClips(ctx.clips, (w[0] + w[2] + w[4]) / 3, (w[1] + w[3] + w[5]) / 3)) continue;
        for (let k = 0; k < 6; k += 2) { b.tris.push2(w[k], w[k + 1]); b.tcol.push(col); }
      }
    }
    function emitText(ctx, L, col, lines, gm, anchorX, anchorY) {
      // gm: 문자공간(단위=h, y위쪽) → 월드
      const W = mul(ctx.m, gm);
      if (ctx.clips && !inClips(ctx.clips, W[4], W[5])) return;
      const hpx = Math.hypot(W[2], W[3]);
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const ln of lines) {
        for (const [gx, gy] of [[ln.dx, ln.dy - 0.3], [ln.dx + ln.w, ln.dy - 0.3], [ln.dx, ln.dy + 1.1], [ln.dx + ln.w, ln.dy + 1.1]]) {
          const p = xf(W, gx, gy);
          minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
        }
      }
      texts.push({ W, h: hpx, lines, col: col % 16777216, aci: Math.floor(col / 16777216), layer: L.id, group: ctx.group, bb: [minx, miny, maxx, maxy], str: lines.map((l) => l.s).join(' ') });
      L.count++;
    }

    function doText(e, ctx) {
      const L = layerInfo(ctx, e.layer), col = colorOf(e, ctx, L);
      const s = dxfText(e.text || '');
      if (!s.trim() || !(e.h > 0)) return;
      const m0 = e.ez < 0 ? mul(ctx.m, MX) : ctx.m;
      const c2 = { ...ctx, m: m0 };
      const w = textWidth(s);
      let px = e.x, py = e.y, rot = e.rot, h = e.h, wf = e.wf;
      const useAlign = (e.hj || e.vj) && e.ax !== null;
      if (useAlign) { px = e.ax; py = e.ay; }
      if ((e.hj === 3 || e.hj === 5) && e.ax !== null) { // 정렬/맞춤: 두 점 사이에 맞춘다
        const L2 = Math.hypot(e.ax - e.x, e.ay - e.y);
        if (L2 > 0 && w > 0) {
          rot = (Math.atan2(e.ay - e.y, e.ax - e.x) * 180) / Math.PI;
          if (e.hj === 3) { h = L2 / (w * wf); } else { wf = L2 / (w * h); }
          px = e.x; py = e.y;
        }
      }
      const r = (rot * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
      const ob = Math.tan((e.obl * Math.PI) / 180);
      let sx = h * wf, sy = h;
      if (e.gen & 2) sx = -sx;
      if (e.gen & 4) sy = -sy;
      // 문자공간 → 엔티티 로컬: 회전 · 기울기 · 축척
      const gm = [cr * sx, sr * sx, (cr * ob - sr) * sy, (sr * ob + cr) * sy, px, py];
      let dx = 0, dy = 0;
      if (e.hj === 1 || e.hj === 4) dx = -w / 2;
      else if (e.hj === 2) dx = -w;
      if (e.hj === 4 && !e.vj) dy = -0.5;
      if (e.vj === 1) dy = 0.25;
      else if (e.vj === 2) dy = -0.5;
      else if (e.vj === 3) dy = -1;
      if (e.hj === 3 || e.hj === 5) { dx = 0; dy = 0; }
      emitText(c2, L, col, [{ s, dx, dy, w }], gm);
    }
    function doMText(e, ctx) {
      const L = layerInfo(ctx, e.layer), col = colorOf(e, ctx, L);
      const plain = mtextPlain(e.text || '');
      if (!plain.trim() || !(e.h > 0)) return;
      const maxW = e.w > 0 ? e.w / e.h : 0;
      const lines = [];
      for (const para of plain.split('\n')) for (const l of wrapLine(para, maxW)) lines.push(l);
      const ls = (5 / 3) * e.lsf;
      const total = 1 + (lines.length - 1) * ls;
      const a = e.attach || 1;
      const row = Math.floor((a - 1) / 3), colA = (a - 1) % 3;
      const top = row === 0 ? 0 : row === 1 ? total / 2 : total;
      const out = lines.map((s, i) => {
        const w = textWidth(s);
        return { s, w, dy: top - 1 - i * ls, dx: colA === 0 ? 0 : colA === 1 ? -w / 2 : -w };
      });
      const r = (e.rot * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
      emitText(ctx, L, col, out, [cr * e.h, sr * e.h, -sr * e.h, cr * e.h, e.x, e.y]);
    }

    function insertBlock(blk, e, ctx, depth, stack, L, col) {
      const m0 = e.ez < 0 ? mul(ctx.m, MX) : ctx.m;
      const childBase = {
        blockLayer: L,
        blockColor: col,
        blockLt: ltPattern(e, ctx, L),
        blockLw: lwOf(e, ctx, L),
      };
      const isXref = (blk.flags & 4) !== 0;
      let doc = ctx.doc, ents = blk.entities, prefix = ctx.prefix, group = ctx.group;
      if (isXref) {
        const p = ctx.doc.xrefPaths && ctx.doc.xrefPaths[blk.name.toUpperCase()];
        const xd = p && docs.get(p);
        if (!xd) return;
        doc = xd;
        ents = xd.entities.filter((x) => !x.ps);
        prefix = blk.name.toUpperCase() + '|';
        if (ctx.group === 0) {
          const gk = blk.name.toUpperCase();
          if (!groupIndex.has(gk)) { groupIndex.set(gk, groups.length); groups.push({ key: gk, name: blk.name }); }
          group = groupIndex.get(gk);
        }
      }
      for (let r = 0; r < e.rows; r++) {
        for (let c = 0; c < e.cols; c++) {
          const rr = (e.rot * Math.PI) / 180;
          const offx = c * e.cs * Math.cos(rr) - r * e.rs * Math.sin(rr);
          const offy = c * e.cs * Math.sin(rr) + r * e.rs * Math.cos(rr);
          const m = mul(m0, mul(trs(e.x + offx, e.y + offy, e.rot, e.sx, e.sy), [1, 0, 0, 1, -blk.bx, -blk.by]));
          const child = { ...ctx, ...childBase, m, doc, prefix, group };
          const cl = e.handle && ctx.doc.clips && ctx.doc.clips[e.handle];
          if (cl) child.clips = (ctx.clips || []).concat([makeClip(m, cl)]);
          for (const ce of ents) walk(ce, child, depth + 1, stack);
        }
      }
    }

    function walk(e, ctx, depth, stack) {
      stats.entities++;
      curClips = ctx.clips || null;
      const t = e.type;
      if (t === 'INSERT' || t === 'DIMENSION') {
        const name = (t === 'INSERT' ? e.name : e.block).toUpperCase();
        const L = layerInfo(ctx, e.layer), col = colorOf(e, ctx, L);
        const blk = ctx.doc.blocks[name];
        if (blk && depth < 40 && !stack.includes(name)) {
          const st = stack.concat(name);
          if (t === 'DIMENSION') {
            const child = { ...ctx, blockLayer: L, blockColor: col, blockLt: null, blockLw: lwOf(e, ctx, L) };
            for (const ce of blk.entities) walk(ce, child, depth + 1, st);
          } else {
            if ((blk.flags & 4) && depth > 0 && (blk.flags & 8)) return; // 중첩 오버레이는 표시 안 함
            insertBlock(blk, e, ctx, depth, st, L, col);
          }
        }
        if (t === 'INSERT') for (const a of e.attribs) doText(a, ctx);
        return;
      }
      if (t === 'TEXT' || t === 'ATTRIB') return doText(e, ctx);
      if (t === 'MTEXT') return doMText(e, ctx);

      const L = layerInfo(ctx, e.layer);
      const col = colorOf(e, ctx, L);
      curLw = lwOf(e, ctx, L);
      const pat = ltPattern(e, ctx, L);
      const ltsc = (ctx.doc.ltscale || 1) * (e.lts || 1);
      const ocs = e.ez < 0 ? { ...ctx, m: mul(ctx.m, MX) } : ctx;
      const tol = TOL / scaleOf(ctx.m);

      switch (t) {
        case 'LINE':
          emitPoly(ctx, [e.x1, e.y1, e.x2, e.y2], false, col, L, pat, ltsc);
          addSnap(ctx.m, e.x1, e.y1, 1, L); addSnap(ctx.m, e.x2, e.y2, 1, L);
          addSnap(ctx.m, (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, 2, L);
          break;
        case 'CIRCLE': {
          const pts = [];
          arcPts(e.cx, e.cy, e.r, 0, Math.PI * 2, tol, pts);
          emitPoly(ocs, pts, false, col, L, pat, ltsc);
          addSnap(ocs.m, e.cx, e.cy, 3, L);
          for (let q = 0; q < 4; q++) addSnap(ocs.m, e.cx + e.r * Math.cos((q * Math.PI) / 2), e.cy + e.r * Math.sin((q * Math.PI) / 2), 4, L);
          break;
        }
        case 'ARC': {
          let sw = e.a2 - e.a1;
          while (sw <= 0) sw += 360;
          const pts = [];
          arcPts(e.cx, e.cy, e.r, (e.a1 * Math.PI) / 180, (sw * Math.PI) / 180, tol, pts);
          emitPoly(ocs, pts, false, col, L, pat, ltsc);
          addSnap(ocs.m, pts[0], pts[1], 1, L); addSnap(ocs.m, pts[pts.length - 2], pts[pts.length - 1], 1, L);
          const mid = ((e.a1 + sw / 2) * Math.PI) / 180;
          addSnap(ocs.m, e.cx + e.r * Math.cos(mid), e.cy + e.r * Math.sin(mid), 2, L);
          addSnap(ocs.m, e.cx, e.cy, 3, L);
          break;
        }
        case 'ELLIPSE': {
          const pts = ellipsePts(e.cx, e.cy, e.mx, e.my, e.ratio, e.t1, e.t2, e.ez < 0 ? -1 : 1, tol);
          emitPoly(ctx, pts, false, col, L, pat, ltsc);
          addSnap(ctx.m, e.cx, e.cy, 3, L);
          if (Math.abs(e.t2 - e.t1 - Math.PI * 2) > 1e-6) { addSnap(ctx.m, pts[0], pts[1], 1, L); addSnap(ctx.m, pts[pts.length - 2], pts[pts.length - 1], 1, L); }
          break;
        }
        case 'LWPOLYLINE': {
          const pts = polyPts(e.pts, e.closed, tol);
          emitPoly(ocs, pts, false, col, L, pat, ltsc);
          const n = e.pts.length / 3;
          for (let i = 0; i < n; i++) {
            addSnap(ocs.m, e.pts[i * 3], e.pts[i * 3 + 1], 1, L);
            const j = i + 1 < n ? i + 1 : e.closed ? 0 : -1;
            if (j >= 0 && Math.abs(e.pts[i * 3 + 2]) < 1e-9) addSnap(ocs.m, (e.pts[i * 3] + e.pts[j * 3]) / 2, (e.pts[i * 3 + 1] + e.pts[j * 3 + 1]) / 2, 2, L);
          }
          break;
        }
        case 'SPLINE': {
          const pts = splinePts(e.degree, e.knots, e.ctrl, e.w, e.fit);
          emitPoly(ctx, pts, false, col, L, pat, ltsc);
          if (pts.length >= 4) { addSnap(ctx.m, pts[0], pts[1], 1, L); addSnap(ctx.m, pts[pts.length - 2], pts[pts.length - 1], 1, L); }
          break;
        }
        case 'LEADER': {
          if (e.pts.length < 4) break;
          emitPoly(ctx, e.pts, false, col, L, null, 1);
          if (e.arrow) {
            const s = (ctx.doc.dimasz || 2.5);
            const [x0, y0, x1, y1] = e.pts;
            const d = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / d, uy = (y1 - y0) / d;
            emitTris(ctx, [x0, y0, x0 + ux * s - uy * s / 6, y0 + uy * s + ux * s / 6, x0 + ux * s + uy * s / 6, y0 + uy * s - ux * s / 6], col, L);
          }
          addSnap(ctx.m, e.pts[0], e.pts[1], 1, L);
          break;
        }
        case 'SOLID': {
          const p = e.p;
          emitTris(ocs, [p[0], p[1], p[2], p[3], p[4], p[5], p[2], p[3], p[6], p[7], p[4], p[5]], col, L);
          L.count++;
          break;
        }
        case '3DFACE': {
          const p = e.p;
          emitPoly(ctx, [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]], true, col, L, null, 1);
          break;
        }
        case 'HATCH': {
          const loops = hatchLoops(e, tol);
          if (!loops.length) break;
          if (e.solid) emitTris(ocs, triangulate(loops), col, L);
          else if (e.plines.length) {
            const m = ocs.m, l0 = loops[0];
            const b = bucket(L, ocs, l0 && l0.length >= 2 ? tileOfLocal(m, l0[0], l0[1]) : 0);
            const put = LITE ? (ax, ay, bx, by) => { b.lines.push2(ax, ay); b.lines.push2(bx, by); b.lcol.push(col); }
              : (ax, ay, bx, by) => { b.lines.push2(ax, ay); b.lines.push2(bx, by); b.lcol.push(col); b.lcol.push(col); b.llw.push(curLw); };
            const n = hatchPattern(loops, e.plines, (x1, y1, x2, y2) => {
              const ax = m[0] * x1 + m[2] * y1 + m[4], ay = m[1] * x1 + m[3] * y1 + m[5];
              const bx = m[0] * x2 + m[2] * y2 + m[4], by = m[1] * x2 + m[3] * y2 + m[5];
              if (ocs.clips) clipSeg(ocs.clips, ax, ay, bx, by, put); else put(ax, ay, bx, by);
            }, 6000);
            if (n < 0) stats.skippedHatch++;
          }
          L.count++;
          break;
        }
      }
    }

    // ── 실행 ──
    let ents = mainDoc.entities.filter((e) => !e.ps);
    let space = 'model';
    if (!ents.length) { ents = mainDoc.entities.filter((e) => e.ps); space = 'paper'; }
    const root = { m: I, doc: mainDoc, prefix: '', group: 0, blockLayer: null, blockColor: pack(7, 0xffffff), blockLt: null, blockLw: 255 };
    for (const e of ents) walk(e, root, 0, []);

    // 수동 부착 XREF
    for (const a of attached || []) {
      const xd = docs.get(a.path);
      if (!xd) continue;
      const gk = '@' + a.name.toUpperCase();
      if (!groupIndex.has(gk)) { groupIndex.set(gk, groups.length); groups.push({ key: gk, name: a.name, manual: true }); }
      const m = mul(trs(a.x, a.y, a.rot, a.scale, a.scale), [1, 0, 0, 1, -xd.insbase[0], -xd.insbase[1]]);
      const ctx = { m, doc: xd, prefix: a.name.toUpperCase() + '|', group: groupIndex.get(gk), blockLayer: null, blockColor: pack(7, 0xffffff), blockLt: null, blockLw: 255 };
      for (const e of xd.entities) if (!e.ps) walk(e, ctx, 1, []);
    }

    // ── 범위 계산 ──
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (opts.freeDocs && docs && docs.clear) docs.clear(); // 전개 끝: 호출한 쪽이 허락하면 XREF 해석본을 놓는다
    const sx = [], sy = [];
    let totalL = 0, totalT = 0;
    for (const b of buckets.values()) {
      totalL += b.lines.n / 2; totalT += b.tris.n / 2;
      const bx = b.lines.bx, by = b.lines.by;
      let rem = b.lines.n, g = 0;
      for (const a of b.lines.chunks || [b.lines.a]) {
        const m = Math.min(a.length, rem);
        for (let i = 0; i < m; i += 2, g += 2) {
          const x = a[i] + bx, y = a[i + 1] + by;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if ((g & 63) === 0) { sx.push(x); sy.push(y); }
        }
        rem -= m;
        if (rem <= 0) break;
      }
      for (let i = 0; i < b.tris.n; i += 2) {
        const x = b.tris.a[i], y = b.tris.a[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    for (const t of texts) {
      x0 = Math.min(x0, t.bb[0]); y0 = Math.min(y0, t.bb[1]); x1 = Math.max(x1, t.bb[2]); y1 = Math.max(y1, t.bb[3]);
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1000; y1 = 1000; }
    const full = [x0, y0, x1, y1];
    // 멀리 떨어진 잔여 객체가 있으면 전체보기는 핵심 영역 기준
    let ext = full;
    if (sx.length > 50) {
      sx.sort((a, b) => a - b); sy.sort((a, b) => a - b);
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
      const r = [q(sx, 0.003), q(sy, 0.003), q(sx, 0.997), q(sy, 0.997)];
      const rw = Math.hypot(r[2] - r[0], r[3] - r[1]), fw = Math.hypot(x1 - x0, y1 - y0);
      if (rw > 0 && fw / rw > 8) {
        const pad = rw * 0.15;
        ext = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
      }
    }
    // AutoCAD가 저장한 도면 범위($EXTMIN/$EXTMAX)가 유효하면 그것을 전체보기 기준으로
    const hx = [H.extmin[0], H.extmin[1], H.extmax[0], H.extmax[1]];
    const hd = Math.hypot(hx[2] - hx[0], hx[3] - hx[1]);
    // 저장된 범위가 실제 그림보다 좁고(잔여 객체 제외 효과) 그림의 대부분을 담을 때만 사용
    const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    if (space === 'model' && hd > 0 && hd < 1e12 && area(hx) <= area(ext) * 1.05) {
      const ix = [Math.max(hx[0], ext[0]), Math.max(hx[1], ext[1]), Math.min(hx[2], ext[2]), Math.min(hx[3], ext[3])];
      if (area(ix) >= area(hx) * 0.8 && area(hx) >= area(ext) * 0.02) ext = hx;
    }
    const ox = (ext[0] + ext[2]) / 2, oy = (ext[1] + ext[3]) / 2;

    // ── GPU 버퍼로 합치기 (레이어·그룹별 연속 구간) ──
    const triPos = new Float32Array(totalT * 2), triCol = new Uint8Array(totalT * 4);
    const ranges = [];
    let li = 0, ti = 0;
    const sorted = [...buckets.values()].sort((a, b) => a.tile - b.tile || a.layer - b.layer || a.group - b.group);
    buckets.clear();
    const putTris = (b) => {
      for (let i = 0; i < b.tris.n; i += 2) {
        triPos[ti * 2] = b.tris.a[i] - ox; triPos[ti * 2 + 1] = b.tris.a[i + 1] - oy;
        const c = b.tcol.a[i >> 1];
        triCol[ti * 4] = (c >> 16) & 255; triCol[ti * 4 + 1] = (c >> 8) & 255; triCol[ti * 4 + 2] = c & 255; triCol[ti * 4 + 3] = Math.floor(c / 16777216);
        ti++;
      }
    };
    let linePos = null, lineCol = null, lineLw = null;
    const tiles = [];
    if (LITE) {
      // lite(휴대폰): 화면 전체 선 배열을 만들지 않고 구역마다 만들어 opts.onTile로 넘긴 뒤(GPU로 올림) 버킷을 바로 놓는다.
      // 구역 좌표(pos)는 스냅용으로 남기고, 색(col)은 넘긴 뒤 버린다 → 최대 메모리가 선 데이터 한 벌 남짓
      for (const b of sorted) {
        const r = { layer: b.layer, group: b.group, ls: 0, lc: 0, ts: ti, tc: b.tris.n / 2, tile: b.tile };
        putTris(b);
        if (r.tc) ranges.push(r);
        b.tris = b.tcol = null;
      }
      let i0 = 0;
      while (i0 < sorted.length) {
        const tile = sorted[i0].tile;
        let i1 = i0, nv = 0;
        while (i1 < sorted.length && sorted[i1].tile === tile) { nv += sorted[i1].lines.n / 2; i1++; }
        if (nv) {
          const pos = new Float32Array(nv * 2), col = new Uint8Array(nv * 4), pieces = [], bb = [Infinity, Infinity, -Infinity, -Infinity];
          let v = 0;
          for (let j = i0; j < i1; j++) {
            const b = sorted[j], n = b.lines.n / 2;
            if (n) {
              pieces.push({ layer: b.layer, group: b.group, s: v, n });
              const lbx = b.lines.bx - ox, lby = b.lines.by - oy;
              const lch = b.lcol.chunks;
              let lcI = 0, lcP = 0, c = 0, rem = b.lines.n, k = 0;
              for (const a of b.lines.chunks) {
                const m = Math.min(a.length, rem);
                for (let i = 0; i < m; i += 2, k++) {
                  const px = a[i] + lbx, py = a[i + 1] + lby;
                  pos[v * 2] = px; pos[v * 2 + 1] = py;
                  if (px < bb[0]) bb[0] = px; if (px > bb[2]) bb[2] = px; if (py < bb[1]) bb[1] = py; if (py > bb[3]) bb[3] = py;
                  if (!(k & 1)) { // lite는 색을 선분당 한 번 저장 → 선분 시작점에서 다음 색을 꺼낸다
                    c = lch[lcI][lcP++];
                    if (lcP === lch[lcI].length) { lcI++; lcP = 0; }
                  }
                  col[v * 4] = (c >> 16) & 255; col[v * 4 + 1] = (c >> 8) & 255; col[v * 4 + 2] = c & 255; col[v * 4 + 3] = Math.floor(c / 16777216);
                  v++;
                }
                rem -= m;
                if (rem <= 0) break;
              }
            }
            b.lines = b.lcol = null;
            sorted[j] = null;
          }
          const t = { pieces, bb, n: nv / 2, pos };
          if (opts.onTile) opts.onTile(t, col); else t.col = col;
          tiles.push(t);
        }
        i0 = i1;
      }
      li = totalL;
    } else {
      linePos = new Float32Array(totalL * 2); lineCol = new Uint8Array(totalL * 4); lineLw = new Uint8Array(totalL / 2);
      for (const b of sorted) {
        const r = { layer: b.layer, group: b.group, ls: li, lc: b.lines.n / 2, ts: ti, tc: b.tris.n / 2 };
        const lbx = b.lines.bx - ox, lby = b.lines.by - oy;
        for (let i = 0; i < b.lines.n; i += 2) {
          linePos[li * 2] = b.lines.a[i] + lbx; linePos[li * 2 + 1] = b.lines.a[i + 1] + lby;
          const c = b.lcol.a[i >> 1];
          lineCol[li * 4] = (c >> 16) & 255; lineCol[li * 4 + 1] = (c >> 8) & 255; lineCol[li * 4 + 2] = c & 255; lineCol[li * 4 + 3] = Math.floor(c / 16777216);
          if (!(li & 1)) lineLw[li >> 1] = b.llw.a[i >> 2];
          li++;
        }
        putTris(b);
        ranges.push(r);
        b.lines = b.lcol = b.llw = b.tris = b.tcol = null; // 옮긴 버킷은 바로 놓아 최대 메모리를 낮춘다
      }
    }
    sorted.length = 0;
    // 다 쓴 가변 배열의 남는 칸 정리: 많이 남으면 잘라 복사, 거의 찼으면 복사 없이 앞부분만 본다
    const trim = (v) => (v.n === v.a.length ? v.a : v.n < v.a.length * 0.75 ? v.a.slice(0, v.n) : v.a.subarray(0, v.n));

    return {
      layers: layerList,
      groups,
      ranges,
      linePos, lineCol, lineLw, triPos, triCol,
      stylesheet: mainDoc.stylesheet || '',
      origin: [ox, oy],
      extents: ext,
      fullExtents: full,
      texts,
      // base: 스냅 점 좌표에 더할 기준점 (lite에서만 0이 아님)
      snap: LITE ? { pts: snapPts.flat(), base: [snapPts.bx, snapPts.by], kind: snapKind.flat(), layer: snapLayer.flat() }
        : { pts: trim(snapPts), base: [0, 0], kind: trim(snapKind), layer: trim(snapLayer) },
      segs: LITE ? null : { a: trim(segs), layer: trim(segLayer) },
      tiles: LITE ? tiles : null, // lite: 구역별 {pieces, bb, n, pos} (색은 onTile로 넘김). 이때 linePos·lineCol은 null
      space,
      units: mainDoc.insunits,
      stats: { ...stats, segments: totalL / 2, triangles: totalT / 3, texts: texts.length },
    };
  }

  global.Scene = { build, ACI, FONT, EM };
})(window);
