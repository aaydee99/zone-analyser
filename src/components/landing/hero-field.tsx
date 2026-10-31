'use client';

import { useEffect, useRef } from 'react';
import { useReducedMotion } from './motion';

// The hero's backdrop: liquid chrome on obsidian, lit in gold and crimson, rendered live with
// WebGL2. The light follows the pointer. It renders at up to 1.5x device pixels and steps the
// resolution down by itself on a slow GPU. It stops off screen and in background tabs, draws one
// still frame under reduced motion, and leaves the CSS gradient behind it showing without WebGL2.

const VERT = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res; uniform float u_t; uniform vec2 u_m;
out vec4 o;
float h(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float n(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5; mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * n(p); p = r * p * 2.02; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y * 0.8 + (u_m - 0.5) * 0.08;
  float t = u_t;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.035)), fbm(p + vec2(5.2, 1.3) - t * 0.03));
  vec2 w = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.045), fbm(p + 3.0 * q + vec2(8.3, 2.8)));
  float v = fbm(p + 3.4 * w);

  // Surface normal from the field's slope, then a chrome reflection of a soft studio light.
  vec2 g = vec2(dFdx(v), dFdy(v)) * u_res.y * 0.11;
  vec3 nrm = normalize(vec3(-g, 1.0));
  vec3 L = normalize(vec3((u_m - 0.5) * 1.4 + vec2(-0.25, 0.45), 0.7));
  float spec = pow(max(dot(reflect(-L, nrm), vec3(0, 0, 1)), 0.0), 18.0);
  float fres = pow(1.0 - nrm.z, 1.4);
  float bands = 0.5 + 0.5 * cos(6.2831 * (v * 1.6 + nrm.x * 0.5 + nrm.y * 0.3));

  vec3 obsidian = vec3(0.043, 0.043, 0.055);
  vec3 chrome = vec3(0.80, 0.82, 0.86);
  vec3 gold = vec3(0.85, 0.69, 0.30);
  vec3 crimson = vec3(0.78, 0.06, 0.18);

  vec3 col = obsidian + chrome * (bands * bands * 0.07 + spec * 0.5 + fres * 0.16);
  col += gold * smoothstep(0.55, 0.95, q.x) * (0.11 + spec * 1.0);
  col += crimson * smoothstep(0.5, 0.92, w.y) * (0.17 + fres * 0.3);

  // Quieter behind the headline (left), brighter to the right; soft vignette.
  float side = 0.38 + 0.62 * smoothstep(0.05, 0.85, uv.x);
  col = mix(obsidian, col, side * smoothstep(1.35, 0.25, length((uv - vec2(0.62, 0.62)) * vec2(1.0, 1.2))));
  o = vec4(col, 1.0);
}`;

export function HeroField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) return;

    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'u_res'), uT = gl.getUniformLocation(prog, 'u_t'), uM = gl.getUniformLocation(prog, 'u_m');

    let scale = Math.min(window.devicePixelRatio || 1, 1.5);
    const size = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * scale)), h = Math.max(1, Math.round(r.height * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    };
    const target = { x: 0.6, y: 0.6 }, m = { x: 0.6, y: 0.6 };
    const draw = (t: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uT, t);
      gl.uniform2f(uM, m.x, m.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    size();
    canvas.dataset.ready = '1';
    if (reduced) { draw(14); return; }

    let raf = 0, running = false, last = 0, slow = 0, frames = 0;
    const start = performance.now() - 14_000;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // A slow GPU shows up as long frames: drop the resolution a step at a time (not below 0.5x).
      if (last) { if (now - last > 26) slow++; if (++frames === 90) { if (slow > 30 && scale > 0.5) { scale = Math.max(0.5, scale * 0.8); size(); } frames = 0; slow = 0; } }
      last = now;
      m.x += (target.x - m.x) * 0.05; m.y += (target.y - m.y) * 0.05;
      draw((now - start) / 1000);
    };
    const run = (on: boolean) => {
      if (on === running) return;
      running = on; last = 0;
      if (on) raf = requestAnimationFrame(frame); else cancelAnimationFrame(raf);
    };
    let onScreen = true;
    const sync = () => run(onScreen && document.visibilityState === 'visible');
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sync(); });
    io.observe(canvas);
    const ro = new ResizeObserver(() => { size(); if (!running) draw((performance.now() - start) / 1000); });
    ro.observe(canvas);
    const move = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      target.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      target.y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('visibilitychange', sync);
    canvas.addEventListener('webglcontextlost', () => run(false));
    sync();
    return () => {
      run(false); io.disconnect(); ro.disconnect();
      window.removeEventListener('pointermove', move);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [reduced]);

  return <canvas ref={ref} aria-hidden="true" className="lp-field" />;
}
