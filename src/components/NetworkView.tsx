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
// EVERY type in the merged graph has an entry. This table held eight when the
// graph held eight; the world merge brought it to seventeen and the nine new
// ones fell through to the grey fallback. SANCTIONED_ENTITY alone is 20,077 of
// 28,730 nodes, so seventy per cent of the picture rendered grey and the view
// read as one undifferentiated blob. A missing entry here is not a cosmetic
// gap, it is the largest category in the graph becoming invisible.
const TYPE_COLOR: Record<string, [number, number, number]> = {
  // audit corpus
  APPLICATION:        [0.00, 0.96, 0.77],  // cyan
  DOMAIN:             [0.35, 0.60, 1.00],  // blue
  VENDOR:             [1.00, 0.72, 0.20],  // amber
  SIGNAL_CLASS:       [1.00, 0.35, 0.45],  // red
  ORGANIZATION:       [0.65, 0.45, 1.00],  // violet
  REGULATOR_STATE:    [1.00, 1.00, 1.00],  // white
  ENTITY:             [0.55, 0.55, 0.65],  // grey, and genuinely unclassified
  // world model
  COUNTRY:            [0.30, 1.00, 0.45],  // green -- the join key, kept loud
  SANCTIONED_ENTITY:  [1.00, 0.45, 0.75],  // pink, the largest population
  SANCTIONS_PROGRAM:  [0.85, 0.20, 0.55],  // deep magenta, its hubs
  ACTOR:              [1.00, 0.85, 0.40],  // pale gold
  GEOPOLITICAL_EVENT: [0.45, 0.85, 1.00],  // ice blue
  DISASTER:           [1.00, 0.55, 0.10],  // orange
  COMPANY:            [0.70, 1.00, 0.30],  // lime
  // the system describing itself
  WORKFLOW_STATE:     [0.60, 0.95, 0.90],  // pale teal
  INTERACTION_THREAD: [0.80, 0.75, 1.00],  // pale violet
  // the audit trail. White, because a report is the only node type in this
  // graph that is a primary document -- everything else is an extraction from
  // one, and the eye should be able to find the sources.
  AUDIT_REPORT:       [1.00, 0.98, 0.88],
  // hazards, with their causes, their scale and their moment
  VOLCANO:            [1.00, 0.30, 0.05],  // deep orange, the source
  ERUPTION:           [1.00, 0.62, 0.25],  // lighter, the events from it
  FLOOD:              [0.25, 0.55, 0.95],  // water blue
  FLOOD_CAUSE:        [0.10, 0.80, 0.95],  // brighter cyan, the cause hubs
  DISASTER_TYPE:      [1.00, 0.40, 0.30],  // salmon
  ERUPTION_SCALE:     [0.95, 0.85, 0.35],  // yellow, an ordinal class
  // Time. Grey on purpose and deliberately quiet: a period is scaffolding that
  // makes "what else happened then" answerable, not a thing that happened.
  PERIOD:             [0.62, 0.62, 0.70],
};

// A type with no entry renders grey, and grey is where the whole graph went
// once already: the table held eight entries while the graph held seventeen,
// and the missing SANCTIONED_ENTITY was 70% of the nodes. There is no way to
// make that impossible from here -- the types come from the server -- so the
// panel reports unknown types in its legend rather than silently greying them.
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
in float aSize;
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
  gl_PointSize = max(1.5, uPointScale * persp * aSize);
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
  /** Node types to leave out. Empty = draw all of them. */
  hiddenTypes?: Set<string>;
  onPick?: (node: NetworkNode) => void;
}

export default function NetworkView({ graph, visibleProvenance, hiddenTypes, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // zoom is 0.85, not the pre-SPREAD 1.1: point size (gl_PointSize below) is
  // driven by uPointScale * persp, not by uZoom, so zooming out to frame a
  // wider cloud shrinks the on-screen GAP between points without shrinking
  // the points themselves -- fully compensating zoom for SPREAD's 1.15->1.75
  // growth would have put the separation right back where it started. This
  // is a partial compensation on purpose: enough that the whole cloud is
  // visible without a manual scroll on first load, not so much that it
  // cancels out what SPREAD was just changed to do.
  const view = useRef({ angle: 0.5, tilt: 0.35, zoom: 0.85, panX: 0, panY: 0 });
  const drag = useRef({ on: false, x: 0, y: 0, moved: false });
  const [glError, setGlError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<NetworkNode | null>(null);

  // Buffers are built once per graph, not per frame. This is the entire reason
  // the thing scales: the per-frame work is two draw calls regardless of size.
  const buffers = useMemo(() => {
    const n = graph.nodes.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);

    // WHY THE CLOUD IS RE-SPREAD, and what was actually wrong with it.
    //
    // The first diagnosis here was that PCA emits axes in variance order, so
    // PC3 would be flat and the cloud would render as a pancake. MEASURED ON
    // THE REAL PAYLOAD, THAT WAS WRONG: the three axes have standard deviations
    // 0.138 / 0.118 / 0.117, a ratio of 1.2x. There was no pancake.
    //
    // What there is, is a dense core. 92.6% of all 28,730 nodes sit within a
    // quarter of the maximum radius, because the graph is mostly leaves --
    // 20,077 sanctions entities with a median radius of 0.11 -- while the hubs
    // are flung to the edge (COUNTRY sits at 0.71, ACTOR at 0.65). Ninety-two
    // per cent of the points in a few per cent of the volume is a solid ball
    // whichever way you turn it.
    //
    // So the radius is passed through a square root, which is monotonic: every
    // node that was nearer the centre than another still is, and no point
    // crosses another. It expands the crowded middle and compresses the sparse
    // outside -- measured, that takes the share inside a quarter-radius from
    // 92.6% to 14.0%. (r^0.4 was also tried and overshoots into the opposite
    // failure: 1.1% inside, i.e. a hollow shell.)
    //
    // THIS IS NOT A DISTANCE-PRESERVING VIEW and must not be read as one. Rank
    // by distance survives; ratios of distance do not. Nothing in this panel
    // measures, it locates -- and a picture where 92% of the subject matter is
    // one opaque lump locates nothing.
    //
    // The per-axis normalisation below is kept even though it is close to a
    // no-op on today's data (1.2x), because it costs one pass and a future
    // graph with a genuinely dominant first component would need it.
    let mx = 0, my = 0, mz = 0;
    for (const nd of graph.nodes) { mx += nd.x; my += nd.y; mz += nd.z; }
    mx /= n || 1; my /= n || 1; mz /= n || 1;
    let vx = 0, vy = 0, vz = 0;
    for (const nd of graph.nodes) {
      vx += (nd.x - mx) ** 2; vy += (nd.y - my) ** 2; vz += (nd.z - mz) ** 2;
    }
    const sx = Math.sqrt(vx / (n || 1)) || 1;
    const sy = Math.sqrt(vy / (n || 1)) || 1;
    const sz = Math.sqrt(vz / (n || 1)) || 1;

    // Longest radius after normalisation, so the square root maps onto [0,1]
    // and the result can be scaled once into the clip volume.
    let rMax = 1e-9;
    for (const nd of graph.nodes) {
      const r = Math.hypot((nd.x - mx) / sx, (nd.y - my) / sy, (nd.z - mz) / sz);
      if (r > rMax) rMax = r;
    }
    // 1.15 kept the cloud technically de-clumped (14.0% inside a quarter-
    // radius, measured above) but still read as one dense mass at a glance --
    // Simeon's own reaction looking at the live render. Pushed further: the
    // sqrt already does the real work of pulling the crowded core apart, this
    // constant just sets how much room the result gets to breathe in.
    const SPREAD = 1.75;

    // Degree, so hubs are visible as hubs. 28,730 identically-sized dots hide
    // the fact that a handful of them hold thousands of edges.
    const degree = new Float32Array(n);
    for (const e of graph.edges) { degree[e.s]++; degree[e.o]++; }
    let maxDeg = 1;
    for (let i = 0; i < n; i++) if (degree[i] > maxDeg) maxDeg = degree[i];

    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i];
      const ux = (node.x - mx) / sx, uy = (node.y - my) / sy, uz = (node.z - mz) / sz;
      const r = Math.hypot(ux, uy, uz);
      // Same direction, re-spread radius. A node at the centroid stays there
      // rather than being divided by zero.
      const k = r > 1e-9 ? (Math.sqrt(r / rMax) / r) * SPREAD : 0;
      pos[i * 3] = ux * k; pos[i * 3 + 1] = uy * k; pos[i * 3 + 2] = uz * k;
      const c = TYPE_COLOR[node.type] || FALLBACK_COLOR;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      // Cube root, not linear: degree is heavy-tailed (6121 against a median of
      // 2), and a linear map would draw one node the size of the panel and
      // everything else as a pixel.
      siz[i] = 0.55 + 1.9 * Math.cbrt(degree[i] / maxDeg);
    }
    // Type filtering happens here rather than in the shader, so hidden nodes
    // cost nothing to draw at all. Points move from drawArrays to drawElements
    // for the same reason: an index buffer of what is visible beats drawing
    // 28,730 points and discarding most of them.
    const hidden = hiddenTypes && hiddenTypes.size ? hiddenTypes : null;
    const visibleIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!hidden || !hidden.has(graph.nodes[i].type)) visibleIdx.push(i);
    }
    const pointIndices = new Uint32Array(visibleIdx);

    // One index buffer per provenance class, so each is drawn with its own
    // alpha in its own call instead of being sorted per frame. An edge is drawn
    // only when BOTH ends are: a line into a hidden node would point at nothing
    // and read as an edge to empty space.
    const byProv = new Map<string, number[]>();
    for (const e of graph.edges) {
      if (hidden && (hidden.has(graph.nodes[e.s]?.type) || hidden.has(graph.nodes[e.o]?.type))) continue;
      if (!byProv.has(e.p)) byProv.set(e.p, []);
      byProv.get(e.p)!.push(e.s, e.o);
    }
    const edgeSets = [...byProv.entries()].map(([prov, idx]) => ({
      prov, indices: new Uint32Array(idx), count: idx.length,
    }));
    return { pos, col, siz, edgeSets, n, pointIndices };
  }, [graph, hiddenTypes]);

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
    const sizBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, sizBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.siz, gl.STATIC_DRAW);
    const pointIdxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pointIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, buffers.pointIndices, gl.STATIC_DRAW);

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
      // The line shader has no aSize, so getAttribLocation returns -1 there.
      // Binding a -1 location is a GL error, hence the guard rather than an
      // unconditional bind.
      const aSize = gl.getAttribLocation(prog, 'aSize');
      if (aSize >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, sizBuf);
        gl.enableVertexAttribArray(aSize);
        gl.vertexAttribPointer(aSize, 1, gl.FLOAT, false, 0, 0);
      }
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
    const pointScale = Math.max(3, Math.min(14, 900 / Math.sqrt(buffers.pointIndices.length || 1)));

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
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pointIdxBuf);
      gl.drawElements(gl.POINTS, buffers.pointIndices.length, gl.UNSIGNED_INT, 0);
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
    // pickAt() is an O(n) full-node scan (rotation + perspective divide +
    // distance check per node) -- at 28,730 nodes that is real, measurable
    // CPU work, and pointermove fires far more often than once per frame on
    // most mice/trackpads. Calling it synchronously on every raw event means
    // the browser can be asked to do several full scans per rendered frame,
    // all on the main thread that also has to run React's state update and
    // the WebGL draw call -- that pile-up, not the draw call itself (which
    // stays two calls regardless of zoom, see the buffers comment above), is
    // what reads as "gets slower the more I interact with it". Coalesced to
    // at most one pick per animation frame: extra pointermove events between
    // frames just overwrite the pending coordinates rather than each
    // triggering their own scan.
    let pendingPick: { x: number; y: number } | null = null;
    let pickRaf = 0;
    const flushPick = () => {
      pickRaf = 0;
      if (!pendingPick) return;
      const { x, y } = pendingPick;
      pendingPick = null;
      setHovered(pickAt(x, y));
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.current.on) {
        pendingPick = { x: e.clientX, y: e.clientY };
        if (!pickRaf) pickRaf = requestAnimationFrame(flushPick);
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
      view.current = { angle: 0.5, tilt: 0.35, zoom: 0.85, panX: 0, panY: 0 };
      draw.current();
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', onDbl);
    return () => {
      if (pickRaf) cancelAnimationFrame(pickRaf);
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
