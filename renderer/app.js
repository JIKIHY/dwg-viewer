// 화면 동작: 파일 열기, XREF, 레이어, 측정/스냅, 검색
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const view = new View($('#gl'), $('#text'));
  let drag = null;
  let spaceDown = false;
  const ui = $('#ui');
  const uctx = ui.getContext('2d');

  const S = {
    mainPath: null,
    mainDoc: null,
    docs: new Map(), // 경로 → 파싱된 도면
    docLoads: new Map(),
    xrefs: [],
    overrides: {},
    attached: [],
    scene: null,
    tool: 'pan',
    measures: [],
    cur: [], // 진행 중인 측정 점들
    mouse: null, // 현재 커서(스냅 반영) 월드 좌표
    snap: null,
    index: null,
    layerVis: new Map(),
    groupVis: new Map(),
    flash: null,
    pickCallback: null,
  };

  const UNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
  const fmt = (v, d = 2) => v.toLocaleString('ko-KR', { maximumFractionDigits: d });

  // ───────────────────────── 로딩/알림 ─────────────────────────
  function setLoading(on, msg) {
    $('#loading').hidden = !on;
    if (msg) $('#loading-msg').textContent = msg;
  }
  let hintTimer = null;
  function hint(msg, ms) {
    const h = $('#hint');
    if (!msg) { h.style.display = 'none'; return; }
    h.textContent = msg;
    h.style.display = 'block';
    clearTimeout(hintTimer);
    if (ms) hintTimer = setTimeout(() => updateHint(), ms);
  }
  function updateHint() {
    const t = S.tool;
    if (t === 'dist') hint(S.cur.length ? '두 번째 점을 클릭하세요 (Shift: 수평/수직, Esc: 취소)' : '거리 측정: 첫 번째 점을 클릭하세요');
    else if (t === 'area') hint(S.cur.length ? `점 ${S.cur.length}개 — 계속 클릭, 더블클릭/Enter/우클릭으로 완료` : '면적 측정: 꼭짓점을 차례로 클릭하세요');
    else if (t === 'zoomwin') hint('확대할 영역을 드래그하세요');
    else if (t === 'pickpt') hint('XREF 삽입점을 클릭하세요');
    else if (t === 'printwin') hint(S.cur.length ? '인쇄 윈도우: 반대쪽 구석점을 클릭하세요 (Esc: 취소)' : '인쇄 윈도우: 첫 번째 구석점을 클릭하세요 (끝점 스냅 사용 가능)');
    else hint(null);
  }
  const tick = () => new Promise((r) => setTimeout(r, 16));

  // ───────────────────────── 파일 열기 ─────────────────────────
  function loadDoc(p) {
    if (S.docs.has(p)) return Promise.resolve(S.docs.get(p));
    if (!S.docLoads.has(p)) {
      S.docLoads.set(p, (async () => {
        const r = await window.api.loadDrawing(p, false);
        if (!r.ok) throw new Error(r.error);
        const d = DXF.parse(r.data);
        S.docs.set(p, d);
        return d;
      })());
    }
    return S.docLoads.get(p);
  }

  async function loadXrefs(doc, hostPath, depth, chain, visited) {
    doc.xrefPaths = {};
    const blks = Object.values(doc.blocks).filter((b) => b.flags & 4);
    await Promise.all(blks.map(async (b) => {
      const key = b.name.toUpperCase();
      const overlay = (b.flags & 8) !== 0;
      if (depth > 0 && overlay) return;
      const entry = { name: b.name, ref: b.xref, host: hostPath, depth, overlay, resolved: null, status: 'miss', key: hostPath + '|' + key };
      S.xrefs.push(entry);
      const res = S.overrides[entry.key] || (await window.api.resolveXref(hostPath, b.xref));
      if (!res) return;
      if (chain.includes(res)) { entry.status = 'cycle'; return; }
      try {
        $('#loading-msg').textContent = `XREF 불러오는 중: ${b.name}`;
        const xd = await loadDoc(res);
        doc.xrefPaths[key] = res;
        entry.resolved = res;
        entry.status = 'ok';
        if (!visited.has(res)) {
          visited.add(res);
          await loadXrefs(xd, res, depth + 1, chain.concat(res), visited);
        }
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
      }
    }));
  }

  async function reloadXrefs() {
    S.xrefs = [];
    await loadXrefs(S.mainDoc, S.mainPath, 0, [S.mainPath], new Set());
    for (const a of S.attached) {
      const xd = S.docs.get(a.path);
      if (xd) await loadXrefs(xd, a.path, 1, [a.path], new Set());
    }
  }

  async function openPath(p) {
    setLoading(true, '도면 변환 중…');
    await tick();
    try {
      const r = await window.api.loadDrawing(p, true);
      if (!r.ok) throw new Error(r.error);
      $('#loading-msg').textContent = '도면 해석 중…';
      await tick();
      const doc = DXF.parse(r.data);
      Object.assign(S, {
        mainPath: p, mainDoc: doc, docs: new Map([[p, doc]]), docLoads: new Map(), xrefs: [], overrides: {}, attached: [],
        measures: [], cur: [], layerVis: new Map(), groupVis: new Map(),
      });
      printWin = null;
      await reloadXrefs();
      await rebuild(false);
      $('#docname').textContent = p;
      document.title = r.name; // macOS 탭 이름
      $('#empty').hidden = true;
      const miss = S.xrefs.filter((x) => x.status !== 'ok').length;
      if (miss) hint(`XREF ${miss}개를 찾지 못했습니다. 오른쪽 XREF 탭에서 파일을 지정할 수 있습니다.`, 6000);
    } catch (err) {
      setLoading(false);
      hint('열기 실패: ' + err.message, 8000);
      console.error(err);
    }
    setLoading(false);
  }

  async function rebuild(keepView) {
    setLoading(true, '화면 구성 중…');
    await tick();
    const t0 = performance.now();
    const scene = Scene.build({ mainDoc: S.mainDoc, docs: S.docs, attached: S.attached });
    S.scene = scene;
    S.index = null;
    view.layerVis = scene.layers.map((l) => (S.layerVis.has(l.key) ? S.layerVis.get(l.key) : l.visible));
    view.groupVis = scene.groups.map((g) => S.groupVis.get(g.key) !== false);
    view.setScene(scene, keepView);
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    const st = scene.stats;
    $('#info').textContent = `선 ${fmt(st.segments, 0)} · 채움 ${fmt(st.triangles, 0)} · 문자 ${fmt(st.texts, 0)} · ${sec}초${scene.space === 'paper' ? ' · 배치공간' : ''}`;
    $('#units').textContent = UNITS[scene.units] ? `단위: ${UNITS[scene.units]}` : '단위: 없음';
    renderLayers();
    renderXrefs();
    renderMeasures();
    setLoading(false);
  }

  // ───────────────────────── 레이어 패널 ─────────────────────────
  function renderLayers() {
    const ul = $('#layer-list');
    const s = S.scene;
    if (!s) { ul.innerHTML = '<li class="empty">도면을 열어주세요</li>'; return; }
    const q = $('#layer-filter').value.trim().toUpperCase();
    const items = s.layers.filter((l) => !q || l.key.includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const l of items) {
      const li = document.createElement('li');
      li.dataset.id = l.id;
      const on = view.layerVis[l.id] !== false;
      li.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}/><span class="swatch" style="background:#${l.rgb.toString(16).padStart(6, '0')}"></span><span class="lname ${on ? '' : 'off'}"></span><span class="cnt">${fmt(l.count, 0)}</span>`;
      li.querySelector('.lname').textContent = l.name;
      li.querySelector('.lname').title = l.name;
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    if (!items.length) ul.innerHTML = '<li class="empty">레이어 없음</li>';
  }
  function setLayer(id, on) {
    view.layerVis[id] = on;
    S.layerVis.set(S.scene.layers[id].key, on);
  }
  $('#layer-list').addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (!li) return;
    const id = +li.dataset.id;
    const on = view.layerVis[id] === false;
    setLayer(id, on);
    li.querySelector('input').checked = on;
    li.querySelector('.lname').classList.toggle('off', !on);
    view.request();
  });
  $('#layer-filter').addEventListener('input', renderLayers);
  function bulkLayers(fn) {
    if (!S.scene) return;
    const q = $('#layer-filter').value.trim().toUpperCase();
    for (const l of S.scene.layers) if (!q || l.key.includes(q)) setLayer(l.id, fn(view.layerVis[l.id] !== false));
    renderLayers();
    view.request();
  }
  $('#layers-all-on').onclick = () => bulkLayers(() => true);
  $('#layers-all-off').onclick = () => bulkLayers(() => false);
  $('#layers-invert').onclick = () => bulkLayers((v) => !v);

  // ───────────────────────── XREF 패널 ─────────────────────────
  const baseName = (p) => p.split('/').pop();
  function renderXrefs() {
    const ul = $('#xref-list');
    ul.innerHTML = '';
    const s = S.scene;
    if (!s) return;
    const rows = S.xrefs;
    if (!rows.length && !S.attached.length) { ul.innerHTML = '<li class="empty">이 도면에는 XREF가 없습니다</li>'; return; }
    const groupOf = (key) => s.groups.findIndex((g) => g.key === key);
    const mk = (html) => { const li = document.createElement('li'); li.className = 'xr'; li.innerHTML = html; ul.appendChild(li); return li; };
    const STATUS = { ok: ['ok', '연결됨'], miss: ['miss', '못 찾음'], cycle: ['miss', '순환 참조'], error: ['miss', '변환 오류'] };
    for (const x of rows) {
      const [cls, label] = STATUS[x.status];
      const top = x.depth === 0 && x.host === S.mainPath;
      const gi = top ? groupOf(x.name.toUpperCase()) : -1;
      const li = mk(`<div class="top">${top && gi >= 0 ? `<input type="checkbox" ${view.groupVis[gi] !== false ? 'checked' : ''}/>` : ''}<span class="lname" style="padding-left:${x.depth * 12}px"></span><span class="badge ${cls}">${label}</span><button class="pick">파일 지정</button></div><div class="path"></div>`);
      li.querySelector('.lname').textContent = (x.depth ? '└ ' : '') + x.name + (x.overlay ? ' (오버레이)' : '');
      li.querySelector('.path').textContent = x.resolved || `원래 경로: ${x.ref}${x.error ? ' — ' + x.error : ''}`;
      const cb = li.querySelector('input');
      if (cb) cb.onchange = () => { view.groupVis[gi] = cb.checked; S.groupVis.set(s.groups[gi].key, cb.checked); view.request(); };
      li.querySelector('.pick').onclick = async () => {
        const p = await window.api.pickDrawing(`${x.name} 파일 선택`);
        if (!p) return;
        S.overrides[x.key] = p;
        setLoading(true, 'XREF 다시 불러오는 중…');
        await reloadXrefs();
        await rebuild(true);
      };
    }
    for (const a of S.attached) {
      const gi = groupOf('@' + a.name.toUpperCase());
      const li = mk(`<div class="top"><input type="checkbox" ${view.groupVis[gi] !== false ? 'checked' : ''}/><span class="lname"></span><span class="badge man">직접 부착</span><button class="det">분리</button></div><div class="path"></div>`);
      li.querySelector('.lname').textContent = a.name;
      li.querySelector('.path').textContent = `${a.path}  ·  삽입점 (${fmt(a.x)}, ${fmt(a.y)}) · 축척 ${a.scale} · 회전 ${a.rot}°`;
      const cb = li.querySelector('input');
      cb.onchange = () => { view.groupVis[gi] = cb.checked; S.groupVis.set(s.groups[gi].key, cb.checked); view.request(); };
      li.querySelector('.det').onclick = async () => {
        S.attached = S.attached.filter((v) => v !== a);
        await reloadXrefs();
        await rebuild(true);
      };
    }
  }

  // 수동 XREF 부착
  let attachFile = null;
  async function startAttach() {
    if (!S.mainDoc) { hint('먼저 기준 도면을 여세요', 3000); return; }
    const p = await window.api.pickDrawing('겹쳐 붙일 도면 선택');
    if (!p) return;
    attachFile = p;
    $('#modal-file').textContent = p;
    $('#modal').hidden = false;
  }
  $('#xa-cancel').onclick = () => { $('#modal').hidden = true; attachFile = null; };
  $('#xa-pick').onclick = () => {
    $('#modal').hidden = true;
    const prev = S.tool;
    setTool('pickpt');
    S.pickCallback = (pt) => {
      $('#xa-x').value = +pt[0].toFixed(3);
      $('#xa-y').value = +pt[1].toFixed(3);
      setTool(prev === 'pickpt' ? 'pan' : prev);
      $('#modal').hidden = false;
    };
  };
  $('#xa-ok').onclick = async () => {
    $('#modal').hidden = true;
    const p = attachFile;
    if (!p) return;
    setLoading(true, '도면 불러오는 중…');
    try {
      await loadDoc(p);
      let name = baseName(p).replace(/\.(dwg|dxf)$/i, '');
      const used = new Set(S.attached.map((a) => a.name.toUpperCase()));
      let k = 2, n = name;
      while (used.has(n.toUpperCase())) n = `${name} (${k++})`;
      S.attached.push({ name: n, path: p, x: +$('#xa-x').value || 0, y: +$('#xa-y').value || 0, scale: +$('#xa-s').value || 1, rot: +$('#xa-r').value || 0 });
      await reloadXrefs();
      await rebuild(true);
      switchTab('xrefs');
    } catch (err) {
      setLoading(false);
      hint('부착 실패: ' + err.message, 6000);
    }
  };

  // ───────────────────────── 인쇄 (플롯) ─────────────────────────
  const PAPER = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841] };
  const PRINT_DPI = { A4: 300, A3: 300, A2: 250, A1: 200 };
  const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
  const MARGIN = 5; // mm
  let printWin = null; // 윈도우 범위 [x0,y0,x1,y1]

  function printRange() {
    const r = $('#p-range').value;
    if (r === 'window') return printWin;
    if (r === 'view') {
      const [x0, y1] = view.toWorld(0, 0), [x1, y0] = view.toWorld(view.w, view.h);
      return [x0, y0, x1, y1];
    }
    return S.scene.extents;
  }
  function printLayout() {
    const rg = printRange();
    if (!rg) return null;
    const paper = $('#p-paper').value;
    const [pw, ph] = PAPER[paper];
    const rw = Math.max(rg[2] - rg[0], 1e-9), rh = Math.max(rg[3] - rg[1], 1e-9);
    const o = $('#p-orient').value;
    const land = o === 'auto' ? rw >= rh : o === 'landscape';
    const W = land ? ph : pw, H = land ? pw : ph;
    const iw = W - 2 * MARGIN, ih = H - 2 * MARGIN;
    const umm = UNIT_MM[S.scene.units] || 1;
    let mmPerUnit;
    if ($('#p-scale').value === 'custom') mmPerUnit = umm / Math.max(+$('#p-n').value || 1, 1e-9);
    else mmPerUnit = Math.min(iw / rw, ih / rh);
    return { rg, paper, land, W, H, iw, ih, mmPerUnit, ratio: umm / mmPerUnit };
  }
  // ── CTB 플롯 스타일 ──
  const ctbCache = new Map();
  let ctbState = { files: [], last: null, byName: {} };
  async function getCtb(choice) {
    if (Plot.BUILTIN[choice]) return Plot.BUILTIN[choice];
    if (!ctbCache.has(choice)) ctbCache.set(choice, Plot.parseCtb(await window.api.ctbRead(choice), choice));
    return ctbCache.get(choice);
  }
  const sheetName = () => (S.scene && S.scene.stylesheet) || '';
  async function refreshCtbList(select) {
    ctbState = await window.api.ctbList();
    const sel = $('#p-ctb');
    sel.innerHTML = '';
    const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); };
    add('@mono', 'monochrome.ctb (흑백, 내장)');
    add('@gray', 'grayscale.ctb (회색조, 내장)');
    add('@none', '화면 색상 그대로 (CTB 없음)');
    for (const f of ctbState.files) add(f, f);
    // 선택 우선순위: 지정값 → 도면이 지정한 CTB와 같은 이름 → 이 CTB 이름에 전에 고른 것 → 마지막 사용 → 흑백
    const sn = sheetName();
    const valid = (v) => v && [...sel.options].some((o) => o.value === v);
    const byFile = sn && ctbState.files.find((f) => f.toUpperCase() === sn.toUpperCase());
    const byMap = sn && ctbState.byName && ctbState.byName[sn.toUpperCase()];
    sel.value = [select, byFile, byMap, ctbState.last, '@mono'].find(valid);
    updateCtbInfo();
  }
  function updateCtbInfo() {
    const sn = sheetName();
    const has = sn && ctbState.files.some((f) => f.toUpperCase() === sn.toUpperCase());
    $('#p-ctbinfo').textContent = !sn ? '' : has ? `도면 지정 CTB: ${sn} ✓ 등록됨` : `도면 지정 CTB: ${sn} (등록 안 됨 — '파일 선택…'으로 불러오면 다음부터 자동 선택)`;
  }
  $('#p-ctb').addEventListener('change', () => {
    window.api.ctbRemember($('#p-ctb').value, sheetName());
    updatePrintPreview();
  });
  $('#p-ctb-add').onclick = async () => {
    const names = await window.api.ctbImport();
    if (!names.length) return;
    names.forEach((n) => ctbCache.delete(n));
    const sn = sheetName().toUpperCase();
    const pick = names.find((n) => n.toUpperCase() === sn) || names[0];
    await refreshCtbList(pick);
    window.api.ctbRemember(pick, sheetName());
    hint(`CTB ${names.length}개 등록됨: ${names.join(', ')}`, 4000);
    updatePrintPreview();
  };

  // 인쇄할 거리 치수 (측정 패널의 거리 측정들)
  function printDims() {
    if (!$('#p-dims').checked) return [];
    return S.measures.filter((m) => m.type === 'dist').map((m) => ({ pts: m.pts, off: m.off || 0, label: measureInfo(m).label }));
  }
  // 벡터 용지(SVG) 만들기. 선이 너무 많으면 고해상도 이미지로 대체
  const VECTOR_LIMIT = 1500000;
  async function buildPlot(L) {
    const ctb = await getCtb($('#p-ctb').value);
    const styler = Plot.makeStyler(ctb, $('#p-lw').checked, (S.mainDoc.lwdefault > 0 ? S.mainDoc.lwdefault : 25) / 100);
    const r = Plot.buildSvg(S.scene, L, { styler, vis: (l, g) => view.isVisible(l, g), margin: MARGIN, dims: printDims() });
    return { ...r, raster: r.segCount > VECTOR_LIMIT };
  }
  // 이미지 방식(대용량 대비)
  function renderPage(L, dpi) {
    const k = dpi / 25.4;
    const pw = Math.round(L.W * k), ph = Math.round(L.H * k);
    const iw = Math.round(L.iw * k), ih = Math.round(L.ih * k), m = Math.round(MARGIN * k);
    const gc = document.createElement('canvas'), tc = document.createElement('canvas');
    const v = new View(gc, tc);
    v.request = () => {};
    v.light = true;
    v.mono = $('#p-ctb').value === '@mono';
    v.thick = dpi >= 150;
    v.layerVis = view.layerVis;
    v.groupVis = view.groupVis;
    v.resize(iw, ih, 1);
    v.setScene(S.scene, true);
    v.cx = (L.rg[0] + L.rg[2]) / 2;
    v.cy = (L.rg[1] + L.rg[3]) / 2;
    v.scale = L.mmPerUnit * k;
    v.render();
    const out = document.createElement('canvas');
    out.width = pw; out.height = ph;
    const c = out.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, pw, ph);
    c.drawImage(gc, m, m);
    c.drawImage(tc, m, m);
    const dims = printDims();
    if (dims.length) {
      const cx = v.cx, cy = v.cy, px0 = MARGIN + L.iw / 2, py0 = MARGIN + L.ih / 2, km = L.mmPerUnit;
      c.save();
      c.beginPath(); c.rect(m, m, iw, ih); c.clip();
      Plot.drawDims(c, Plot.dimPrims(dims, (p) => [px0 + (p[0] - cx) * km, py0 - (p[1] - cy) * km]), k);
      c.restore();
    }
    const lose = v.gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return out;
  }
  let prevTimer = null, prevSeq = 0;
  function updatePrintPreview() {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(async () => {
      const seq = ++prevSeq;
      $('#p-nrow').hidden = $('#p-scale').value !== 'custom';
      $('#p-pickwin').style.display = $('#p-range').value === 'window' ? '' : 'none';
      $('#p-wininfo').textContent = $('#p-range').value !== 'window' ? '' : printWin
        ? `지정됨: ${fmt(printWin[2] - printWin[0], 0)} × ${fmt(printWin[3] - printWin[1], 0)} ${unitLabel()}`
        : '⚠️ 윈도우를 지정하세요 (두 구석점 클릭)';
      const L = printLayout();
      const pc = $('#p-prev');
      $('#p-pdf').disabled = !L; $('#p-print').disabled = !L;
      if (!L) {
        pc.width = 300; pc.height = 212; pc.style.width = '300px'; pc.style.height = '212px';
        pc.getContext('2d').clearRect(0, 0, 300, 212);
        $('#p-scaleinfo').textContent = '';
        return;
      }
      const sc = Math.min(440 / L.W, 330 / L.H); // px/mm
      const cw = Math.round(L.W * sc), ch = Math.round(L.H * sc), dpr = 2;
      let note = '';
      try {
        const plot = await buildPlot(L);
        if (seq !== prevSeq) return;
        let img;
        if (plot.raster) {
          img = renderPage(L, sc * 25.4 * dpr);
          note = ' · 대용량이라 이미지 방식';
        } else {
          const url = URL.createObjectURL(new Blob([plot.svg], { type: 'image/svg+xml' }));
          img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
          URL.revokeObjectURL(url);
          note = ' · 벡터';
        }
        if (seq !== prevSeq) return;
        pc.width = cw * dpr; pc.height = ch * dpr;
        pc.style.width = cw + 'px'; pc.style.height = ch + 'px';
        const c = pc.getContext('2d');
        c.fillStyle = '#fff'; c.fillRect(0, 0, pc.width, pc.height);
        c.drawImage(img, 0, 0, pc.width, pc.height);
      } catch (err) {
        note = ' · 미리보기 오류: ' + err.message;
      }
      $('#p-scaleinfo').textContent = `${L.paper} ${L.land ? '가로' : '세로'} · 축척 약 1:${fmt(L.ratio, L.ratio < 10 ? 2 : 0)} · 여백 ${MARGIN}mm${note}`;
    }, 120);
  }
  async function openPrint() {
    if (!S.scene) { hint('먼저 도면을 여세요', 3000); return; }
    $('#pmodal').hidden = false;
    await refreshCtbList($('#p-ctb').value || null);
    updatePrintPreview();
  }
  function pickPrintWindow() {
    $('#pmodal').hidden = true;
    setTool('printwin');
    S.pickCallback = (a, b) => {
      printWin = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      $('#p-range').value = 'window';
      setTool('pan');
      openPrint();
    };
  }
  async function doPrint(mode) {
    const L = printLayout();
    if (!L) return;
    $('#pmodal').hidden = true;
    setLoading(true, mode === 'pdf' ? 'PDF 만드는 중…' : '인쇄 준비 중…');
    await tick();
    try {
      window.api.ctbRemember($('#p-ctb').value, sheetName());
      const plot = await buildPlot(L);
      const name = baseName(S.mainPath).replace(/\.(dwg|dxf)$/i, '');
      const opt = { paper: L.paper, landscape: L.land, mode, name, wmm: L.W, hmm: L.H };
      const r = plot.raster
        ? await window.api.printPage(renderPage(L, PRINT_DPI[L.paper]).toDataURL('image/png'), { ...opt, kind: 'png' })
        : await window.api.printPage(plot.svg, { ...opt, kind: 'svg' });
      if (r && r.saved) hint('PDF 저장됨: ' + r.saved, 5000);
      else if (r && r.error) hint('인쇄 실패: ' + r.error, 6000);
    } catch (err) {
      hint('인쇄 실패: ' + err.message, 6000);
    }
    setLoading(false);
  }
  ['#p-range', '#p-paper', '#p-orient', '#p-scale', '#p-n', '#p-lw', '#p-dims'].forEach((sel) => $(sel).addEventListener('input', updatePrintPreview));
  $('#p-pickwin').onclick = pickPrintWindow;
  $('#p-cancel').onclick = () => { $('#pmodal').hidden = true; };
  $('#p-pdf').onclick = () => doPrint('pdf');
  $('#p-print').onclick = () => doPrint('printer');
  $('#btn-print').onclick = () => (printWin || $('#p-range').value !== 'window' ? openPrint() : pickPrintWindow());

  // ───────────────────────── 오른쪽 패널 숨기기 ─────────────────────────
  function setPanel(show) {
    document.body.classList.toggle('nopanel', !show);
    $('#btn-panel').classList.toggle('active', show);
    try { localStorage.setItem('panelHidden', show ? '0' : '1'); } catch (e) { /* 무시 */ }
  }
  const panelShown = () => !document.body.classList.contains('nopanel');
  $('#btn-panel').onclick = () => setPanel(!panelShown());
  try { setPanel(localStorage.getItem('panelHidden') !== '1'); } catch (e) { /* 무시 */ }

  // ───────────────────────── 탭 ─────────────────────────
  function switchTab(name) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'search') setTimeout(() => $('#search-input').focus(), 0);
  }
  $$('#tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  // ───────────────────────── 문자 검색 ─────────────────────────
  $('#search-input').addEventListener('input', () => {
    const q = $('#search-input').value.trim().toLowerCase();
    const ul = $('#search-list');
    ul.innerHTML = '';
    if (!q || !S.scene) return;
    const hits = [];
    for (const t of S.scene.texts) {
      if (t.str.toLowerCase().includes(q)) { hits.push(t); if (hits.length >= 500) break; }
    }
    if (!hits.length) { ul.innerHTML = '<li class="empty">결과 없음</li>'; return; }
    for (const t of hits) {
      const li = document.createElement('li');
      li.className = 'sr';
      li.innerHTML = '<span class="lname"></span><span class="cnt"></span>';
      li.querySelector('.lname').textContent = t.str;
      li.querySelector('.cnt').textContent = S.scene.layers[t.layer].name;
      li.onclick = () => {
        const b = t.bb, w = b[2] - b[0], h = b[3] - b[1];
        const pad = Math.max(w, h) * 4;
        view.zoomTo(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 0);
        S.flash = { bb: b, until: performance.now() + 2500 };
        drawUI();
        setTimeout(drawUI, 2600);
      };
      ul.appendChild(li);
    }
  });

  // ───────────────────────── 측정 ─────────────────────────
  function unitLabel() { return UNITS[S.scene && S.scene.units] || ''; }
  function areaText(a) {
    const u = S.scene && S.scene.units;
    const conv = { 4: 1e6, 5: 1e4, 6: 1, 1: 1550.0031, 2: 10.7639 }[u];
    if (conv) return `${fmt(a / conv, 3)} m²`;
    return `${fmt(a)} (도면단위²)`;
  }
  // 거리 치수: 측정점 a·b와 수직 간격 off(월드)로 치수선 위치를 정한다 (AutoCAD 평행 치수처럼)
  function dimNormal(m) {
    const [a, b] = m.pts;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
  }
  function dimScreen(m) {
    const [a, b] = m.pts, n = dimNormal(m), o = m.off || 0;
    return {
      a: view.toScreen(a[0], a[1]), b: view.toScreen(b[0], b[1]),
      da: view.toScreen(a[0] + n[0] * o, a[1] + n[1] * o), db: view.toScreen(b[0] + n[0] * o, b[1] + n[1] * o),
    };
  }
  // 화면 좌표 근처의 거리 치수(치수선 또는 숫자) 번호, 없으면 -1
  function hitDim(sx, sy) {
    for (let i = S.measures.length - 1; i >= 0; i--) {
      const m = S.measures[i];
      if (m.type !== 'dist') continue;
      const { da, db } = dimScreen(m);
      const dx = db[0] - da[0], dy = db[1] - da[1], L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((sx - da[0]) * dx + (sy - da[1]) * dy) / L2)) : 0;
      if (Math.hypot(da[0] + dx * t - sx, da[1] + dy * t - sy) < 6) return i;
      const mx = (da[0] + db[0]) / 2, my = (da[1] + db[1]) / 2 - 14;
      if (Math.abs(sx - mx) < 40 && Math.abs(sy - my) < 12) return i;
    }
    return -1;
  }
  function measureInfo(m) {
    if (m.type === 'dist') {
      const [a, b] = m.pts;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d = Math.hypot(dx, dy);
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      return { main: `${fmt(d)} ${unitLabel()}`, sub: `ΔX ${fmt(dx)} · ΔY ${fmt(dy)} · 각도 ${fmt(ang, 1)}°`, label: fmt(d) };
    }
    const p = m.pts;
    let a = 0, per = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
      per += Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]);
    }
    a = Math.abs(a) / 2;
    return { main: areaText(a), sub: `둘레 ${fmt(per)} ${unitLabel()} · 점 ${p.length}개 · ${fmt(a)} ${unitLabel()}²`, label: areaText(a) };
  }
  function renderMeasures() {
    const ul = $('#measure-list');
    ul.innerHTML = '';
    if (!S.measures.length) { ul.innerHTML = '<li class="empty">📏 거리(D) · ⬠ 면적(A) 도구로 측정하세요</li>'; return; }
    S.measures.forEach((m, i) => {
      const info = measureInfo(m);
      const li = document.createElement('li');
      li.className = 'mi';
      li.innerHTML = `<div class="top"><span class="cnt">#${i + 1} ${m.type === 'dist' ? '거리' : '면적'}</span><span class="grow"></span><button class="del">삭제</button></div><div class="v"></div><div class="d"></div>`;
      li.querySelector('.v').textContent = info.main;
      li.querySelector('.d').textContent = info.sub;
      li.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); S.measures.splice(i, 1); renderMeasures(); drawUI(); };
      li.onclick = () => {
        const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
        view.zoomTo(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 0.3);
      };
      ul.appendChild(li);
    });
    ul.scrollTop = ul.scrollHeight;
  }
  function finishArea() {
    const pts = S.cur.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1e-9);
    if (pts.length >= 3) {
      S.measures.push({ type: 'area', pts });
      renderMeasures();
      switchTab('measure');
    }
    S.cur = [];
    updateHint();
    drawUI();
  }

  // ───────────────────────── 스냅 ─────────────────────────
  function buildIndex() {
    const s = S.scene;
    const e = s.fullExtents;
    const G = 512;
    const cs = Math.max(e[2] - e[0], e[3] - e[1]) / G || 1;
    const cell = (x, y) => [Math.min(G, Math.max(0, Math.floor((x - e[0]) / cs))), Math.min(G, Math.max(0, Math.floor((y - e[1]) / cs)))];
    const key = (ix, iy) => ix * 1024 + iy;
    const pts = new Map(), segs = new Map();
    const add = (map, k, i) => { let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(i); };
    const P = s.snap.pts;
    for (let i = 0; i < P.length / 2; i++) { const [ix, iy] = cell(P[i * 2], P[i * 2 + 1]); add(pts, key(ix, iy), i); }
    const A = s.segs.a;
    for (let i = 0; i < A.length / 4; i++) {
      const x1 = A[i * 4], y1 = A[i * 4 + 1], x2 = A[i * 4 + 2], y2 = A[i * 4 + 3];
      const [ax, ay] = cell(Math.min(x1, x2), Math.min(y1, y2)), [bx, by] = cell(Math.max(x1, x2), Math.max(y1, y2));
      if ((bx - ax + 1) * (by - ay + 1) <= 16) {
        for (let ix = ax; ix <= bx; ix++) for (let iy = ay; iy <= by; iy++) add(segs, key(ix, iy), i);
      } else {
        const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cs / 2));
        let last = -1;
        for (let k = 0; k <= n; k++) {
          const [ix, iy] = cell(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n);
          const kk = key(ix, iy);
          if (kk !== last) { add(segs, kk, i); last = kk; }
        }
      }
    }
    S.index = { pts, segs, cell, key, cs };
  }
  const KIND_ON = () => ({ 1: $('#snap-end').checked, 2: $('#snap-mid').checked, 3: $('#snap-cen').checked, 4: $('#snap-cen').checked, 5: $('#snap-near').checked });
  function findSnap(wx, wy) {
    const s = S.scene;
    if (!s) return null;
    if (!S.index) buildIndex();
    const ix = S.index;
    const r = 12 / view.scale;
    const [ax, ay] = ix.cell(wx - r, wy - r), [bx, by] = ix.cell(wx + r, wy + r);
    if ((bx - ax + 1) * (by - ay + 1) > 3000) return null;
    const on = KIND_ON();
    let best = null, bd = r;
    const P = s.snap.pts;
    const visL = (l) => view.layerVis[l] !== false;
    for (let cx = ax; cx <= bx; cx++) for (let cy = ay; cy <= by; cy++) {
      const list = ix.pts.get(ix.key(cx, cy));
      if (!list) continue;
      for (const i of list) {
        const k = s.snap.kind[i];
        if (!on[k] || !visL(s.snap.layer[i])) continue;
        const d = Math.hypot(P[i * 2] - wx, P[i * 2 + 1] - wy);
        if (d < bd) { bd = d; best = { x: P[i * 2], y: P[i * 2 + 1], kind: k }; }
      }
    }
    if (best || !on[5]) return best;
    const A = s.segs.a;
    for (let cx = ax; cx <= bx; cx++) for (let cy = ay; cy <= by; cy++) {
      const list = ix.segs.get(ix.key(cx, cy));
      if (!list) continue;
      for (const i of list) {
        if (!visL(s.segs.layer[i])) continue;
        const x1 = A[i * 4], y1 = A[i * 4 + 1], x2 = A[i * 4 + 2], y2 = A[i * 4 + 3];
        const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((wx - x1) * dx + (wy - y1) * dy) / L2)) : 0;
        const px = x1 + dx * t, py = y1 + dy * t;
        const d = Math.hypot(px - wx, py - wy);
        if (d < bd) { bd = d; best = { x: px, y: py, kind: 5 }; }
      }
    }
    return best;
  }

  // ───────────────────────── UI 오버레이 그리기 ─────────────────────────
  view.onRender = drawUI;
  function drawUI() {
    const dpr = window.devicePixelRatio || 1;
    if (ui.width !== Math.round(ui.clientWidth * dpr)) { ui.width = Math.round(ui.clientWidth * dpr); ui.height = Math.round(ui.clientHeight * dpr); }
    const c = uctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, ui.width, ui.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!S.scene) return;
    const acc = view.light ? '#d1006f' : '#00e5ff';
    const fill = view.light ? 'rgba(209,0,111,0.12)' : 'rgba(0,229,255,0.15)';
    const sp = (p) => view.toScreen(p[0], p[1]);
    const label = (x, y, text) => {
      c.font = '600 13px -apple-system, "Apple SD Gothic Neo", sans-serif';
      const w = c.measureText(text).width + 12;
      c.fillStyle = view.light ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.75)';
      c.strokeStyle = acc;
      c.lineWidth = 1;
      c.beginPath(); c.roundRect(x - w / 2, y - 11, w, 22, 5); c.fill(); c.stroke();
      c.fillStyle = view.light ? '#000' : '#fff';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, x, y + 1);
    };
    const drawDim = (m, live) => {
      const { a, b, da, db } = dimScreen(m);
      const sl = Math.hypot(db[0] - da[0], db[1] - da[1]) || 1;
      // 화면상 치수선의 법선과, 측정점→치수선 방향
      let nx = -(db[1] - da[1]) / sl, ny = (db[0] - da[0]) / sl;
      const ox = da[0] - a[0], oy = da[1] - a[1], od = Math.hypot(ox, oy);
      if (od > 1e-6 && nx * ox + ny * oy < 0) { nx = -nx; ny = -ny; }
      const GAP = 3, EXT = 6;
      c.strokeStyle = acc; c.lineWidth = 1.6;
      c.setLineDash(live ? [6, 4] : []);
      c.beginPath(); c.moveTo(da[0], da[1]); c.lineTo(db[0], db[1]); c.stroke();
      c.setLineDash([]);
      // 양 끝 보조선(치수보조선): 측정점 근처에서 치수선 너머까지
      c.lineWidth = 1;
      c.beginPath();
      for (const [p, d] of [[a, da], [b, db]]) {
        const s0 = od > GAP ? GAP : -EXT;
        c.moveTo(p[0] + nx * s0, p[1] + ny * s0);
        c.lineTo(d[0] + nx * EXT, d[1] + ny * EXT);
      }
      c.stroke();
      // 치수선 양 끝 화살표
      const ux = (db[0] - da[0]) / sl, uy = (db[1] - da[1]) / sl, AL = 9, AW = 2.5;
      c.fillStyle = acc;
      for (const [p, s] of [[da, 1], [db, -1]]) {
        c.beginPath();
        c.moveTo(p[0], p[1]);
        c.lineTo(p[0] + ux * AL * s - uy * AW, p[1] + uy * AL * s + ux * AW);
        c.lineTo(p[0] + ux * AL * s + uy * AW, p[1] + uy * AL * s - ux * AW);
        c.closePath(); c.fill();
      }
      for (const p of [a, b]) { c.beginPath(); c.arc(p[0], p[1], 2.5, 0, Math.PI * 2); c.fill(); }
      label((da[0] + db[0]) / 2, (da[1] + db[1]) / 2 - 14, measureInfo(m).label);
    };
    const drawMeasure = (m, live) => {
      if (m.type === 'dist') { drawDim(m, live); return; }
      c.strokeStyle = acc; c.fillStyle = fill; c.lineWidth = 1.6;
      const pts = m.pts.map(sp);
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      if (m.type === 'area') { c.closePath(); c.fill(); }
      c.setLineDash(live ? [6, 4] : []);
      c.stroke();
      c.setLineDash([]);
      for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2); c.fillStyle = acc; c.fill(); }
      if (pts.length >= 3) {
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        label(cx, cy, measureInfo(m).label);
      }
    };
    for (const m of S.measures) drawMeasure(m, false);
    // 진행 중
    if (S.cur.length && S.mouse) {
      if (S.tool === 'dist') drawMeasure({ type: 'dist', pts: [S.cur[0], S.mouse] }, true);
      else if (S.tool === 'area') drawMeasure({ type: 'area', pts: [...S.cur, S.mouse] }, true);
    }
    // 인쇄 윈도우 고무줄 사각형
    if (S.tool === 'printwin' && S.cur.length && S.mouse) {
      const [ax, ay] = sp(S.cur[0]), [bx, by] = sp(S.mouse);
      c.strokeStyle = acc; c.lineWidth = 1.5; c.setLineDash([6, 4]);
      c.fillStyle = fill;
      c.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      c.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      c.setLineDash([]);
    }
    // 스냅 마커
    if (S.snap) {
      const [x, y] = sp([S.snap.x, S.snap.y]);
      c.strokeStyle = '#ffb000'; c.lineWidth = 2;
      c.beginPath();
      const r = 7;
      switch (S.snap.kind) {
        case 1: c.rect(x - r, y - r, r * 2, r * 2); break;
        case 2: c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); break;
        case 3: c.arc(x, y, r, 0, Math.PI * 2); break;
        case 4: c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); break;
        default: c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r);
      }
      c.stroke();
    }
    // 창 확대 사각형
    if (drag && drag.mode === 'zoomwin' && drag.cur) {
      c.strokeStyle = acc; c.setLineDash([5, 4]); c.lineWidth = 1;
      c.fillStyle = fill;
      const x = Math.min(drag.sx, drag.cur[0]), y = Math.min(drag.sy, drag.cur[1]);
      const w = Math.abs(drag.cur[0] - drag.sx), h = Math.abs(drag.cur[1] - drag.sy);
      c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h); c.setLineDash([]);
    }
    // 검색 강조
    if (S.flash && performance.now() < S.flash.until) {
      const b = S.flash.bb;
      const [x0, y0] = view.toScreen(b[0], b[3]), [x1, y1] = view.toScreen(b[2], b[1]);
      c.strokeStyle = '#ffb000'; c.lineWidth = 3;
      c.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
    }
  }

  // ───────────────────────── 도구 ─────────────────────────
  function setTool(t) {
    S.tool = t;
    S.cur = [];
    S.snap = null;
    $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    ui.classList.toggle('pan', t === 'pan');
    updateHint();
    drawUI();
  }
  $$('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  // ───────────────────────── 마우스 ─────────────────────────
  const measuring = () => S.tool === 'dist' || S.tool === 'area' || S.tool === 'pickpt' || S.tool === 'printwin';
  function pointerWorld(ev) {
    const r = ui.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    let [wx, wy] = view.toWorld(sx, sy);
    S.snap = null;
    if (measuring() && S.scene) {
      const sn = findSnap(wx, wy);
      if (sn) { S.snap = sn; wx = sn.x; wy = sn.y; }
      else if (ev.shiftKey && S.cur.length) {
        const last = S.cur[S.cur.length - 1];
        if (Math.abs(wx - last[0]) > Math.abs(wy - last[1])) wy = last[1]; else wx = last[0];
      }
    }
    return { sx, sy, wx, wy };
  }
  ui.addEventListener('mousedown', (ev) => {
    if (!S.scene) return;
    const p = pointerWorld(ev);
    if (ev.button === 0 && !spaceDown && !S.cur.length && (S.tool === 'pan' || S.tool === 'dist')) {
      const i = hitDim(p.sx, p.sy);
      if (i >= 0) {
        const m = S.measures[i], n = dimNormal(m);
        const [wx, wy] = view.toWorld(p.sx, p.sy);
        drag = { mode: 'dim', m, grab: (m.off || 0) - ((wx - m.pts[0][0]) * n[0] + (wy - m.pts[0][1]) * n[1]) };
        S.snap = null;
        ev.preventDefault();
        return;
      }
    }
    if (ev.button === 1 || ev.button === 2 && S.tool !== 'area' || (ev.button === 0 && (S.tool === 'pan' || spaceDown))) {
      drag = { mode: 'pan', lx: ev.clientX, ly: ev.clientY };
      ui.classList.add('panning');
      ev.preventDefault();
      return;
    }
    if (ev.button === 2 && S.tool === 'area') { finishArea(); return; }
    if (ev.button !== 0) return;
    if (S.tool === 'zoomwin') { drag = { mode: 'zoomwin', sx: p.sx, sy: p.sy, cur: null }; return; }
    const pt = [p.wx, p.wy];
    if (S.tool === 'pickpt') { if (S.pickCallback) { const cb = S.pickCallback; S.pickCallback = null; cb(pt); } return; }
    if (S.tool === 'printwin') {
      if (!S.cur.length) { S.cur = [pt]; updateHint(); drawUI(); }
      else if (S.pickCallback) { const cb = S.pickCallback, a = S.cur[0]; S.pickCallback = null; S.cur = []; cb(a, pt); }
      return;
    }
    if (S.tool === 'dist') {
      if (!S.cur.length) S.cur = [pt];
      else {
        S.measures.push({ type: 'dist', pts: [S.cur[0], pt] });
        S.cur = [];
        renderMeasures();
        switchTab('measure');
      }
    } else if (S.tool === 'area') S.cur.push(pt);
    updateHint();
    drawUI();
  });
  window.addEventListener('mousemove', (ev) => {
    if (drag && drag.mode === 'pan') {
      view.panBy(ev.clientX - drag.lx, ev.clientY - drag.ly);
      drag.lx = ev.clientX; drag.ly = ev.clientY;
      return;
    }
    if (drag && drag.mode === 'dim') {
      const r = ui.getBoundingClientRect();
      const [wx, wy] = view.toWorld(ev.clientX - r.left, ev.clientY - r.top);
      const m = drag.m, n = dimNormal(m);
      m.off = drag.grab + (wx - m.pts[0][0]) * n[0] + (wy - m.pts[0][1]) * n[1];
      drawUI();
      return;
    }
    if (!S.scene || (ev.target !== ui && !drag)) return;
    const p = pointerWorld(ev);
    const canGrab = !drag && !spaceDown && !S.cur.length && (S.tool === 'pan' || S.tool === 'dist') && hitDim(p.sx, p.sy) >= 0;
    ui.style.cursor = canGrab ? 'move' : '';
    if (canGrab) S.snap = null;
    S.mouse = [p.wx, p.wy];
    $('#coords').textContent = `X: ${fmt(p.wx, 3)}   Y: ${fmt(p.wy, 3)}`;
    if (drag && drag.mode === 'zoomwin') drag.cur = [p.sx, p.sy];
    drawUI();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.mode === 'zoomwin' && drag.cur && Math.abs(drag.cur[0] - drag.sx) > 5 && Math.abs(drag.cur[1] - drag.sy) > 5) {
      const [x0, y0] = view.toWorld(Math.min(drag.sx, drag.cur[0]), Math.max(drag.sy, drag.cur[1]));
      const [x1, y1] = view.toWorld(Math.max(drag.sx, drag.cur[0]), Math.min(drag.sy, drag.cur[1]));
      view.zoomTo(x0, y0, x1, y1, 0);
      setTool('pan');
    }
    drag = null;
    ui.classList.remove('panning');
    drawUI();
  });
  ui.addEventListener('dblclick', () => { if (S.tool === 'area') finishArea(); });
  ui.addEventListener('auxclick', (ev) => { if (ev.button === 1 && ev.detail === 2) view.zoomExtents(); });
  ui.addEventListener('contextmenu', (ev) => ev.preventDefault());
  ui.addEventListener('mouseleave', () => { S.snap = null; S.mouse = null; drawUI(); });
  ui.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    if (!S.scene) return;
    const r = ui.getBoundingClientRect();
    const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
    if (ev.ctrlKey) view.zoomAt(sx, sy, Math.exp(-dy * 0.01)); // 트랙패드 핀치
    else if ($('#trackpad').checked) view.panBy(-ev.deltaX, -ev.deltaY);
    else view.zoomAt(sx, sy, Math.exp(-dy * 0.0018));
  }, { passive: false });

  // ───────────────────────── 키보드 ─────────────────────────
  let lastPanelKey = 0; // ⌘\ 를 메뉴와 화면이 둘 다 받아 두 번 토글되는 것 방지
  window.addEventListener('keydown', (ev) => {
    // 글자를 치는 입력칸에서만 단축키를 끈다 (체크박스·버튼 포커스는 해당 안 됨)
    const tg = ev.target;
    const typing = tg.isContentEditable || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' ||
      (tg.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range', 'color'].includes(tg.type));
    if (ev.key === 'Escape') {
      if (!$('#keys-help').hidden) { $('#keys-help').hidden = true; return; }
      if (!$('#modal').hidden) { $('#modal').hidden = true; return; }
      if (!$('#pmodal').hidden) { $('#pmodal').hidden = true; return; }
      if (S.tool === 'printwin') { S.pickCallback = null; setTool('pan'); if (printWin) openPrint(); return; }
      if (S.cur.length) { S.cur = []; updateHint(); drawUI(); } else setTool('pan');
      if (typing) ev.target.blur();
      return;
    }
    if (ev.metaKey && ev.code === 'Backslash' && !typing) { lastPanelKey = performance.now(); setPanel(!panelShown()); ev.preventDefault(); return; }
    if (!$('#keys-help').hidden && !typing) { if (ev.key === '?' || ev.code === 'Slash') toggleKeysHelp(); return; }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey || !$('#pmodal').hidden || !$('#modal').hidden) return;
    // 한글 입력 상태에서도 되도록 글자 대신 물리 키(KeyD 등)로 판단
    const k = /^Key[A-Z]$/.test(ev.code) ? ev.code.slice(3).toLowerCase() : ev.code === 'Space' ? ' ' : ev.key.toLowerCase();
    if (k === ' ') { spaceDown = true; ui.classList.add('pan'); ev.preventDefault(); if (tg.blur && tg !== document.body) tg.blur(); }
    else if (ev.key === '?' || (ev.code === 'Slash' && ev.shiftKey)) toggleKeysHelp();
    else if (k === 'f') view.zoomExtents();
    else if (k === 'p') setTool('pan');
    else if (k === 'd') setTool('dist');
    else if (k === 'a') setTool('area');
    else if (k === 'z') setTool('zoomwin');
    else if (k === 'e') toggleCheck('#snap-end', '끝점 스냅');
    else if (k === 'm') toggleCheck('#snap-mid', '중간점 스냅');
    else if (k === 'c') toggleCheck('#snap-cen', '중심 스냅');
    else if (k === 'n') toggleCheck('#snap-near', '근처점 스냅');
    else if (k === 't') toggleCheck('#trackpad', '트랙패드 모드');
    else if (['1', '2', '3', '4'].includes(ev.key) || /^Digit[1-4]$/.test(ev.code)) { setPanel(true); switchTab(['layers', 'xrefs', 'measure', 'search'][+ev.code.slice(-1) - 1]); }
    else if (k === 'enter' && S.tool === 'area') finishArea();
    else if ((k === 'backspace' || k === 'delete') && ev.shiftKey) $('#btn-clear').click();
    else if ((k === 'backspace' || k === 'delete') && S.measures.length && !S.cur.length) { S.measures.pop(); renderMeasures(); drawUI(); }
    else return;
    if (k !== ' ') ev.preventDefault();
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Space' || ev.key === ' ') { spaceDown = false; ui.classList.toggle('pan', S.tool === 'pan'); }
  });

  // ───────────────────────── 버튼/메뉴 ─────────────────────────
  function toggleBg() {
    view.light = !view.light;
    try { localStorage.setItem('bgLight', view.light ? '1' : '0'); } catch (e) { /* 무시 */ }
    view.request();
  }
  async function savePng() {
    if (!S.scene) return;
    view.render();
    const out = document.createElement('canvas');
    out.width = $('#gl').width; out.height = $('#gl').height;
    const c = out.getContext('2d');
    c.drawImage($('#gl'), 0, 0); c.drawImage($('#text'), 0, 0); c.drawImage(ui, 0, 0);
    const name = baseName(S.mainPath).replace(/\.(dwg|dxf)$/i, '') + '_캡처.png';
    const saved = await window.api.savePng(out.toDataURL('image/png'), name);
    if (saved) hint('저장됨: ' + saved, 4000);
  }
  function zoomCenter(f) { view.zoomAt(view.w / 2, view.h / 2, f); }
  $('#btn-open').onclick = () => window.api.openDialog();
  $('#btn-extents').onclick = () => view.zoomExtents();
  $('#btn-clear').onclick = () => { S.measures = []; S.cur = []; renderMeasures(); drawUI(); };
  $('#btn-xref').onclick = startAttach;
  $('#btn-xref2').onclick = startAttach;
  $('#btn-bg').onclick = toggleBg;
  $('#btn-png').onclick = savePng;
  try { $('#trackpad').checked = localStorage.getItem('trackpad') === '1'; view.light = localStorage.getItem('bgLight') === '1'; } catch (e) { /* 무시 */ }
  $('#trackpad').onchange = () => { try { localStorage.setItem('trackpad', $('#trackpad').checked ? '1' : '0'); } catch (e) { /* 무시 */ } };

  window.api.onOpenPath(openPath);
  window.api.onCommand((c) => {
    if (c === 'zoom-extents') view.zoomExtents();
    else if (c === 'zoom-in') zoomCenter(1.4);
    else if (c === 'zoom-out') zoomCenter(1 / 1.4);
    else if (c === 'toggle-bg') toggleBg();
    else if (c === 'search') { setPanel(true); switchTab('search'); }
    else if (c === 'toggle-panel') { if (performance.now() - lastPanelKey > 300) setPanel(!panelShown()); }
    else if (c === 'attach-xref') startAttach();
    else if (c === 'save-png') savePng();
    else if (c === 'print') $('#btn-print').click();
    else if (c === 'reload' && S.mainPath) openPath(S.mainPath);
    else if (c === 'keys-help') toggleKeysHelp();
  });

  // 끌어다 놓기
  const empty = $('#empty');
  window.addEventListener('dragover', (ev) => { ev.preventDefault(); empty.hidden = false; empty.classList.add('drag'); });
  window.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) { empty.classList.remove('drag'); empty.hidden = !!S.scene; } });
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    empty.classList.remove('drag');
    empty.hidden = !!S.scene;
    const ps = [...ev.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter((p) => /\.(dwg|dxf)$/i.test(p));
    if (!ps.length) { if (ev.dataTransfer.files.length) hint('DWG 또는 DXF 파일만 열 수 있습니다', 3000); return; }
    ps.forEach((p) => window.api.openInTab(p)); // 열린 도면이 있으면 새 탭으로
  });

  new ResizeObserver(() => { view.resize(); drawUI(); }).observe($('#stage'));
  view.resize();
  renderLayers();
  renderMeasures();
  window.api.checkConverter().then((ok) => { $('#conv-warn').hidden = ok; });

  // ───────────────────────── 단축키 표 · 툴팁 ─────────────────────────
  // 버튼 툴팁과 단축키 목록(?)이 모두 이 표에서 나온다. 키 처리는 위 keydown과 메뉴(main.js)
  const KEYS = [
    ['파일', [
      ['#btn-open', '열기', ['⌘O'], 'DWG/DXF 열기 — 새 탭으로 열립니다. 여러 개 선택 가능'],
      [null, '새 탭 / 새 창', ['⌘T', '⌘N']],
      [null, '탭 닫기', ['⌘W']],
      [null, '다음 / 이전 탭', ['⌃Tab', '⌃⇧Tab']],
      [null, '도면 다시 불러오기', ['⌘R']],
      ['#btn-xref', 'XREF 부착', ['⌘⇧X'], '다른 도면을 겹쳐 붙입니다'],
      ['#btn-png', 'PNG 저장', ['⌘⇧S'], '지금 화면을 이미지로 저장'],
      ['#btn-print', '인쇄 / PDF', ['⌘P'], '측정 치수선도 함께 출력됩니다'],
    ]],
    ['보기', [
      ['[data-tool=pan]', '이동', ['P', 'Esc'], '드래그로 이동, 휠로 확대·축소. Space를 누른 채 드래그해도 이동'],
      ['[data-tool=zoomwin]', '창 확대', ['Z'], '드래그한 영역을 확대'],
      ['#btn-extents', '전체 보기', ['F'], '휠 버튼 더블클릭도 같음'],
      [null, '확대 / 축소', ['⌘=', '⌘-']],
      ['#btn-bg', '배경 전환', ['⌘B'], '검정 ↔ 흰색 배경'],
      ['#btn-panel', '패널 숨기기/보이기', ['⌘\\']],
      ['[data-tab=layers]', '레이어 탭', ['1']],
      ['[data-tab=xrefs]', 'XREF 탭', ['2']],
      ['[data-tab=measure]', '측정 탭', ['3']],
      ['[data-tab=search]', '문자 검색', ['4', '⌘F']],
      ['#btn-keys', '단축키 목록', ['?']],
    ]],
    ['측정', [
      ['[data-tool=dist]', '거리 (치수)', ['D'], '두 점 클릭. Shift: 수평/수직 고정. 그린 치수선은 끌어서 옮길 수 있음'],
      ['[data-tool=area]', '면적', ['A'], '점을 차례로 클릭, 더블클릭·Enter·우클릭으로 완료'],
      [null, '면적 완료', ['Enter']],
      [null, '마지막 측정 지우기', ['⌫']],
      ['#btn-clear', '측정 모두 지우기', ['⇧⌫']],
      [null, '진행 중 측정 취소', ['Esc']],
    ]],
    ['스냅 · 입력', [
      ['label:has(#snap-end)', '끝점 스냅 켜기/끄기', ['E']],
      ['label:has(#snap-mid)', '중간점 스냅 켜기/끄기', ['M']],
      ['label:has(#snap-cen)', '중심 스냅 켜기/끄기', ['C']],
      ['label:has(#snap-near)', '근처점 스냅 켜기/끄기', ['N']],
      ['label:has(#trackpad)', '트랙패드 모드', ['T'], '두 손가락 스크롤 = 이동, 핀치 = 확대·축소'],
    ]],
  ];
  const kbds = (keys) => keys.map((k) => `<kbd>${k}</kbd>`).join(' ');
  function toggleCheck(sel, name) {
    const cb = $(sel);
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
    hint(`${name} ${cb.checked ? '켜짐' : '꺼짐'}`, 1500);
  }
  function toggleKeysHelp() {
    const box = $('#keys-help');
    if (box.hidden) {
      $('#keys-list').innerHTML = KEYS.map(([g, rows]) => `<div class="g"><div class="gh">${g}</div>` +
        rows.map(([, n, keys]) => `<div class="r"><span class="n">${n}</span>${kbds(keys)}</div>`).join('') + '</div>').join('');
    }
    box.hidden = !box.hidden;
  }
  $('#btn-keys').onclick = toggleKeysHelp;
  $('#keys-help').onclick = (ev) => { if (ev.target.id === 'keys-help') toggleKeysHelp(); };
  // 버튼에 마우스를 올리면 이름·단축키·설명 표시
  const tip = $('#tip');
  let tipTimer = null;
  for (const [, rows] of KEYS) for (const [sel, n, keys, d] of rows) {
    if (!sel) continue;
    for (const el of $$(sel)) {
      el.addEventListener('mouseenter', () => {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => {
          tip.innerHTML = `<div class="t"><span>${n}</span><span class="grow"></span>${kbds(keys)}</div>` + (d ? `<div class="d">${d}</div>` : '');
          tip.hidden = false;
          const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
          const below = r.bottom + 6 + th < window.innerHeight;
          tip.style.left = Math.max(6, Math.min(window.innerWidth - tw - 6, r.left + r.width / 2 - tw / 2)) + 'px';
          tip.style.top = (below ? r.bottom + 6 : r.top - th - 6) + 'px';
        }, 250);
      });
      el.addEventListener('mouseleave', () => { clearTimeout(tipTimer); tip.hidden = true; });
    }
  }
  // 버튼을 누른 뒤 포커스가 남아 Space/Enter가 버튼을 다시 누르지 않도록
  document.addEventListener('mouseup', (ev) => {
    const b = ev.target.closest && ev.target.closest('button, input[type=checkbox]');
    if (b) setTimeout(() => b.blur(), 0);
  });

  // 개발용 훅
  window.__dwg = { S, view, openPath };
})();
