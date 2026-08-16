'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// The whole DINGIR network, drawn in two WebGL draw calls.
//
// Deliberately NOT a graph library and NOT a force simulation. bi_api's
// build_mycelium already runs PCA-3D over the trained GNN embeddings, so every
// node arrives with a position that MEANS something: a cluster here is a
// cluster the model found, not an artifact of a physics engine. That also
// removes the reason a graph library would exist -- there is no layout to
// compute, only points and lines to draw, which is two buffers and two calls.
//
// The 2d/3d canvas renderer in ReasoningPanel cannot do this job: its draw loop
// recomputes an O(n^2) kNN and applies shadowBlur per node per frame, which is
// fine for the 60 neighbours it was built for and impossible at 843, let alone
// the ~27,600 the merged world model will carry.

export type NetworkNode = { id: string; type: string; x: number; y: number; z: number };
export type NetworkEdge = { s: number; o: number; r: string; p: string };
export type NetworkGraph = {
  nodes: NetworkNode[]; edges: NetworkEdge[];
  node_count: number; edge_count: number;
  types: string[]; relations: string[];
  provenance: Record<string, number>;
  error?: string;
};

// One colour per node type. Distinct hues rather than a gradient, because these
// are categories and a viewer has to be able to name what they are looking at.
const TYPE_COLOR: Record<string, [number, number, number]> = {
  APPLICATION:     [0.00, 0.96, 0.77],
  DOMAIN:          [0.35, 0.60, 1.00],
  VENDOR:          [1.00, 0.72, 0.20],
  SIGNAL_CLASS:    [1.00, 0.35, 0.45],
  ORGANIZATION:    [0.65, 0.45, 1.00],
  COUNTRY:         [0.30, 1.00, 0.45],
  REGULATOR_STATE: [1.00, 1.00, 1.00],
  ENTITY:          [0.55, 0.55, 0.65],
};
const FALLBACK_COLOR: [number, number, number] = [0.5, 0.5, 0.55];

/** The same colours as CSS, derived from the shader's table rather than typed
 *  out twice, so a legend can never disagree with what is actually drawn. */
export const TYPE_SWATCH: Record<string, string> = Object.fromEntries(
  Object.entries(TYPE_COLOR).map(([type, [r, g, b]]) => [
    type,
    `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
  ])
);

// Provenance is drawn, not filtered. An edge computed from a hostname must not
// look like an edge that came out of an audit finding, or the whole picture
// invites being quoted as observation.
const PROV_ALPHA: Record<string, number> = { OBSERVED: 0.5, DERIVED: 0.16, PREDICTED: 0.1 };

const VERT = `#version 300 es
in vec3 aPos;
in vec3 aColor;
uniform mat3 uRot;
uniform float uZoom;
uniform vec2 uPan;
uniform float uPointScale;
out vec3 vColor;
out float vDepth;
void main() {
  vec3 p = uRot * aPos;
  float persp = 2.6 / (2.6 + p.z);
  vec2 screen = p.xy * persp * uZoom + uPan;
  gl_Position = vec4(screen, 0.0, 1.0);
  gl_PointSize = max(1.5, uPointScale * persp);
  vColor = aColor;
  vDepth = persp;
}`;

// Round points with a soft edge. Discarding outside the radius is what stops
// them reading as squares at large point sizes.
const FRAG_POINT = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vDepth;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float edge = smoothstep(0.5, 0.34, r);
  outColor = vec4(vColor * (0.55 + 0.45 * vDepth), edge * min(1.0, 0.35 + 0.65 * vDepth));
}`;

const FRAG_LINE = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vDepth;
out vec4 outColor;
uniform float uAlpha;
void main() {
  outColor = vec4(vColor, uAlpha * min(1.0, 0.3 + 0.7 * vDepth));
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  }
  return s;
}

function program(gl: WebGL2RenderingContext, frag: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  }
  return p;
}

interface Props {
  graph: NetworkGraph;
  /** Provenance classes to draw. Absent = draw all of them. */
  visibleProvenance?: Set<string>;
  onPick?: (node: NetworkNode) => void;
}

export default function NetworkView({ graph, visibleProvenance, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ angle: 0.5, tilt: 0.35, zoom: 1.1, panX: 0, panY: 0 });
  const drag = useRef({ on: false, x: 0, y: 0, moved: false });
  const [glError, setGlError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<NetworkNode | null>(null);

  // Buffers are built once per graph, not per frame. This is the entire reason
  // the thing scales: the per-frame work is two draw calls regardless of size.
  const buffers = useMemo(() => {
    const n = graph.nodes.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i];
      pos[i * 3] = node.x; pos[i * 3 + 1] = node.y; pos[i * 3 + 2] = node.z;
      const c = TYPE_COLOR[node.type] || FALLBACK_COLOR;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    // One index buffer per provenance class, so each is drawn with its own
    // alpha in its own call instead of being sorted per frame.
    const byProv = new Map<string, number[]>();
    for (const e of graph.edges) {
      if (!byProv.has(e.p)) byProv.set(e.p, []);
      byProv.get(e.p)!.push(e.s, e.o);
    }
    const edgeSets = [...byProv.entries()].map(([prov, idx]) => ({
      prov, indices: new Uint32Array(idx), count: idx.length,
    }));
    return { pos, col, edgeSets, n };
  }, [graph]);

  const draw = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const gl = cv.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) { setGlError('WebGL2 is not available in this browser'); return; }

    let pointProg: WebGLProgram, lineProg: WebGLProgram;
    try {
      pointProg = program(gl, FRAG_POINT);
      lineProg = program(gl, FRAG_LINE);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.pos, gl.STATIC_DRAW);
    const colBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.col, gl.STATIC_DRAW);

    const edgeBufs = buffers.edgeSets.map(set => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, set.indices, gl.STATIC_DRAW);
      return { ...set, buffer: b };
    });

    const bindAttribs = (prog: WebGLProgram) => {
      const aPos = gl.getAttribLocation(prog, 'aPos');
      const aColor = gl.getAttribLocation(prog, 'aColor');
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
    };

    const setUniforms = (prog: WebGLProgram, pointScale: number) => {
      const v = view.current;
      const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
      const ct = Math.cos(v.tilt), st = Math.sin(v.tilt);
      // yaw then pitch, column-major for WebGL
      const m = new Float32Array([
        ca, sa * st, sa * ct,
        0, ct, -st,
        -sa, ca * st, ca * ct,
      ]);
      const aspect = cv.width / Math.max(1, cv.height);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'uRot'), false, m);
      gl.uniform1f(gl.getUniformLocation(prog, 'uZoom'), v.zoom / aspect);
      gl.uniform2f(gl.getUniformLocation(prog, 'uPan'), v.panX, v.panY);
      gl.uniform1f(gl.getUniformLocation(prog, 'uPointScale'), pointScale);
    };

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = wrap.clientWidth * dpr;
      cv.height = wrap.clientHeight * dpr;
      cv.style.width = wrap.clientWidth + 'px';
      cv.style.height = wrap.clientHeight + 'px';
      gl.viewport(0, 0, cv.width, cv.height);
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(wrap);

    // Point size shrinks as the graph grows: 843 nodes want dots you can aim
    // at, 27,000 want a cloud you can read the shape of.
    const pointScale = Math.max(3, Math.min(11, 900 / Math.sqrt(buffers.n || 1)));

    const render = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(lineProg);
      bindAttribs(lineProg);
      setUniforms(lineProg, pointScale);
      for (const set of edgeBufs) {
        if (visibleProvenance && !visibleProvenance.has(set.prov)) continue;
        gl.uniform1f(gl.getUniformLocation(lineProg, 'uAlpha'), PROV_ALPHA[set.prov] ?? 0.2);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, set.buffer);
        gl.drawElements(gl.LINES, set.count, gl.UNSIGNED_INT, 0);
      }

      gl.useProgram(pointProg);
      bindAttribs(pointProg);
      setUniforms(pointProg, pointScale);
      gl.drawArrays(gl.POINTS, 0, buffers.n);
    };
    draw.current = render;

    // Rendered on demand rather than in a permanent rAF loop: the view only
    // changes when the user moves it, so an idle panel costs nothing.
    render();

    return () => { ro.disconnect(); };
  }, [buffers, visibleProvenance]);

  // Screen-space pick against the same projection the shader uses.
  const pickAt = useCallback((clientX: number, clientY: number): NetworkNode | null => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return null;
    const rect = cv.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const v = view.current;
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const ct = Math.cos(v.tilt), st = Math.sin(v.tilt);
    const aspect = rect.width / Math.max(1, rect.height);
    let best: NetworkNode | null = null, bestD = 0.035;
    for (const n of graph.nodes) {
      const rx = ca * n.x - sa * n.z;
      const ry = sa * st * n.x + ct * n.y + ca * st * n.z;
      const rz = sa * ct * n.x - st * n.y + ca * ct * n.z;
      const persp = 2.6 / (2.6 + rz);
      const sx = rx * persp * (v.zoom / aspect) + v.panX;
      const sy = ry * persp * v.zoom + v.panY;
      const d = Math.hypot(sx - nx, sy - ny);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }, [graph]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onDown = (e: PointerEvent) => {
      drag.current = { on: true, x: e.clientX, y: e.clientY, moved: false };
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.current.on) {
        const hit = pickAt(e.clientX, e.clientY);
        setHovered(hit);
        return;
      }
      const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
      if (e.shiftKey) {
        view.current.panX += dx / 260;
        view.current.panY -= dy / 260;
      } else {
        view.current.angle += dx * 0.006;
        view.current.tilt = Math.max(-1.4, Math.min(1.4, view.current.tilt + dy * 0.006));
      }
      drag.current.x = e.clientX; drag.current.y = e.clientY;
      draw.current();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag.current.moved) {
        const hit = pickAt(e.clientX, e.clientY);
        if (hit && onPick) onPick(hit);
      }
      drag.current.on = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.current.zoom = Math.max(0.15, Math.min(40, view.current.zoom * (e.deltaY > 0 ? 0.9 : 1.11)));
      draw.current();
    };
    const onDbl = () => {
      view.current = { angle: 0.5, tilt: 0.35, zoom: 1.1, panX: 0, panY: 0 };
      draw.current();
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDbl);
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('dblclick', onDbl);
    };
  }, [pickAt, onPick]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg border border-white/[0.08] bg-black">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing touch-none" />
      {glError && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[11px] text-[var(--alert-red)]">
          {glError}
        </div>
      )}
      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/85 px-2.5 py-1.5 font-mono text-[10px]">
          <div className="text-[var(--text-primary)]">{hovered.id}</div>
          <div className="text-[var(--text-muted)]">{hovered.type}</div>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 font-mono text-[9px] text-[var(--text-muted)]/70">
        drag = rotate · shift-drag = pan · scroll = zoom · double-click = reset · click a node to inspect
      </div>
    </div>
  );
}
