// DXF 파서: 뷰어에 필요한 HEADER / TABLES(LAYER, LTYPE) / BLOCKS / ENTITIES만 읽는다.
(function (global) {
  'use strict';

  const DECODERS = {};
  function decoder(label) {
    if (!DECODERS[label]) DECODERS[label] = new TextDecoder(label);
    return DECODERS[label];
  }

  // 2007 이상은 UTF-8, 그 이전 DXF는 시스템 코드페이지(한글은 CP949).
  // LibreDWG가 UTF-8 문자열을 글자 중간에서 자르는 경우가 있어서, 파일 전체가 아니라
  // 깨진 줄만 골라 (끝 잘림 제거한 UTF-8 → CP949) 순서로 다시 해석한다.
  function decodeBytes(u8) {
    const text = new TextDecoder('utf-8').decode(u8);
    if (text.indexOf('�') < 0) return text;
    const lines = text.split('\n');
    const strict = new TextDecoder('utf-8', { fatal: true });
    const cp949 = new TextDecoder('euc-kr', { fatal: true });
    let li = 0, start = 0;
    for (let i = 0; i <= u8.length; i++) {
      if (i < u8.length && u8[i] !== 10) continue;
      if (lines[li] !== undefined && lines[li].indexOf('�') >= 0) {
        let end = i;
        if (end > start && u8[end - 1] === 13) end--;
        lines[li] = repairLine(u8.subarray(start, end), strict, cp949, lines[li]);
      }
      li++;
      start = i + 1;
    }
    return lines.join('\n');
  }
  function repairLine(b, strict, cp949, fallback) {
    for (let cut = 1; cut <= 3 && cut < b.length; cut++) {
      try { return strict.decode(b.subarray(0, b.length - cut)); } catch (e) { /* 다음 */ }
    }
    try { return cp949.decode(b); } catch (e) { /* 다음 */ }
    return fallback;
  }

  // split()으로 잘린 문자열은 원본 파일 전체를 메모리에 붙잡아 두므로 복사본으로 바꾼다.
  // 사파리·iOS(JSC)는 짧은 조각도 원본을 붙잡는다(도면 하나에 원문 수십 MB) → 길이와 상관없이 복사.
  // 같은 글자(레이어 이름 등)는 한 벌만 두어 메모리도 아낀다
  const INTERN = new Map();
  function own(s) {
    if (s.length === 0) return '';
    let v = INTERN.get(s);
    if (v === undefined) {
      v = JSON.parse(JSON.stringify(s));
      if (INTERN.size > 200000) INTERN.clear();
      INTERN.set(v, v);
    }
    return v;
  }

  const MBCS = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 4: 'euc-kr', 5: 'gbk' };
  function unescapeStr(s) {
    if (s.indexOf('\\') < 0) return own(s);
    s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/\\M\+([1-5])([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/g, (m, cp, a, b) => {
      try {
        return decoder(MBCS[cp]).decode(new Uint8Array([parseInt(a, 16), parseInt(b, 16)]));
      } catch (e) {
        return '?';
      }
    });
    return own(s);
  }

  function parse(u8) {
    const text = typeof u8 === 'string' ? u8 : decodeBytes(u8);
    const lines = text.split(/\r?\n/);
    const n = lines.length >> 1;
    const codes = new Int32Array(n);
    const vals = new Array(n);
    for (let i = 0; i < n; i++) {
      codes[i] = parseInt(lines[2 * i], 10);
      vals[i] = lines[2 * i + 1];
    }

    // ── 레코드 분할 (code 0 기준) ──
    function segment(a, b) {
      const recs = [];
      let i = a;
      while (i < b) {
        if (codes[i] === 0) {
          const t = vals[i].trim();
          let j = i + 1;
          while (j < b && codes[j] !== 0) j++;
          recs.push({ t, s: i + 1, e: j });
          i = j;
        } else i++;
      }
      return recs;
    }
    function g(r, code, def) {
      for (let i = r.s; i < r.e; i++) if (codes[i] === code) return vals[i];
      return def;
    }
    function gf(r, code, def) {
      const v = g(r, code, null);
      if (v === null) return def === undefined ? 0 : def;
      const f = parseFloat(v);
      return isFinite(f) ? f : def === undefined ? 0 : def;
    }
    function gs(r, code, def) {
      const v = g(r, code, null);
      return v === null ? def : unescapeStr(v);
    }

    function common(r, type) {
      const e = { type, layer: '0', color: 256, tc: null, lt: 'BYLAYER', lts: 1, ez: 1, ps: false, inv: false, lw: -1 };
      let seen8 = false, seen62 = false;
      for (let i = r.s; i < r.e; i++) {
        switch (codes[i]) {
          case 8: if (!seen8) { e.layer = unescapeStr(vals[i].trim()); seen8 = true; } break;
          case 62: if (!seen62) { e.color = parseInt(vals[i], 10); seen62 = true; } break;
          case 420: if (e.tc === null) e.tc = parseInt(vals[i], 10); break;
          case 6: e.lt = own(vals[i].trim()); break;
          case 48: e.lts = parseFloat(vals[i]) || 1; break;
          case 230: e.ez = parseFloat(vals[i]); break;
          case 67: e.ps = parseInt(vals[i], 10) === 1; break;
          case 60: e.inv = parseInt(vals[i], 10) === 1; break;
          case 370: e.lw = parseInt(vals[i], 10); break;
        }
      }
      return e;
    }

    // ── 엔티티별 파서 ──
    const P = {
      LINE(r) {
        const e = common(r, 'LINE');
        e.x1 = gf(r, 10); e.y1 = gf(r, 20); e.x2 = gf(r, 11); e.y2 = gf(r, 21);
        return e;
      },
      CIRCLE(r) {
        const e = common(r, 'CIRCLE');
        e.cx = gf(r, 10); e.cy = gf(r, 20); e.r = gf(r, 40);
        return e;
      },
      ARC(r) {
        const e = common(r, 'ARC');
        e.cx = gf(r, 10); e.cy = gf(r, 20); e.r = gf(r, 40); e.a1 = gf(r, 50); e.a2 = gf(r, 51, 360);
        return e;
      },
      ELLIPSE(r) {
        const e = common(r, 'ELLIPSE');
        e.cx = gf(r, 10); e.cy = gf(r, 20); e.mx = gf(r, 11); e.my = gf(r, 21);
        e.ratio = gf(r, 40, 1); e.t1 = gf(r, 41, 0); e.t2 = gf(r, 42, Math.PI * 2);
        return e;
      },
      LWPOLYLINE(r) {
        const e = common(r, 'LWPOLYLINE');
        const pts = [];
        e.closed = (gf(r, 70, 0) & 1) === 1;
        for (let i = r.s; i < r.e; i++) {
          const c = codes[i];
          if (c === 10) pts.push(parseFloat(vals[i]), 0, 0);
          else if (c === 20 && pts.length) pts[pts.length - 2] = parseFloat(vals[i]);
          else if (c === 42 && pts.length) pts[pts.length - 1] = parseFloat(vals[i]);
        }
        e.pts = pts;
        return e;
      },
      SPLINE(r) {
        const e = common(r, 'SPLINE');
        e.flags = gf(r, 70, 0); e.degree = gf(r, 71, 3);
        e.knots = []; e.ctrl = []; e.w = []; e.fit = [];
        for (let i = r.s; i < r.e; i++) {
          const c = codes[i], v = vals[i];
          if (c === 40) e.knots.push(parseFloat(v));
          else if (c === 10) e.ctrl.push(parseFloat(v), 0);
          else if (c === 20) e.ctrl[e.ctrl.length - 1] = parseFloat(v);
          else if (c === 41) e.w.push(parseFloat(v));
          else if (c === 11) e.fit.push(parseFloat(v), 0);
          else if (c === 21) e.fit[e.fit.length - 1] = parseFloat(v);
        }
        return e;
      },
      TEXT(r, type) {
        const e = common(r, type || 'TEXT');
        const isAtt = type === 'ATTRIB';
        e.x = gf(r, 10); e.y = gf(r, 20);
        const ax = g(r, 11, null);
        e.ax = ax === null ? null : parseFloat(ax); e.ay = gf(r, 21);
        e.h = gf(r, 40, 1); e.text = gs(r, 1, ''); e.rot = gf(r, 50, 0);
        e.wf = gf(r, 41, 1) || 1; e.obl = gf(r, 51, 0); e.gen = gf(r, 71, 0);
        e.hj = gf(r, 72, 0); e.vj = gf(r, isAtt ? 74 : 73, 0);
        e.style = own((g(r, 7, 'STANDARD') || '').trim());
        if (isAtt && (gf(r, 70, 0) & 1)) e.inv = true;
        return e;
      },
      MTEXT(r) {
        const e = common(r, 'MTEXT');
        e.x = gf(r, 10); e.y = gf(r, 20); e.h = gf(r, 40, 1); e.w = gf(r, 41, 0);
        e.attach = gf(r, 71, 1); e.lsf = gf(r, 44, 1) || 1;
        const dx = g(r, 11, null);
        e.rot = dx !== null ? (Math.atan2(gf(r, 21), parseFloat(dx)) * 180) / Math.PI : gf(r, 50, 0);
        let s = '';
        for (let i = r.s; i < r.e; i++) if (codes[i] === 3) s += vals[i];
        s += g(r, 1, '');
        e.text = unescapeStr(s);
        return e;
      },
      INSERT(r) {
        const e = common(r, 'INSERT');
        e.name = unescapeStr((g(r, 2, '') || '').trim());
        e.x = gf(r, 10); e.y = gf(r, 20);
        e.sx = gf(r, 41, 1) || 1; e.sy = gf(r, 42, 1) || 1; e.rot = gf(r, 50, 0);
        e.cols = Math.max(1, gf(r, 70, 1)); e.rows = Math.max(1, gf(r, 71, 1));
        e.cs = gf(r, 44, 0); e.rs = gf(r, 45, 0);
        e.attribs = [];
        e.handle = own((g(r, 5, '') || '').trim());
        return e;
      },
      DIMENSION(r) {
        const e = common(r, 'DIMENSION');
        e.block = unescapeStr((g(r, 2, '') || '').trim());
        return e;
      },
      LEADER(r) {
        const e = common(r, 'LEADER');
        e.pts = [];
        for (let i = r.s; i < r.e; i++) {
          if (codes[i] === 10) e.pts.push(parseFloat(vals[i]), 0);
          else if (codes[i] === 20 && e.pts.length) e.pts[e.pts.length - 1] = parseFloat(vals[i]);
        }
        e.arrow = gf(r, 71, 1) === 1;
        return e;
      },
      SOLID(r, type) {
        const e = common(r, type || 'SOLID');
        e.p = [gf(r, 10), gf(r, 20), gf(r, 11), gf(r, 21), gf(r, 12), gf(r, 22), gf(r, 13, gf(r, 12)), gf(r, 23, gf(r, 22))];
        return e;
      },
      HATCH(r) {
        return parseHatch(r);
      },
    };
    P.ATTRIB = (r) => P.TEXT(r, 'ATTRIB');
    P.TRACE = (r) => P.SOLID(r, 'SOLID');
    P['3DFACE'] = (r) => P.SOLID(r, '3DFACE');
    P.ACAD_TABLE = (r) => {
      const e = common(r, 'DIMENSION');
      e.block = unescapeStr((g(r, 2, '') || '').trim());
      return e;
    };

    function parseHatch(r) {
      const e = common(r, 'HATCH');
      e.solid = false; e.pattern = ''; e.loops = []; e.plines = [];
      let j = r.s;
      const end = r.e;
      while (j < end && codes[j] !== 91) {
        if (codes[j] === 70) e.solid = parseInt(vals[j], 10) === 1;
        else if (codes[j] === 2) e.pattern = vals[j].trim();
        j++;
      }
      if (j >= end) return e;
      const nloops = parseInt(vals[j], 10); j++;
      const num = () => parseFloat(vals[j++]);
      const take = (c, def) => (j < end && codes[j] === c ? num() : def);
      for (let L = 0; L < nloops; L++) {
        while (j < end && codes[j] !== 92) j++;
        if (j >= end) break;
        const flags = parseInt(vals[j], 10); j++;
        const loop = { flags, poly: null, edges: null };
        if (flags & 2) {
          let nv = 0;
          while (j < end && codes[j] !== 10) { if (codes[j] === 93) nv = parseInt(vals[j], 10); j++; }
          const pts = [];
          for (let v = 0; v < nv && j < end; v++) {
            const x = take(10, 0), y = take(20, 0), b = take(42, 0);
            pts.push(x, y, b);
          }
          loop.poly = pts;
        } else {
          while (j < end && codes[j] !== 93) j++;
          const ne = parseInt(vals[j], 10); j++;
          loop.edges = [];
          for (let k = 0; k < ne; k++) {
            while (j < end && codes[j] !== 72) j++;
            if (j >= end) break;
            const et = parseInt(vals[j], 10); j++;
            if (et === 1) {
              loop.edges.push({ t: 1, x1: take(10, 0), y1: take(20, 0), x2: take(11, 0), y2: take(21, 0) });
            } else if (et === 2) {
              loop.edges.push({ t: 2, cx: take(10, 0), cy: take(20, 0), r: take(40, 0), a1: take(50, 0), a2: take(51, 360), ccw: take(73, 1) });
            } else if (et === 3) {
              loop.edges.push({ t: 3, cx: take(10, 0), cy: take(20, 0), mx: take(11, 0), my: take(21, 0), ratio: take(40, 1), a1: take(50, 0), a2: take(51, 360), ccw: take(73, 1) });
            } else if (et === 4) {
              const ed = { t: 4, degree: take(94, 3), knots: [], ctrl: [], w: [], fit: [] };
              take(73); take(74);
              const nk = take(95, 0), nc = take(96, 0);
              for (let q = 0; q < nk; q++) ed.knots.push(take(40, 0));
              for (let q = 0; q < nc; q++) {
                ed.ctrl.push(take(10, 0), take(20, 0));
                if (j < end && codes[j] === 42) ed.w.push(num());
              }
              if (j < end && codes[j] === 97) {
                const nf = num();
                for (let q = 0; q < nf; q++) ed.fit.push(take(11, 0), take(21, 0));
              }
              loop.edges.push(ed);
            }
          }
        }
        e.loops.push(loop);
      }
      // 패턴 정의 (DXF에는 이미 각도·축척이 적용된 값이 저장됨)
      while (j < end && codes[j] !== 78) j++;
      if (j < end) {
        const nl = parseInt(vals[j], 10); j++;
        for (let k = 0; k < nl; k++) {
          while (j < end && codes[j] !== 53) j++;
          if (j >= end) break;
          const pl = { ang: num(), bx: take(43, 0), by: take(44, 0), ox: take(45, 0), oy: take(46, 0), dash: [] };
          const nd = take(79, 0);
          for (let q = 0; q < nd; q++) pl.dash.push(take(49, 0));
          e.plines.push(pl);
        }
      }
      return e;
    }

    function parseRecs(recs) {
      const out = [];
      for (let k = 0; k < recs.length; k++) {
        const r = recs[k];
        if (r.t === 'POLYLINE') {
          const verts = [];
          k++;
          while (k < recs.length && recs[k].t === 'VERTEX') verts.push(recs[k++]);
          if (k < recs.length && recs[k].t !== 'SEQEND') k--;
          const e = common(r, 'LWPOLYLINE');
          const flags = gf(r, 70, 0);
          if (flags & (16 | 64)) continue; // 메쉬/폴리페이스는 생략
          e.closed = (flags & 1) === 1;
          if (flags & 8) e.ez = 1; // 3D 폴리선은 WCS
          e.pts = [];
          for (const v of verts) {
            if (gf(v, 70, 0) & 16) continue; // 스플라인 프레임 제어점
            e.pts.push(gf(v, 10), gf(v, 20), gf(v, 42, 0));
          }
          out.push(e);
          continue;
        }
        if (r.t === 'INSERT') {
          const e = P.INSERT(r);
          while (k + 1 < recs.length && recs[k + 1].t === 'ATTRIB') e.attribs.push(P.TEXT(recs[++k], 'ATTRIB'));
          if (k + 1 < recs.length && recs[k + 1].t === 'SEQEND') k++;
          out.push(e);
          continue;
        }
        const fn = P[r.t];
        if (fn) {
          try {
            const e = fn(r);
            if (e && !e.inv) out.push(e);
          } catch (err) {
            /* 손상된 엔티티는 건너뜀 */
          }
        }
      }
      return out;
    }

    const doc = { header: {}, layers: {}, ltypes: {}, blocks: {}, entities: [] };

    function parseHeader(a, b) {
      let cur = null;
      for (let i = a; i < b; i++) {
        if (codes[i] === 9) { cur = own(vals[i].trim()); doc.header[cur] = {}; }
        else if (cur) doc.header[cur][codes[i]] = own(vals[i]);
      }
    }
    function parseTables(a, b) {
      for (const r of segment(a, b)) {
        if (r.t === 'LAYER') {
          const name = unescapeStr((g(r, 2, '') || '').trim());
          const color = gf(r, 62, 7);
          doc.layers[name.toUpperCase()] = {
            name,
            color: Math.abs(color) || 7,
            tc: g(r, 420, null) === null ? null : gf(r, 420),
            on: color >= 0,
            frozen: (gf(r, 70, 0) & 1) === 1,
            lt: own((g(r, 6, 'CONTINUOUS') || '').trim()),
            lw: parseInt(g(r, 370, '-3'), 10),
          };
        } else if (r.t === 'LTYPE') {
          const name = (g(r, 2, '') || '').trim().toUpperCase();
          const dash = [];
          for (let i = r.s; i < r.e; i++) if (codes[i] === 49) dash.push(parseFloat(vals[i]));
          doc.ltypes[name] = dash;
        }
      }
    }
    function parseBlocks(a, b) {
      const recs = segment(a, b);
      for (let k = 0; k < recs.length; k++) {
        if (recs[k].t !== 'BLOCK') continue;
        const r = recs[k];
        const name = unescapeStr((g(r, 2, null) || g(r, 3, '') || '').trim());
        const blk = {
          name,
          flags: gf(r, 70, 0),
          bx: gf(r, 10), by: gf(r, 20),
          xref: gs(r, 1, ''),
          layer: own((g(r, 8, '0') || '0').trim()),
        };
        const sub = [];
        k++;
        while (k < recs.length && recs[k].t !== 'ENDBLK') sub.push(recs[k++]);
        blk.entities = parseRecs(sub);
        doc.blocks[name.toUpperCase()] = blk;
      }
    }

    // XCLIP: SPATIAL_FILTER → (사전) → 확장사전 → INSERT 핸들
    doc.clips = {};
    function parseObjects(a, b) {
      const owner = {};
      const filters = [];
      for (const r of segment(a, b)) {
        if (r.t !== 'DICTIONARY' && r.t !== 'SPATIAL_FILTER') continue;
        let h = null, own = null, inGrp = false;
        for (let i = r.s; i < r.e; i++) {
          const c = codes[i];
          if (c === 5 && h === null) h = vals[i].trim();
          else if (c === 102) inGrp = vals[i].trim().startsWith('{');
          else if (c === 330 && !inGrp && own === null) own = vals[i].trim();
        }
        if (h) owner[h] = own;
        if (r.t === 'SPATIAL_FILTER') {
          const pts = [], m = [];
          let enabled = 1;
          for (let i = r.s; i < r.e; i++) {
            const c = codes[i];
            if (c === 10) pts.push(parseFloat(vals[i]), 0);
            else if (c === 20) pts[pts.length - 1] = parseFloat(vals[i]);
            else if (c === 71) enabled = parseInt(vals[i], 10);
            else if (c === 40) m.push(parseFloat(vals[i]));
          }
          filters.push({ own, pts, m, enabled });
        }
      }
      for (const f of filters) {
        if (!f.enabled || f.pts.length < 4) continue;
        const ins = owner[owner[f.own]];
        if (!ins) continue;
        let pts = f.pts;
        if (pts.length === 4) pts = [pts[0], pts[1], pts[2], pts[1], pts[2], pts[3], pts[0], pts[3]];
        // 경계점(삽입 당시 WCS) → 블록 좌표: 역변환 행렬(3x4, 행 우선) 적용
        const m = f.m.length >= 12 ? f.m : [1, 0, 0, 0, 0, 1, 0, 0];
        const local = [];
        for (let i = 0; i < pts.length; i += 2) local.push(m[0] * pts[i] + m[1] * pts[i + 1] + m[3], m[4] * pts[i] + m[5] * pts[i + 1] + m[7]);
        doc.clips[ins] = local;
      }
    }

    let i = 0;
    while (i < n) {
      if (codes[i] === 0 && vals[i].trim() === 'SECTION') {
        const name = (vals[i + 1] || '').trim();
        let j = i + 2;
        while (j < n && !(codes[j] === 0 && vals[j].trim() === 'ENDSEC')) j++;
        if (name === 'HEADER') parseHeader(i + 2, j);
        else if (name === 'TABLES') parseTables(i + 2, j);
        else if (name === 'BLOCKS') parseBlocks(i + 2, j);
        else if (name === 'ENTITIES') doc.entities = parseRecs(segment(i + 2, j));
        else if (name === 'OBJECTS') parseObjects(i + 2, j);
        i = j + 1;
      } else i++;
    }

    const hv = (name, code, def) => {
      const h = doc.header[name];
      if (!h || h[code] === undefined) return def;
      const f = parseFloat(h[code]);
      return isFinite(f) ? f : def;
    };
    doc.ltscale = hv('$LTSCALE', 40, 1) || 1;
    doc.insunits = hv('$INSUNITS', 70, 0);
    doc.insbase = [hv('$INSBASE', 10, 0), hv('$INSBASE', 20, 0)];
    doc.extmin = [hv('$EXTMIN', 10, 0), hv('$EXTMIN', 20, 0)];
    doc.extmax = [hv('$EXTMAX', 10, 0), hv('$EXTMAX', 20, 0)];
    doc.stylesheet = doc.header.$STYLESHEET && doc.header.$STYLESHEET[1] ? own(doc.header.$STYLESHEET[1].trim()) : '';
    doc.lwdefault = hv('$LWDEFAULT', 370, 25);
    doc.dimasz = hv('$DIMASZ', 40, 2.5) * (hv('$DIMSCALE', 40, 1) || 1);
    return doc;
  }

  global.DXF = { parse, unescapeStr };
})(window);
