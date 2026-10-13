// 화면 표시: 선/채움은 WebGL, 문자는 2D 캔버스 오버레이로 그린다.
(function (global) {
  'use strict';

  const VS = `
    attribute vec2 a_pos;
    attribute vec4 a_col;
    uniform vec4 u_t;
    varying vec4 v_col;
    void main() {
      gl_Position = vec4(a_pos.x * u_t.x + u_t.z, a_pos.y * u_t.y + u_t.w, 0.0, 1.0);
      v_col = a_col;
    }`;
  const FS = `
    precision mediump float;
    varying vec4 v_col;
    uniform float u_light;
    uniform float u_mono;
    void main() {
      vec3 c = v_col.rgb;
      if (u_mono > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      // 흰 배경에서는 흰색(7번)을 검정으로, 검은 배경에서는 검정을 흰색으로
      if (u_light > 0.5 && lum > 0.92) c = vec3(0.0);
      else if (u_light < 0.5 && lum < 0.08) c = vec3(1.0);
      gl_FragColor = vec4(c, 1.0);
    }`;

  class View {
    constructor(glCanvas, textCanvas) {
      this.gc = glCanvas;
      this.tc = textCanvas;
      this.gl = glCanvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true, alpha: false });
      this.tctx = textCanvas.getContext('2d');
      this.scene = null;
      this.cx = 0; this.cy = 0; this.scale = 1;
      this.light = false;
      this.layerVis = []; this.groupVis = [];
      this._init();
      this.dirty = false;
      this.onRender = null;
    }
    _init() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      this.prog = p;
      this.aPos = gl.getAttribLocation(p, 'a_pos');
      this.aCol = gl.getAttribLocation(p, 'a_col');
      this.uT = gl.getUniformLocation(p, 'u_t');
      this.uLight = gl.getUniformLocation(p, 'u_light');
      this.uMono = gl.getUniformLocation(p, 'u_mono');
      this.mono = false; // 인쇄 흑백
      this.thick = false; // 인쇄용 2px 선
      this.buf = { lp: gl.createBuffer(), lc: gl.createBuffer(), tp: gl.createBuffer(), tc: gl.createBuffer() };
    }
    setScene(scene, keepView) {
      this.scene = scene;
      const gl = this.gl;
      const up = (b, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); };
      up(this.buf.lp, scene.linePos); up(this.buf.lc, scene.lineCol);
      up(this.buf.tp, scene.triPos); up(this.buf.tc, scene.triCol);
      if (!keepView) this.zoomExtents();
      this.request();
    }
    resize(ew, eh, edpr) {
      const dpr = edpr || window.devicePixelRatio || 1;
      const w = ew || this.gc.clientWidth, h = eh || this.gc.clientHeight;
      for (const c of [this.gc, this.tc]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      this.dpr = dpr; this.w = w; this.h = h;
      this.request();
    }
    // 좌표 변환
    toScreen(x, y) { return [(x - this.cx) * this.scale + this.w / 2, this.h / 2 - (y - this.cy) * this.scale]; }
    toWorld(sx, sy) { return [(sx - this.w / 2) / this.scale + this.cx, (this.h / 2 - sy) / this.scale + this.cy]; }
    zoomAt(sx, sy, f) {
      const [wx, wy] = this.toWorld(sx, sy);
      this.scale = Math.min(1e7, Math.max(1e-7, this.scale * f));
      this.cx = wx - (sx - this.w / 2) / this.scale;
      this.cy = wy - (this.h / 2 - sy) / this.scale;
      this.request();
    }
    panBy(dx, dy) { this.cx -= dx / this.scale; this.cy += dy / this.scale; this.request(); }
    zoomTo(x0, y0, x1, y1, margin) {
      const m = margin === undefined ? 0.05 : margin;
      const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
      this.scale = Math.min(this.w / (w * (1 + 2 * m)), this.h / (h * (1 + 2 * m)));
      this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
      this.request();
    }
    zoomExtents() {
      if (!this.scene) return;
      const e = this.scene.extents;
      this.zoomTo(e[0], e[1], e[2], e[3]);
    }
    isVisible(layerId, groupId) { return this.layerVis[layerId] !== false && this.groupVis[groupId] !== false; }

    request() {
      if (this.dirty) return;
      this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; this.render(); });
    }
    render() {
      const gl = this.gl;
      gl.viewport(0, 0, this.gc.width, this.gc.height);
      const bg = this.light ? [1, 1, 1] : [0.106, 0.114, 0.129];
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const tctx = this.tctx;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, this.tc.width, this.tc.height);
      const s = this.scene;
      if (!s) { if (this.onRender) this.onRender(); return; }

      gl.useProgram(this.prog);
      const kx = (2 * this.scale) / this.w, ky = (2 * this.scale) / this.h;
      const bx = (s.origin[0] - this.cx) * kx, by = (s.origin[1] - this.cy) * ky;
      gl.uniform4f(this.uT, kx, ky, bx, by);
      gl.uniform1f(this.uLight, this.light ? 1 : 0);
      gl.uniform1f(this.uMono, this.mono ? 1 : 0);
      gl.enableVertexAttribArray(this.aPos);
      gl.enableVertexAttribArray(this.aCol);

      const draw = (pb, cb, mode, startKey, countKey) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.vertexAttribPointer(this.aCol, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        for (const r of s.ranges) {
          if (r[countKey] && this.isVisible(r.layer, r.group)) gl.drawArrays(mode, r[startKey], r[countKey]);
        }
      };
      draw(this.buf.tp, this.buf.tc, gl.TRIANGLES, 'ts', 'tc');
      draw(this.buf.lp, this.buf.lc, gl.LINES, 'ls', 'lc');
      if (this.thick) { // 인쇄용: 1px 어긋나게 겹쳐 그려 선을 굵게
        const px = 2 / this.gc.width, py = 2 / this.gc.height;
        for (const [ox, oy] of [[px, 0], [0, py], [px, py]]) {
          gl.uniform4f(this.uT, kx, ky, bx + ox, by + oy);
          draw(this.buf.lp, this.buf.lc, gl.LINES, 'ls', 'lc');
        }
      }
      this.renderText();
      if (this.onRender) this.onRender();
    }
    renderText() {
      const s = this.scene, ctx = this.tctx, dpr = this.dpr;
      const [vx0, vy1] = this.toWorld(0, 0), [vx1, vy0] = this.toWorld(this.w, this.h);
      const sc = this.scale;
      ctx.font = `${Scene.EM * 100}px ${Scene.FONT}`;
      ctx.textBaseline = 'alphabetic';
      let lastCol = -1;
      for (const t of s.texts) {
        const hp = t.h * sc;
        if (hp < 1.6) continue;
        const b = t.bb;
        if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
        if (!this.isVisible(t.layer, t.group)) continue;
        let col = t.col;
        const r = (col >> 16) & 255, g = (col >> 8) & 255, bl = col & 255;
        const lum = (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
        if (this.mono) col = 0;
        else if (this.light && lum > 0.92) col = 0;
        else if (!this.light && lum < 0.08) col = 0xffffff;
        if (col !== lastCol) { ctx.fillStyle = '#' + col.toString(16).padStart(6, '0'); lastCol = col; }
        // 문자공간(100px=높이 1) → 화면
        const W = t.W, k = sc / 100;
        const a = W[0] * k, bb = -W[1] * k, c = -W[2] * k, d = W[3] * k;
        const e = (W[4] - this.cx) * sc + this.w / 2, f = this.h / 2 - (W[5] - this.cy) * sc;
        ctx.setTransform(a * dpr, bb * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
        for (const ln of t.lines) ctx.fillText(ln.s, ln.dx * 100, -ln.dy * 100);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  global.View = View;
})(window);
