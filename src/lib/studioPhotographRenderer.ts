import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CadComponentMeshData,
  CadDimensionRow,
  CadFaceFeature,
  CadFileMetadata,
  PartPhotograph,
  SurfaceFinishType,
} from '../types/cad';

export function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function getFinishPbrParams(
  finish: SurfaceFinishType,
  baseColorHex: number
): {
  color: number;
  metalness: number;
  roughness: number;
  clearcoat: number;
  emissive: number;
} {
  switch (finish) {
    case 'machined_cnc':
      return {
        color: 0xe2e8f0,
        metalness: 0.92,
        roughness: 0.16,
        clearcoat: 0.35,
        emissive: 0x000000,
      };
    case 'ground_polished':
      return {
        color: 0xf8fafc,
        metalness: 0.96,
        roughness: 0.07,
        clearcoat: 0.6,
        emissive: 0x000000,
      };
    case 'bead_blasted':
      return {
        color: 0xcbd5e1,
        metalness: 0.65,
        roughness: 0.48,
        clearcoat: 0.0,
        emissive: 0x000000,
      };
    case 'anodized_cobalt':
      return {
        color: 0x0284c7,
        metalness: 0.78,
        roughness: 0.24,
        clearcoat: 0.4,
        emissive: 0x000000,
      };
    case 'cast_raw':
      return {
        color: 0x64748b,
        metalness: 0.55,
        roughness: 0.65,
        clearcoat: 0.0,
        emissive: 0x000000,
      };
    case 'machining_highlight':
      return {
        color: 0xf59e0b,
        metalness: 0.65,
        roughness: 0.22,
        clearcoat: 0.3,
        emissive: 0x451a03,
      };
    default:
      return {
        color: baseColorHex || 0x94a3b8,
        metalness: 0.82,
        roughness: 0.26,
        clearcoat: 0.18,
        emissive: 0x000000,
      };
  }
}

/**
 * Topological 3D edge extracted from the triangle mesh with its adjacent triangle normals.
 * Used to classify true silhouette (horizon) edges, sharp feature creases, and occluded hidden edges
 * without rendering internal triangulation clutter or unverified circles.
 */
interface TopologicalEdge3D {
  vA: THREE.Vector3;
  vB: THREE.Vector3;
  nA: THREE.Vector3;
  nB: THREE.Vector3 | null;
  cosDihedral: number;
  isSharpCrease: boolean;
}

interface MeshTriangle3D {
  v0: THREE.Vector3;
  v1: THREE.Vector3;
  v2: THREE.Vector3;
  normal: THREE.Vector3;
}

function extractTopologicalEdgesAndTriangles(components: CadComponentMeshData[]): {
  edges: TopologicalEdge3D[];
  triangles: MeshTriangle3D[];
} {
  const edges: TopologicalEdge3D[] = [];
  const triangles: MeshTriangle3D[] = [];
  const cosCreaseThreshold = Math.cos((28 * Math.PI) / 180);

  const qKey = (x: number, y: number, z: number) =>
    `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;

  for (const comp of components) {
    const pos = comp.positions;
    const triCount = Math.floor(pos.length / 9);
    const edgeMap = new Map<
      string,
      {
        vA: THREE.Vector3;
        vB: THREE.Vector3;
        normals: THREE.Vector3[];
      }
    >();

    for (let t = 0; t < triCount; t++) {
      const b = t * 9;
      const p0 = new THREE.Vector3(pos[b], pos[b + 1], pos[b + 2]);
      const p1 = new THREE.Vector3(pos[b + 3], pos[b + 4], pos[b + 5]);
      const p2 = new THREE.Vector3(pos[b + 6], pos[b + 7], pos[b + 8]);

      const e1 = new THREE.Vector3().subVectors(p1, p0);
      const e2 = new THREE.Vector3().subVectors(p2, p0);
      const norm = new THREE.Vector3().crossVectors(e1, e2);
      const len = norm.length();
      if (len < 1e-9) continue;
      norm.divideScalar(len);

      triangles.push({ v0: p0, v1: p1, v2: p2, normal: norm });

      const k0 = qKey(p0.x, p0.y, p0.z);
      const k1 = qKey(p1.x, p1.y, p1.z);
      const k2 = qKey(p2.x, p2.y, p2.z);

      const pairs: Array<[string, string, THREE.Vector3, THREE.Vector3]> = [
        [k0, k1, p0, p1],
        [k1, k2, p1, p2],
        [k2, k0, p2, p0],
      ];

      for (const [ka, kb, va, vb] of pairs) {
        if (ka === kb) continue;
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        let entry = edgeMap.get(ek);
        if (!entry) {
          entry = { vA: va, vB: vb, normals: [norm] };
          edgeMap.set(ek, entry);
        } else if (entry.normals.length < 2) {
          entry.normals.push(norm);
        }
      }
    }

    for (const entry of edgeMap.values()) {
      const nA = entry.normals[0];
      const nB = entry.normals.length > 1 ? entry.normals[1] : null;
      const cosDihedral = nB ? nA.dot(nB) : -1;
      const isSharpCrease = !nB || cosDihedral < cosCreaseThreshold;
      edges.push({
        vA: entry.vA,
        vB: entry.vB,
        nA,
        nB,
        cosDihedral,
        isSharpCrease,
      });
    }
  }

  return { edges, triangles };
}

/**
 * Uses strict canonical 3D CAD orthogonal axes matching the 3D scene so Top View and Front View
 * are NEVER mixed or swapped:
 * - Top View looks strictly from the Top (+Z looking down toward -Z, showing X × Y)
 * - Front View looks strictly from the Front (-Y looking toward +Y, showing X × Z, aligned vertically below Top View)
 * - Side View looks strictly from the Side (+X looking toward -X, showing Y × Z, aligned horizontally to the right of Front View)
 */
interface PrincipalAxesBasis {
  axisCross: THREE.Vector3; // +X: Horizontal in Front View & Top View
  axisVert: THREE.Vector3; // +Z: Vertical in Front View & Side View; Viewing direction of Top View
  axisLong: THREE.Vector3; // -Y: Viewing direction of Front View; -axisLong (+Y) is Vertical in Top View & Horizontal in Side View
  spanCross: number;
  spanVert: number;
  spanLong: number;
  crossLabel: string;
  vertLabel: string;
  longLabel: string;
}

function determinePrincipalProjectionAxes(
  overallBox: THREE.Box3,
  _features: CadFaceFeature[]
): PrincipalAxesBasis {
  const size = new THREE.Vector3();
  overallBox.getSize(size);

  return {
    axisCross: new THREE.Vector3(1, 0, 0),
    axisVert: new THREE.Vector3(0, 0, 1),
    axisLong: new THREE.Vector3(0, -1, 0),
    spanCross: Math.max(size.x, 1),
    spanVert: Math.max(size.z, 1),
    spanLong: Math.max(size.y, 1),
    crossLabel: 'X',
    vertLabel: 'Z',
    longLabel: 'Y',
  };
}

interface ProjectedEdge2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Projects 3D topological edges onto an orthographic view defined by (uAxis, vAxis, wAxis)
 * where wAxis points toward the viewer, and separates them into:
 * - `visibleEdges`: Silhouette (horizon) edges & front-facing sharp crease edges not occluded by front triangles
 * - `hiddenEdges`: Relevant internal / back-facing sharp feature & bore silhouette edges
 */
function classifyAndProjectOrthographicEdges(
  edges: TopologicalEdge3D[],
  triangles: MeshTriangle3D[],
  center: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  wAxis: THREE.Vector3,
  spanU: number,
  spanV: number,
  spanW: number
): {
  visibleEdges: ProjectedEdge2D[];
  hiddenEdges: ProjectedEdge2D[];
} {
  // Build a fast 128x128 orthographic z-buffer (maxW grid) from front-facing triangles
  const GRID_RES = 128;
  const zGrid = new Float32Array(GRID_RES * GRID_RES).fill(-Infinity);
  const halfU = spanU * 0.55;
  const halfV = spanV * 0.55;

  const toGridX = (u: number) =>
    Math.max(0, Math.min(GRID_RES - 1, Math.floor(((u + halfU) / (2 * halfU)) * GRID_RES)));
  const toGridY = (v: number) =>
    Math.max(0, Math.min(GRID_RES - 1, Math.floor(((v + halfV) / (2 * halfV)) * GRID_RES)));

  const rel = new THREE.Vector3();
  for (const tri of triangles) {
    // Include all triangles in depth buffer so front-most surface wins
    rel.subVectors(tri.v0, center);
    const u0 = rel.dot(uAxis);
    const v0 = rel.dot(vAxis);
    const w0 = rel.dot(wAxis);

    rel.subVectors(tri.v1, center);
    const u1 = rel.dot(uAxis);
    const v1 = rel.dot(vAxis);
    const w1 = rel.dot(wAxis);

    rel.subVectors(tri.v2, center);
    const u2 = rel.dot(uAxis);
    const v2 = rel.dot(vAxis);
    const w2 = rel.dot(wAxis);

    const gxMin = Math.min(toGridX(u0), toGridX(u1), toGridX(u2));
    const gxMax = Math.max(toGridX(u0), toGridX(u1), toGridX(u2));
    const gyMin = Math.min(toGridY(v0), toGridY(v1), toGridY(v2));
    const gyMax = Math.max(toGridY(v0), toGridY(v1), toGridY(v2));

    const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(denom) < 1e-8) continue;

    for (let gy = gyMin; gy <= gyMax; gy++) {
      const pv = ((gy + 0.5) / GRID_RES) * (2 * halfV) - halfV;
      for (let gx = gxMin; gx <= gxMax; gx++) {
        const pu = ((gx + 0.5) / GRID_RES) * (2 * halfU) - halfU;
        const l0 = ((v1 - v2) * (pu - u2) + (u2 - u1) * (pv - v2)) / denom;
        const l1 = ((v2 - v0) * (pu - u2) + (u0 - u2) * (pv - v2)) / denom;
        const l2 = 1 - l0 - l1;
        if (l0 >= -0.05 && l1 >= -0.05 && l2 >= -0.05) {
          const wInterp = l0 * w0 + l1 * w1 + l2 * w2;
          const idx = gy * GRID_RES + gx;
          if (wInterp > zGrid[idx]) {
            zGrid[idx] = wInterp;
          }
        }
      }
    }
  }

  const visibleEdges: ProjectedEdge2D[] = [];
  const hiddenEdges: ProjectedEdge2D[] = [];
  const seenHiddenKeys = new Set<string>();
  const depthTol = Math.max(0.8, spanW * 0.045);

  for (const edge of edges) {
    const dotA = edge.nA.dot(wAxis);
    const dotB = edge.nB ? edge.nB.dot(wAxis) : -dotA;

    // An edge is a silhouette (horizon contour) for this view if one adjacent face points toward
    // the viewer and the other points away (or is nearly perpendicular to the viewing plane)
    const isSilhouette = dotA * dotB <= 1e-5 || Math.abs(dotA) < 0.08 || Math.abs(dotB) < 0.08;

    // Discard smooth internal triangulation lines! Only keep true silhouettes or sharp feature creases.
    if (!isSilhouette && !edge.isSharpCrease) continue;

    rel.subVectors(edge.vA, center);
    const u1 = rel.dot(uAxis);
    const v1 = rel.dot(vAxis);
    const w1 = rel.dot(wAxis);

    rel.subVectors(edge.vB, center);
    const u2 = rel.dot(uAxis);
    const v2 = rel.dot(vAxis);
    const w2 = rel.dot(wAxis);

    const len2D = Math.hypot(u2 - u1, v2 - v1);
    if (len2D < 1e-3) continue;

    // Check visibility at midpoint of edge against zGrid
    const uMid = 0.5 * (u1 + u2);
    const vMid = 0.5 * (v1 + v2);
    const wMid = 0.5 * (w1 + w2);
    const gx = toGridX(uMid);
    const gy = toGridY(vMid);
    const frontZ = zGrid[gy * GRID_RES + gx];

    const facesViewer = dotA > -0.02 || dotB > -0.02;
    const isUnoccluded = frontZ === -Infinity || wMid >= frontZ - depthTol;

    if (facesViewer && isUnoccluded) {
      visibleEdges.push({ x1: u1, y1: v1, x2: u2, y2: v2 });
    } else if (len2D >= Math.min(spanU, spanV) * 0.025) {
      // Deduplicate 2D hidden segments so overlapping back-edges don't clutter dashed lines
      const qx1 = Math.round(u1 * 2);
      const qy1 = Math.round(v1 * 2);
      const qx2 = Math.round(u2 * 2);
      const qy2 = Math.round(v2 * 2);
      const hk =
        qx1 < qx2 || (qx1 === qx2 && qy1 < qy2)
          ? `${qx1},${qy1}|${qx2},${qy2}`
          : `${qx2},${qy2}|${qx1},${qy1}`;
      if (!seenHiddenKeys.has(hk)) {
        seenHiddenKeys.add(hk);
        hiddenEdges.push({ x1: u1, y1: v1, x2: u2, y2: v2 });
      }
    }
  }

  return { visibleEdges, hiddenEdges };
}

/**
 * Computes exact cross-sectional slice segments where the 3D triangle mesh intersects
 * the cutting plane `(pt - center) · sectionNormal = 0`, projected onto `(uAxis, vAxis)`.
 */
function computeSectionCutSegments2D(
  triangles: MeshTriangle3D[],
  center: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3,
  sectionNormal: THREE.Vector3
): ProjectedEdge2D[] {
  const segments: ProjectedEdge2D[] = [];
  const rel0 = new THREE.Vector3();
  const rel1 = new THREE.Vector3();
  const rel2 = new THREE.Vector3();

  for (const tri of triangles) {
    rel0.subVectors(tri.v0, center);
    rel1.subVectors(tri.v1, center);
    rel2.subVectors(tri.v2, center);

    const d0 = rel0.dot(sectionNormal);
    const d1 = rel1.dot(sectionNormal);
    const d2 = rel2.dot(sectionNormal);

    const pts: Array<{ u: number; v: number }> = [];
    const pairs: Array<[THREE.Vector3, number, THREE.Vector3, number]> = [
      [rel0, d0, rel1, d1],
      [rel1, d1, rel2, d2],
      [rel2, d2, rel0, d0],
    ];

    for (const [pA, dA, pB, dB] of pairs) {
      if ((dA >= 0 && dB < 0) || (dA < 0 && dB >= 0)) {
        const denom = dA - dB;
        if (Math.abs(denom) > 1e-9) {
          const t = dA / denom;
          const ix = pA.x + t * (pB.x - pA.x);
          const iy = pA.y + t * (pB.y - pA.y);
          const iz = pA.z + t * (pB.z - pA.z);
          const u = ix * uAxis.x + iy * uAxis.y + iz * uAxis.z;
          const v = ix * vAxis.x + iy * vAxis.y + iz * vAxis.z;
          pts.push({ u, v });
        }
      }
    }

    if (pts.length >= 2) {
      segments.push({
        x1: pts[0].u,
        y1: pts[0].v,
        x2: pts[1].u,
        y2: pts[1].v,
      });
    }
  }

  return segments;
}

/**
 * Draws clean ASME Y14.2 / ISO 128 engineering dimension callout on white drafting paper.
 */
function drawTechnicalDimension(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string,
  extFrom1?: { x: number; y: number },
  extFrom2?: { x: number; y: number },
  color = '#0f172a',
  paperBg = '#f8fafc'
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  // Thin extension lines with a small gap from the part outline
  if (extFrom1 && extFrom2) {
    ctx.save();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(extFrom1.x, extFrom1.y);
    ctx.lineTo(x1, y1);
    ctx.moveTo(extFrom2.x, extFrom2.y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Main dimension line
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Sharp engineering arrowheads
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = 6.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + headLen * Math.cos(angle - 0.28), y1 + headLen * Math.sin(angle - 0.28));
  ctx.lineTo(x1 + headLen * Math.cos(angle + 0.28), y1 + headLen * Math.sin(angle + 0.28));
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - 0.28), y2 - headLen * Math.sin(angle - 0.28));
  ctx.lineTo(x2 - headLen * Math.cos(angle + 0.28), y2 - headLen * Math.sin(angle + 0.28));
  ctx.closePath();
  ctx.fill();

  // Dimension text with clean paper knockout
  const mx = (x1 + x2) * 0.5;
  const my = (y1 + y2) * 0.5;
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = paperBg;
  ctx.fillRect(mx - tw / 2 - 4, my - 7, tw + 8, 14);

  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, mx, my);
  ctx.restore();
}

/**
 * Draws a clean ASME Y14.2 radial/diametral leader pointing to the rim of a verified hole.
 */
function drawVerifiedHoleLeader(
  ctx: CanvasRenderingContext2D,
  rimX: number,
  rimY: number,
  elbowX: number,
  elbowY: number,
  label: string,
  paperBg = '#f8fafc'
) {
  ctx.save();
  ctx.strokeStyle = '#0f172a';
  ctx.fillStyle = '#0f172a';
  ctx.lineWidth = 1.1;

  const angle = Math.atan2(elbowY - rimY, elbowX - rimX);
  const headLen = 6.5;

  // Leader line from rim to elbow + short horizontal shelf
  const dirSign = elbowX >= rimX ? 1 : -1;
  const shelfEndX = elbowX + dirSign * 14;
  ctx.beginPath();
  ctx.moveTo(rimX, rimY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(shelfEndX, elbowY);
  ctx.stroke();

  // Arrowhead at bore rim
  ctx.beginPath();
  ctx.moveTo(rimX, rimY);
  ctx.lineTo(rimX + headLen * Math.cos(angle - 0.28), rimY + headLen * Math.sin(angle - 0.28));
  ctx.lineTo(rimX + headLen * Math.cos(angle + 0.28), rimY + headLen * Math.sin(angle + 0.28));
  ctx.closePath();
  ctx.fill();

  ctx.font = '700 10.5px "JetBrains Mono", monospace';
  const tw = ctx.measureText(label).width;
  const textX = dirSign > 0 ? shelfEndX + 4 : shelfEndX - tw - 4;
  ctx.fillStyle = paperBg;
  ctx.fillRect(textX - 2, elbowY - 7, tw + 4, 14);

  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, textX, elbowY);
  ctx.restore();
}

/**
 * Renders a single clean ASME Y14.3 / ISO 128 Orthographic or Section View onto `ctx`.
 * Strictly separates manufacturing geometry from diagnostic clutter:
 * - Visible outlines & sharp creases: solid dark ink (#0f172a, 1.7px)
 * - Hidden internal edges: dashed muted slate (#64748b, 0.85px)
 * - Section A-A cut surfaces: 45° ANSI cross-hatching + heavy cut boundary
 * - Centerlines: chain-thin dash-dot (#b91c1c, 0.9px) ONLY for symmetry and verified holes
 * - Dimensions: ONLY verified envelope & verified hole dimensions
 */
function renderCleanEngineeringView(
  ctx: CanvasRenderingContext2D,
  viewKind: 'top' | 'front' | 'side' | 'section',
  boxRect: { x: number; y: number; w: number; h: number },
  viewTitle: string,
  viewSubtitle: string,
  edges: TopologicalEdge3D[],
  triangles: MeshTriangle3D[],
  overallBox: THREE.Box3,
  basis: PrincipalAxesBasis,
  features: CadFaceFeature[],
  overrideScale?: number,
  overrideViewCenter?: { x: number; y: number }
) {
  const { x: bx, y: by, w: bw, h: bh } = boxRect;
  const paperBg = '#f8fafc';

  ctx.save();
  // Clean ISO/ASME drafting paper background inside view frame
  ctx.fillStyle = paperBg;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  // View Title Header Strip
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(bx + 1, by + 1, bw - 2, 26);
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(bx, by + 27);
  ctx.lineTo(bx + bw, by + 27);
  ctx.stroke();

  ctx.fillStyle = '#0f172a';
  ctx.font = '700 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(viewTitle, bx + 10, by + 14);

  ctx.fillStyle = '#475569';
  ctx.font = '500 9.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(viewSubtitle, bx + bw - 10, by + 14);

  const center = new THREE.Vector3();
  overallBox.getCenter(center);

  // Set up true Third-Angle Projection coordinate axes (uAxis, vAxis, wAxis)
  // Front View (Bottom-Left): U = +axisCross, V = +axisVert, W = +axisLong (End view looking down outlet!)
  // Top View (Top-Left, directly above Front): U = +axisCross, V = -axisLong, W = +axisVert
  // Right Side View (Bottom-Right, directly right of Front): U = -axisLong, V = +axisVert, W = +axisCross
  // Section A-A (Top-Right): U = -axisLong, V = +axisVert, W = +axisCross, sliced at axisCross = 0
  let uAxis = basis.axisCross.clone();
  let vAxis = basis.axisVert.clone();
  let wAxis = basis.axisLong.clone();
  let spanU = basis.spanCross;
  let spanV = basis.spanVert;
  let spanW = basis.spanLong;
  let uDimName = `W (${basis.crossLabel})`;
  let vDimName = `H (${basis.vertLabel})`;

  if (viewKind === 'front') {
    uAxis = basis.axisCross.clone();
    vAxis = basis.axisVert.clone();
    wAxis = basis.axisLong.clone();
    spanU = basis.spanCross;
    spanV = basis.spanVert;
    spanW = basis.spanLong;
    uDimName = `${basis.crossLabel}`;
    vDimName = `${basis.vertLabel}`;
  } else if (viewKind === 'top') {
    uAxis = basis.axisCross.clone();
    vAxis = basis.axisLong.clone().negate();
    wAxis = basis.axisVert.clone();
    spanU = basis.spanCross;
    spanV = basis.spanLong;
    spanW = basis.spanVert;
    uDimName = `${basis.crossLabel}`;
    vDimName = `${basis.longLabel}`;
  } else {
    // 'side' or 'section'
    uAxis = basis.axisLong.clone().negate();
    vAxis = basis.axisVert.clone();
    wAxis = basis.axisCross.clone();
    spanU = basis.spanLong;
    spanV = basis.spanVert;
    spanW = basis.spanCross;
    uDimName = `${basis.longLabel}`;
    vDimName = `${basis.vertLabel}`;
  }

  const padX = 68;
  const padY = 52;
  const availW = Math.max(80, bw - padX * 2);
  const availH = Math.max(80, bh - 28 - padY * 2);
  const scale = overrideScale ?? Math.min(availW / spanU, availH / spanV) * 0.78;
  const viewCenter = overrideViewCenter ?? {
    x: bx + bw * 0.5,
    y: by + 28 + (bh - 28) * 0.5,
  };

  const toScreen = (u: number, v: number) => ({
    x: viewCenter.x + u * scale,
    y: viewCenter.y - v * scale,
  });

  ctx.beginPath();
  ctx.rect(bx + 1, by + 28, bw - 2, bh - 29);
  ctx.clip();

  // Classify visible vs. hidden edges for this projection
  const { visibleEdges, hiddenEdges } = classifyAndProjectOrthographicEdges(
    edges,
    triangles,
    center,
    uAxis,
    vAxis,
    wAxis,
    spanU,
    spanV,
    spanW
  );

  const halfPxW = (spanU * scale) / 2;
  const halfPxH = (spanV * scale) / 2;

  // 1. If Section A-A View, compute cross-section cut segments & draw 45° ANSI section hatching
  if (viewKind === 'section') {
    const cutSegments = computeSectionCutSegments2D(
      triangles,
      center,
      uAxis,
      vAxis,
      basis.axisCross
    );

    // Draw subtle light-gray background outline of visible edges behind the section cut
    ctx.save();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (const seg of visibleEdges) {
      const p1 = toScreen(seg.x1, seg.y1);
      const p2 = toScreen(seg.x2, seg.y2);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
    ctx.restore();

    // Fill cut region with 45-degree scanline hatching between even-odd horizontal/diagonal intersections
    if (cutSegments.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 0.85;
      const numScanlines = 38;
      ctx.beginPath();
      for (let i = 1; i < numScanlines; i++) {
        const vScan = -spanV * 0.5 + (spanV * i) / numScanlines;
        const uHits: number[] = [];
        for (const seg of cutSegments) {
          if ((seg.y1 <= vScan && seg.y2 > vScan) || (seg.y2 <= vScan && seg.y1 > vScan)) {
            const t = (vScan - seg.y1) / (seg.y2 - seg.y1);
            uHits.push(seg.x1 + t * (seg.x2 - seg.x1));
          }
        }
        uHits.sort((a, b) => a - b);
        for (let k = 0; k + 1 < uHits.length; k += 2) {
          const uStart = uHits[k];
          const uEnd = uHits[k + 1];
          if (uEnd - uStart > spanU * 0.015) {
            // Draw short 45° hatch ticks across [uStart, uEnd] at vScan
            const stepU = spanU / 32;
            const tickH = Math.min((spanV / numScanlines) * 0.48, stepU * 0.48);
            for (let uTick = uStart + tickH; uTick < uEnd - tickH; uTick += stepU) {
              const pA = toScreen(uTick - tickH, vScan - tickH);
              const pB = toScreen(uTick + tickH, vScan + tickH);
              ctx.moveTo(pA.x, pA.y);
              ctx.lineTo(pB.x, pB.y);
            }
          }
        }
      }
      ctx.stroke();

      // Draw bold section cut boundary edges
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      for (const seg of cutSegments) {
        const p1 = toScreen(seg.x1, seg.y1);
        const p2 = toScreen(seg.x2, seg.y2);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  } else {
    // 1. Standard Orthographic View: Render Hidden Edges first (thin dashed lines)
    if (hiddenEdges.length > 0 && hiddenEdges.length <= 1200) {
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 0.85;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const seg of hiddenEdges) {
        const p1 = toScreen(seg.x1, seg.y1);
        const p2 = toScreen(seg.x2, seg.y2);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. Render Visible Edges (continuous thick black/charcoal lines per ISO 128)
    ctx.save();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = visibleEdges.length > 4000 ? 1.15 : 1.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const seg of visibleEdges) {
      const p1 = toScreen(seg.x1, seg.y1);
      const p2 = toScreen(seg.x2, seg.y2);
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // 3. Draw Principal Symmetry & Verified Bore Centerlines (Chain-thin dash-dot line per ISO 128)
  ctx.save();
  ctx.strokeStyle = '#b91c1c';
  ctx.lineWidth = 0.85;
  ctx.setLineDash([12, 3.5, 2.5, 3.5]);
  ctx.beginPath();
  ctx.moveTo(viewCenter.x - halfPxW - 14, viewCenter.y);
  ctx.lineTo(viewCenter.x + halfPxW + 14, viewCenter.y);
  ctx.moveTo(viewCenter.x, viewCenter.y - halfPxH - 14);
  ctx.lineTo(viewCenter.x, viewCenter.y + halfPxH + 14);
  ctx.stroke();
  ctx.restore();

  // 4. Verified Holes ONLY: Draw centermarks or axial centerlines & at most 1 clean verified Ø callout
  // Never draw arbitrary synthetic circles! The mesh edges already show the real geometry.
  const verifiedHoles = features.filter(
    (f) => f.type === 'hole' && f.diameterMm && f.verificationConfidence !== 'Low'
  );
  let primaryHoleForCallout: {
    feat: CadFaceFeature;
    cx: number;
    cy: number;
    rPx: number;
    isEndOn: boolean;
  } | null = null;

  for (const vh of verifiedHoles) {
    const hAxis = new THREE.Vector3(...vh.normalOrAxis).normalize();
    const relC = new THREE.Vector3(...vh.centroid).sub(center);
    const cu = relC.dot(uAxis);
    const cv = relC.dot(vAxis);
    const rMm = (vh.diameterMm || 0) * 0.5;

    // Double-check boundary containment in this 2D projection so an impossible hole is NEVER drawn
    if (
      Math.abs(cu) + rMm > spanU * 0.52 ||
      Math.abs(cv) + rMm > spanV * 0.52
    ) {
      continue;
    }

    const cScreen = toScreen(cu, cv);
    const rPx = rMm * scale;
    const alignW = Math.abs(hAxis.dot(wAxis));

    if (alignW > 0.88) {
      // Bore axis points toward viewer (end-on circular bore in this view): draw clean centermark crosshair
      ctx.save();
      ctx.strokeStyle = '#b91c1c';
      ctx.lineWidth = 0.85;
      ctx.setLineDash([8, 3, 2, 3]);
      ctx.beginPath();
      ctx.moveTo(cScreen.x - rPx - 6, cScreen.y);
      ctx.lineTo(cScreen.x + rPx + 6, cScreen.y);
      ctx.moveTo(cScreen.x, cScreen.y - rPx - 6);
      ctx.lineTo(cScreen.x, cScreen.y + rPx + 6);
      ctx.stroke();
      ctx.restore();

      if (!primaryHoleForCallout || (vh.diameterMm || 0) > (primaryHoleForCallout.feat.diameterMm || 0)) {
        primaryHoleForCallout = { feat: vh, cx: cScreen.x, cy: cScreen.y, rPx, isEndOn: true };
      }
    } else if (alignW < 0.15) {
      // Bore axis lies in the projection plane: draw axial centerline along the bore depth
      const halfDepth = ((vh.depthOrLengthMm || spanU * 0.3) * 0.5) * 1.15;
      const du = hAxis.dot(uAxis) * halfDepth;
      const dv = hAxis.dot(vAxis) * halfDepth;
      const pA = toScreen(cu - du, cv - dv);
      const pB = toScreen(cu + du, cv + dv);

      ctx.save();
      ctx.strokeStyle = '#b91c1c';
      ctx.lineWidth = 0.85;
      ctx.setLineDash([10, 3, 2, 3]);
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 5. On Front View, draw Section Cutting Plane Line A —— A (vertical cutting plane through center)
  if (viewKind === 'front') {
    const cutTopY = viewCenter.y - halfPxH - 18;
    const cutBotY = viewCenter.y + halfPxH + 18;
    ctx.save();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([14, 4, 3, 4]);
    ctx.beginPath();
    ctx.moveTo(viewCenter.x, cutTopY);
    ctx.lineTo(viewCenter.x, cutBotY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Section viewing direction arrows pointing left (toward Right Side / Section A-A projection)
    ctx.fillStyle = '#0f172a';
    ctx.font = '700 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('A', viewCenter.x + 6, cutTopY + 4);
    ctx.fillText('A', viewCenter.x + 6, cutBotY - 4);
    ctx.restore();
  }

  // 6. Clean, Non-Overlapping Manufacturing Dimensions (Overall Envelope + Verified Bore Ø)
  const leftX = viewCenter.x - halfPxW;
  const rightX = viewCenter.x + halfPxW;
  const topY = viewCenter.y - halfPxH;
  const botY = viewCenter.y + halfPxH;

  // Horizontal Envelope Dimension below view
  drawTechnicalDimension(
    ctx,
    leftX,
    botY + 24,
    rightX,
    botY + 24,
    `${uDimName}: ${spanU.toFixed(2)}`,
    { x: leftX, y: botY + 4 },
    { x: rightX, y: botY + 4 },
    '#0f172a',
    paperBg
  );

  // Vertical Envelope Dimension to the left of view
  drawTechnicalDimension(
    ctx,
    leftX - 28,
    topY,
    leftX - 28,
    botY,
    `${vDimName}: ${spanV.toFixed(2)}`,
    { x: leftX - 4, y: topY },
    { x: leftX - 4, y: botY },
    '#0f172a',
    paperBg
  );

  // Verified Hole Leader Callout (only if an end-on verified hole exists in this view)
  if (primaryHoleForCallout && primaryHoleForCallout.isEndOn) {
    const { feat, cx, cy, rPx } = primaryHoleForCallout;
    const angle45 = -Math.PI * 0.25;
    const rimX = cx + rPx * Math.cos(angle45);
    const rimY = cy + rPx * Math.sin(angle45);
    const elbowX = Math.min(bx + bw - 110, Math.max(cx + rPx + 14, rightX + 12));
    const elbowY = Math.max(by + 42, topY - 10);
    drawVerifiedHoleLeader(
      ctx,
      rimX,
      rimY,
      elbowX,
      elbowY,
      `Ø${(feat.diameterMm || 0).toFixed(2)} (${feat.id})`,
      paperBg
    );
  }

  ctx.restore();
}

/**
 * Draws the standard ISO 5456-2 / ASME Y14.3 Third-Angle Projection symbol (circle to the left of truncated cone).
 */
function drawThirdAngleSymbol(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.save();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.3;

  // Centerlines
  ctx.save();
  ctx.strokeStyle = '#b91c1c';
  ctx.lineWidth = 0.8;
  ctx.setLineDash([6, 2, 2, 2]);
  ctx.beginPath();
  ctx.moveTo(cx - 34, cy);
  ctx.lineTo(cx + 34, cy);
  ctx.moveTo(cx - 16, cy - 14);
  ctx.lineTo(cx - 16, cy + 14);
  ctx.stroke();
  ctx.restore();

  // Concentric circles on the left (Front view of cone)
  ctx.beginPath();
  ctx.arc(cx - 16, cy, 5.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - 16, cy, 10.5, 0, Math.PI * 2);
  ctx.stroke();

  // Truncated cone on the right (Right side view of cone)
  ctx.beginPath();
  ctx.moveTo(cx + 4, cy - 5.5);
  ctx.lineTo(cx + 26, cy - 10.5);
  ctx.lineTo(cx + 26, cy + 10.5);
  ctx.lineTo(cx + 4, cy + 5.5);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * Renders the Master ASME Y14.3 / ISO 128 Third-Angle Manufacturing 2D Engineering Drawing Sheet (`1600×1120`):
 * - Strictly aligned Third-Angle Projection:
 *   - Top-Left: TOP VIEW (Plan View, aligned vertically above Front View)
 *   - Bottom-Left: FRONT VIEW (End / Outlet Elevation looking down outlet axis)
 *   - Bottom-Right: RIGHT SIDE ELEVATION (Longitudinal Profile, aligned horizontally with Front View)
 *   - Top-Right: SECTION A-A (Longitudinal Cross-Section View with 45° ANSI cross-hatching)
 * - Standard ASME / ISO Engineering Title Block at Bottom with Third-Angle symbol, Units, Scale,
 *   and explicit disclosure of MISSING specifications (Material, Tolerances, Surface Finish).
 */
function render2DCadBlueprintDiagram(
  edges: TopologicalEdge3D[],
  triangles: MeshTriangle3D[],
  overallBox: THREE.Box3,
  basis: PrincipalAxesBasis,
  features: CadFaceFeature[],
  metadata: CadFileMetadata | undefined,
  dimensions: CadDimensionRow[] | undefined,
  partName: string,
  versionNumber: number
): string {
  const sheetW = 1600;
  const sheetH = 1120;
  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d')!;

  // Clean ISO/ASME Technical Drawing Sheet Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, sheetW, sheetH);

  // Double Engineering Drawing Sheet Border with Zone Ticks
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(16, 16, sheetW - 32, sheetH - 32);
  ctx.lineWidth = 1;
  ctx.strokeRect(24, 24, sheetW - 48, sheetH - 48);

  const margin = 32;
  const titleBlockH = 96;
  const gap = 16;
  const gridW = sheetW - margin * 2;
  const gridH = sheetH - margin * 2 - titleBlockH - gap;
  const boxW = Math.floor((gridW - gap) / 2);
  const boxH = Math.floor((gridH - gap) / 2);

  // Conventional Third-Angle Projection Layout:
  // Top-Left: TOP VIEW (directly above Front View, looking from +Z)
  // Bottom-Left: FRONT VIEW (looking from -Y)
  // Bottom-Right: SIDE VIEW (directly to the right of Front View, looking from +X)
  // Top-Right: SECTION VIEW (Internal Cross-Section View along Plane A-A)
  const topViewRect = { x: margin, y: margin, w: boxW, h: boxH };
  const sectionViewRect = { x: margin + boxW + gap, y: margin, w: boxW, h: boxH };
  const frontViewRect = { x: margin, y: margin + boxH + gap, w: boxW, h: boxH };
  const sideViewRect = { x: margin + boxW + gap, y: margin + boxH + gap, w: boxW, h: boxH };

  // Compute a single UNIFIED drawing scale across all 4 views so Front, Top, Side, and Section
  // share 100% identical scale and true Third-Angle projection alignment!
  const availBoxW = boxW - 140;
  const availBoxH = boxH - 28 - 108;
  const maxHorizSpan = Math.max(basis.spanCross, basis.spanLong, 1);
  const maxVertSpan = Math.max(basis.spanVert, basis.spanLong, 1);
  const unifiedScale = Math.min(availBoxW / maxHorizSpan, availBoxH / maxVertSpan) * 0.78;

  const leftColCenterX = topViewRect.x + topViewRect.w * 0.5;
  const rightColCenterX = sideViewRect.x + sideViewRect.w * 0.5;
  const topRowCenterY = topViewRect.y + 28 + (topViewRect.h - 28) * 0.5;
  const botRowCenterY = frontViewRect.y + 28 + (frontViewRect.h - 28) * 0.5;

  // Render Top View (Top-Left)
  renderCleanEngineeringView(
    ctx,
    'top',
    topViewRect,
    'TOP VIEW',
    `${basis.crossLabel} × ${basis.longLabel} · ALIGNED ABOVE FRONT VIEW`,
    edges,
    triangles,
    overallBox,
    basis,
    features,
    unifiedScale,
    { x: leftColCenterX, y: topRowCenterY }
  );

  // Render Front View (Bottom-Left)
  renderCleanEngineeringView(
    ctx,
    'front',
    frontViewRect,
    'FRONT VIEW',
    `${basis.crossLabel} × ${basis.vertLabel} · FRONT PROJECTION`,
    edges,
    triangles,
    overallBox,
    basis,
    features,
    unifiedScale,
    { x: leftColCenterX, y: botRowCenterY }
  );

  // Render Side View (Bottom-Right, aligned horizontally with Front View)
  renderCleanEngineeringView(
    ctx,
    'side',
    sideViewRect,
    'SIDE VIEW',
    `${basis.longLabel} × ${basis.vertLabel} · ALIGNED WITH FRONT VIEW`,
    edges,
    triangles,
    overallBox,
    basis,
    features,
    unifiedScale,
    { x: rightColCenterX, y: botRowCenterY }
  );

  // Render Section View (Top-Right)
  renderCleanEngineeringView(
    ctx,
    'section',
    sectionViewRect,
    'SECTION VIEW',
    '45° ANSI HATCHED CUT ALONG PLANE A—A',
    edges,
    triangles,
    overallBox,
    basis,
    features,
    unifiedScale,
    { x: rightColCenterX, y: topRowCenterY }
  );

  // Draw subtle Third-Angle Projection Alignment Rays between Front <-> Top and Front <-> Side
  const halfCrossPx = (basis.spanCross * unifiedScale) * 0.5;
  const halfVertPx = (basis.spanVert * unifiedScale) * 0.5;
  ctx.save();
  ctx.strokeStyle = 'rgba(100, 116, 139, 0.35)';
  ctx.lineWidth = 0.85;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  // Vertical alignment lines connecting Front View and Top View
  ctx.moveTo(leftColCenterX - halfCrossPx, topViewRect.y + topViewRect.h - 18);
  ctx.lineTo(leftColCenterX - halfCrossPx, frontViewRect.y + 34);
  ctx.moveTo(leftColCenterX + halfCrossPx, topViewRect.y + topViewRect.h - 18);
  ctx.lineTo(leftColCenterX + halfCrossPx, frontViewRect.y + 34);
  // Horizontal alignment lines connecting Front View and Side View
  ctx.moveTo(frontViewRect.x + frontViewRect.w - 18, botRowCenterY - halfVertPx);
  ctx.lineTo(sideViewRect.x + 18, botRowCenterY - halfVertPx);
  ctx.moveTo(frontViewRect.x + frontViewRect.w - 18, botRowCenterY + halfVertPx);
  ctx.lineTo(sideViewRect.x + 18, botRowCenterY + halfVertPx);
  ctx.stroke();
  ctx.restore();

  // Standard ASME Y14.100 / ISO 7200 Engineering Title Block at Bottom
  const tbY = sheetH - margin - titleBlockH;
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(margin, tbY, gridW, titleBlockH);
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.8;
  ctx.strokeRect(margin, tbY, gridW, titleBlockH);

  // Internal Title Block Cell Dividers
  const col1X = margin + 170; // Third-Angle Symbol cell
  const col2X = margin + 740; // Drawing Title & Envelope cell
  const col3X = margin + 1160; // Material & Tolerances cell
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(col1X, tbY);
  ctx.lineTo(col1X, tbY + titleBlockH);
  ctx.moveTo(col2X, tbY);
  ctx.lineTo(col2X, tbY + titleBlockH);
  ctx.moveTo(col3X, tbY);
  ctx.lineTo(col3X, tbY + titleBlockH);
  ctx.moveTo(col1X, tbY + 48);
  ctx.lineTo(margin + gridW, tbY + 48);
  ctx.stroke();

  // Cell 1: Third-Angle Projection Symbol & Label
  drawThirdAngleSymbol(ctx, margin + 85, tbY + 34);
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 9.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('THIRD-ANGLE PROJECTION', margin + 85, tbY + 68);
  ctx.fillStyle = '#475569';
  ctx.font = '500 9px "JetBrains Mono", monospace';
  ctx.fillText('ASME Y14.3 / ISO 5456-2', margin + 85, tbY + 82);

  // Cell 2 Top: Drawing Title & Part Name
  ctx.fillStyle = '#475569';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText('PART / DRAWING TITLE:', col1X + 12, tbY + 15);
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 13.5px "JetBrains Mono", monospace';
  ctx.fillText(partName.slice(0, 44), col1X + 12, tbY + 34);

  // Cell 2 Bottom: Units, Scale, Envelope
  const size = new THREE.Vector3();
  overallBox.getSize(size);
  const solidVol = dimensions?.find((d) => d.id === 'DIM-VOL-CM3')?.value.toFixed(2) || '—';
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  ctx.fillText(
    `UNITS: mm (MILLIMETERS)  |  ENVELOPE: ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} mm`,
    col1X + 12,
    tbY + 66
  );
  ctx.fillStyle = '#475569';
  ctx.font = '500 9.5px "JetBrains Mono", monospace';
  ctx.fillText(
    `CAD FORMAT: ${metadata?.format || 'CAD'} (${metadata?.schemaVersion || '3D Solid'})  |  NET SOLID VOL: ${solidVol} cm³`,
    col1X + 12,
    tbY + 83
  );

  // Cell 3 Top: Material Specification (Never invent if missing)
  ctx.fillStyle = '#475569';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.fillText('MATERIAL SPECIFICATION:', col2X + 12, tbY + 15);
  const matDeclared = metadata?.materialDeclared;
  ctx.fillStyle = matDeclared ? '#0f172a' : '#b91c1c';
  ctx.font = '700 11px "JetBrains Mono", monospace';
  ctx.fillText(
    matDeclared ? matDeclared.slice(0, 34) : 'MISSING (NOT SPECIFIED IN CAD FILE)',
    col2X + 12,
    tbY + 34
  );

  // Cell 3 Bottom: Tolerances & Surface Finish (Never invent if missing)
  ctx.fillStyle = '#475569';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.fillText('TOLERANCES & SURFACE FINISH (GD&T / Ra):', col2X + 12, tbY + 63);
  ctx.fillStyle = '#b91c1c';
  ctx.font = '700 10.5px "JetBrains Mono", monospace';
  ctx.fillText('MISSING IN CAD FILE — DO NOT ASSUME', col2X + 12, tbY + 81);

  // Cell 4 Top: Revision & Verification Status
  ctx.fillStyle = '#475569';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.fillText('REV / VERIFICATION STATUS:', col3X + 12, tbY + 15);
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 11px "JetBrains Mono", monospace';
  ctx.fillText(`REV v${versionNumber} · VERIFIED GEOMETRY ONLY`, col3X + 12, tbY + 34);

  // Cell 4 Bottom: Cost & Diagnostic Separation Note
  ctx.fillStyle = '#475569';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.fillText('MACHINING COST & DIAGNOSTICS:', col3X + 12, tbY + 63);
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 9.5px "JetBrains Mono", monospace';
  ctx.fillText('COST: MISSING SPEC · SEE ANALYSIS REPORT', col3X + 12, tbY + 81);

  return canvas.toDataURL('image/png');
}

/**
 * Generates a 2D Engineering Diagram Pictorial Guide image snippet (`visualSnippetDataUrl`) for every single row
 * in dimensions, strictly correlated with the Stage 1 2D Orthographic Diagrams.
 */
function populateDimensionPictorialSnippets(
  topoEdges: TopologicalEdge3D[],
  meshTriangles: MeshTriangle3D[],
  basis: PrincipalAxesBasis,
  components: CadComponentMeshData[],
  features: CadFaceFeature[],
  dimensions: CadDimensionRow[],
  overallBox: THREE.Box3
): void {
  if (!dimensions || dimensions.length === 0) return;

  const snipW = 420;
  const snipH = 270;
  const center = new THREE.Vector3();
  overallBox.getCenter(center);

  type OrthoSnippetView = 'front' | 'top' | 'side';
  const viewConfigs: Record<
    OrthoSnippetView,
    {
      title: string;
      uAxis: THREE.Vector3;
      vAxis: THREE.Vector3;
      wAxis: THREE.Vector3;
      spanU: number;
      spanV: number;
      uLabel: string;
      vLabel: string;
      canvas: HTMLCanvasElement;
      scale: number;
      viewCenter: { x: number; y: number };
    }
  > = {
    front: {
      title: 'FRONT VIEW',
      uAxis: basis.axisCross.clone(),
      vAxis: basis.axisVert.clone(),
      wAxis: basis.axisLong.clone(),
      spanU: basis.spanCross,
      spanV: basis.spanVert,
      uLabel: basis.crossLabel,
      vLabel: basis.vertLabel,
      canvas: document.createElement('canvas'),
      scale: 1,
      viewCenter: { x: snipW * 0.5, y: 28 + (snipH - 28) * 0.5 },
    },
    top: {
      title: 'TOP VIEW',
      uAxis: basis.axisCross.clone(),
      vAxis: basis.axisLong.clone().negate(),
      wAxis: basis.axisVert.clone(),
      spanU: basis.spanCross,
      spanV: basis.spanLong,
      uLabel: basis.crossLabel,
      vLabel: basis.longLabel,
      canvas: document.createElement('canvas'),
      scale: 1,
      viewCenter: { x: snipW * 0.5, y: 28 + (snipH - 28) * 0.5 },
    },
    side: {
      title: 'SIDE VIEW',
      uAxis: basis.axisLong.clone().negate(),
      vAxis: basis.axisVert.clone(),
      wAxis: basis.axisCross.clone(),
      spanU: basis.spanLong,
      spanV: basis.spanVert,
      uLabel: basis.longLabel,
      vLabel: basis.vertLabel,
      canvas: document.createElement('canvas'),
      scale: 1,
      viewCenter: { x: snipW * 0.5, y: 28 + (snipH - 28) * 0.5 },
    },
  };

  const padX = 68;
  const padY = 52;
  const availW = Math.max(80, snipW - padX * 2);
  const availH = Math.max(80, snipH - 28 - padY * 2);

  for (const vk of ['front', 'top', 'side'] as OrthoSnippetView[]) {
    const cfg = viewConfigs[vk];
    cfg.canvas.width = snipW;
    cfg.canvas.height = snipH;
    cfg.scale = Math.min(availW / cfg.spanU, availH / cfg.spanV) * 0.78;
    const vCtx = cfg.canvas.getContext('2d')!;
    renderCleanEngineeringView(
      vCtx,
      vk,
      { x: 0, y: 0, w: snipW, h: snipH },
      cfg.title,
      `${cfg.uLabel}=${cfg.spanU.toFixed(1)} × ${cfg.vLabel}=${cfg.spanV.toFixed(1)} mm`,
      topoEdges,
      meshTriangles,
      overallBox,
      basis,
      features,
      cfg.scale,
      cfg.viewCenter
    );
  }

  const featureMap = new Map<string, CadFaceFeature>();
  for (const f of features) {
    featureMap.set(f.id, f);
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = snipW;
  outCanvas.height = snipH;
  const ctx = outCanvas.getContext('2d')!;

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const rel = new THREE.Vector3();

  for (const dim of dimensions) {
    const feat = dim.linkedFeatureId ? featureMap.get(dim.linkedFeatureId) : undefined;

    let chosenKey: OrthoSnippetView = 'front';
    if (dim.id === 'DIM-ENV-X' || dim.id === 'DIM-ENV-Y' || dim.id === 'DIM-ENV-Z') {
      const targetLabel =
        dim.id === 'DIM-ENV-X' ? 'X' : dim.id === 'DIM-ENV-Y' ? 'Y' : 'Z';
      if (viewConfigs.front.uLabel === targetLabel || viewConfigs.front.vLabel === targetLabel) {
        chosenKey = 'front';
      } else if (viewConfigs.side.uLabel === targetLabel || viewConfigs.side.vLabel === targetLabel) {
        chosenKey = 'side';
      } else {
        chosenKey = 'top';
      }
    } else if (dim.id === 'DIM-ENV-DIAG' || dim.id === 'DIM-VOL-CM3' || dim.id === 'DIM-AREA-CM2') {
      chosenKey = dim.id === 'DIM-ENV-DIAG' ? 'top' : 'side';
    } else if (feat) {
      const fAxis = new THREE.Vector3(...feat.normalOrAxis).normalize();
      const dotFront = Math.abs(fAxis.dot(viewConfigs.front.wAxis));
      const dotTop = Math.abs(fAxis.dot(viewConfigs.top.wAxis));
      const dotSide = Math.abs(fAxis.dot(viewConfigs.side.wAxis));
      if (dotTop >= dotFront && dotTop >= dotSide) {
        chosenKey = 'top';
      } else if (dotSide >= dotFront && dotSide >= dotTop) {
        chosenKey = 'side';
      } else {
        chosenKey = 'front';
      }
    }

    const cfg = viewConfigs[chosenKey];
    const toScreen = (pt3D: THREE.Vector3) => {
      rel.subVectors(pt3D, center);
      const u = rel.dot(cfg.uAxis);
      const v = rel.dot(cfg.vAxis);
      return {
        x: cfg.viewCenter.x + u * cfg.scale,
        y: cfg.viewCenter.y - v * cfg.scale,
      };
    };

    ctx.clearRect(0, 0, snipW, snipH);
    ctx.drawImage(cfg.canvas, 0, 0);

    const halfPxW = (cfg.spanU * cfg.scale) / 2;
    const halfPxH = (cfg.spanV * cfg.scale) / 2;
    const leftX = cfg.viewCenter.x - halfPxW;
    const rightX = cfg.viewCenter.x + halfPxW;
    const topY = cfg.viewCenter.y - halfPxH;
    const botY = cfg.viewCenter.y + halfPxH;

    if (feat) {
      const comp = components[feat.componentIndex] || components[0];
      const highlightStroke =
        feat.type === 'hole'
          ? '#dc2626'
          : feat.type === 'boss'
            ? '#d97706'
            : feat.type === 'chamfer' || feat.type === 'fillet'
              ? '#7c3aed'
              : '#0284c7';
      const highlightFill =
        feat.type === 'hole'
          ? 'rgba(220, 38, 38, 0.24)'
          : feat.type === 'boss'
            ? 'rgba(217, 119, 6, 0.24)'
            : feat.type === 'chamfer' || feat.type === 'fillet'
              ? 'rgba(124, 58, 237, 0.24)'
              : 'rgba(2, 132, 199, 0.22)';

      let minPxX = Infinity,
        minPxY = Infinity,
        maxPxX = -Infinity,
        maxPxY = -Infinity;

      if (comp && feat.triangleIndices.length > 0) {
        const pos = comp.positions;
        const step = Math.max(1, Math.floor(feat.triangleIndices.length / 400));
        ctx.save();
        ctx.fillStyle = highlightFill;
        ctx.strokeStyle = highlightStroke;
        ctx.lineWidth = 1.4;
        ctx.beginPath();

        for (let i = 0; i < feat.triangleIndices.length; i += step) {
          const tIdx = feat.triangleIndices[i];
          const b = tIdx * 9;
          if (b + 8 >= pos.length) continue;
          vA.set(pos[b], pos[b + 1], pos[b + 2]);
          vB.set(pos[b + 3], pos[b + 4], pos[b + 5]);
          vC.set(pos[b + 6], pos[b + 7], pos[b + 8]);

          const p0 = toScreen(vA);
          const p1 = toScreen(vB);
          const p2 = toScreen(vC);

          minPxX = Math.min(minPxX, p0.x, p1.x, p2.x);
          minPxY = Math.min(minPxY, p0.y, p1.y, p2.y);
          maxPxX = Math.max(maxPxX, p0.x, p1.x, p2.x);
          maxPxY = Math.max(maxPxY, p0.y, p1.y, p2.y);

          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      const cent3D = new THREE.Vector3(...(feat.axisOrigin || feat.centroid));
      const cPx = toScreen(cent3D);
      const featureRadiusPx =
        (feat.type === 'hole' || feat.type === 'boss') && feat.radiusMm
          ? Math.max(8, feat.radiusMm * cfg.scale)
          : Number.isFinite(maxPxX - minPxX)
            ? Math.max(10, Math.min(46, Math.hypot(maxPxX - minPxX, maxPxY - minPxY) * 0.5))
            : 14;

      ctx.save();
      ctx.strokeStyle = highlightStroke;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(cPx.x, cPx.y, featureRadiusPx + 2, 0, Math.PI * 2);
      ctx.stroke();

      const badgeText = `${feat.id}: ${dim.formattedValue} ${dim.unit}`;
      ctx.font = '700 10.5px "JetBrains Mono", monospace';
      const tw = ctx.measureText(badgeText).width;
      const bannerY = cPx.y > snipH * 0.54 ? 44 : snipH - 18;
      const bannerX = Math.max(tw / 2 + 12, Math.min(snipW - tw / 2 - 12, cPx.x));

      ctx.beginPath();
      ctx.moveTo(cPx.x, cPx.y + (bannerY < cPx.y ? -(featureRadiusPx + 2) : featureRadiusPx + 2));
      ctx.lineTo(bannerX, bannerY);
      ctx.stroke();

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(bannerX - tw / 2 - 7, bannerY - 10, tw + 14, 20);
      ctx.strokeStyle = highlightStroke;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bannerX - tw / 2 - 7, bannerY - 10, tw + 14, 20);
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badgeText, bannerX, bannerY);
      ctx.restore();
    } else {
      const targetLabel =
        dim.id === 'DIM-ENV-X' ? 'X' : dim.id === 'DIM-ENV-Y' ? 'Y' : dim.id === 'DIM-ENV-Z' ? 'Z' : '';

      ctx.save();
      if (targetLabel && cfg.uLabel === targetLabel) {
        drawTechnicalDimension(
          ctx,
          leftX,
          botY + 24,
          rightX,
          botY + 24,
          `${targetLabel}: ${dim.formattedValue} mm`,
          { x: leftX, y: botY + 3 },
          { x: rightX, y: botY + 3 },
          '#dc2626',
          '#fef2f2'
        );
      } else if (targetLabel && cfg.vLabel === targetLabel) {
        drawTechnicalDimension(
          ctx,
          leftX - 28,
          topY,
          leftX - 28,
          botY,
          `${targetLabel}: ${dim.formattedValue} mm`,
          { x: leftX - 3, y: topY },
          { x: leftX - 3, y: botY },
          '#dc2626',
          '#fef2f2'
        );
      } else if (dim.id === 'DIM-ENV-DIAG') {
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 2.0;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(leftX, botY);
        ctx.lineTo(rightX, topY);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(2, 132, 199, 0.10)';
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 1.6;
        ctx.fillRect(leftX, topY, rightX - leftX, botY - topY);
        ctx.strokeRect(leftX, topY, rightX - leftX, botY - topY);
      }

      const label = `${dim.parameter}: ${dim.formattedValue} ${dim.unit}`;
      ctx.font = '700 10.5px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width;
      const bx = snipW / 2;
      const by = 43;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(bx - tw / 2 - 7, by - 10, tw + 14, 20);
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(bx - tw / 2 - 7, by - 10, tw + 14, 20);
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by);
      ctx.restore();
    }

    dim.visualSnippetDataUrl = outCanvas.toDataURL('image/png');
  }
}

/**
 * Renders a crystal-clear, camera-lit 3D Studio Part Photograph for a specific view
 * (Top View, Section View, Front View, Side View, or ISO View) with a clean header label
 * and coordinate axes indicator so the 3D part photograph matches the 2D CAD view 1:1.
 */
function renderStudio3DPhotographForView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  center: THREE.Vector3,
  maxDim: number,
  spanHoriz: number,
  spanVert: number,
  cameraDirFromCenter: THREE.Vector3,
  cameraUp: THREE.Vector3,
  headerLeft: string,
  headerRight: string,
  width: number,
  height: number,
  keyLight: THREE.DirectionalLight,
  fillLight: THREE.DirectionalLight,
  rimLight: THREE.DirectionalLight,
  sectionClipPlane?: THREE.Plane
): string {
  const dir = cameraDirFromCenter.clone().normalize();
  const up = cameraUp.clone().normalize();
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();

  // Position studio lights relative to the active camera so every view (Top, Section, Front, Side, ISO)
  // is brightly and clearly illuminated with crisp surface shading and edge definition!
  keyLight.position
    .copy(center)
    .addScaledVector(dir, maxDim * 2.4)
    .addScaledVector(up, maxDim * 1.1)
    .addScaledVector(right, maxDim * 0.9);
  fillLight.position
    .copy(center)
    .addScaledVector(dir, maxDim * 2.0)
    .addScaledVector(up, -maxDim * 0.8)
    .addScaledVector(right, -maxDim * 1.2);
  rimLight.position
    .copy(center)
    .addScaledVector(dir, -maxDim * 1.5)
    .addScaledVector(up, maxDim * 1.4);

  const aspect = width / height;
  const viewHalfH = Math.max((spanVert * 0.68), (spanHoriz * 0.68) / aspect, maxDim * 0.42);
  const orthoCam = new THREE.OrthographicCamera(
    -viewHalfH * aspect,
    viewHalfH * aspect,
    viewHalfH,
    -viewHalfH,
    0.1,
    maxDim * 25
  );
  orthoCam.up.copy(up);
  orthoCam.position.copy(center).addScaledVector(dir, maxDim * 4.0);
  orthoCam.lookAt(center);
  orthoCam.updateProjectionMatrix();

  if (sectionClipPlane) {
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = [sectionClipPlane];
  } else {
    renderer.localClippingEnabled = false;
    renderer.clippingPlanes = [];
  }

  scene.background = new THREE.Color(0x0f172a);
  renderer.render(scene, orthoCam);

  renderer.localClippingEnabled = false;
  renderer.clippingPlanes = [];

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const oCtx = outCanvas.getContext('2d')!;
  oCtx.drawImage(renderer.domElement, 0, 0);

  // Header strip on 3D photograph
  oCtx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  oCtx.fillRect(0, 0, width, 34);
  oCtx.strokeStyle = '#334155';
  oCtx.lineWidth = 1;
  oCtx.beginPath();
  oCtx.moveTo(0, 34);
  oCtx.lineTo(width, 34);
  oCtx.stroke();

  oCtx.fillStyle = '#f8fafc';
  oCtx.font = '700 12px "JetBrains Mono", monospace';
  oCtx.textAlign = 'left';
  oCtx.textBaseline = 'middle';
  oCtx.fillText(headerLeft, 14, 17);

  oCtx.fillStyle = '#fbbf24';
  oCtx.font = '600 10.5px "JetBrains Mono", monospace';
  oCtx.textAlign = 'right';
  oCtx.fillText(headerRight, width - 14, 17);

  return outCanvas.toDataURL('image/png');
}

/**
 * Generates both 2D CAD Engineering Views AND 3D Part Photographs for:
 * 1. `3d_photo` — Primary 3D Part Photograph (ISO Studio Render)
 * 2. `cad_2d_diagram` — Master Third-Angle 2D Engineering Drawing Sheet (Top View, Section View, Front View, Side View)
 * 3. `top` — Top View (2D CAD View + 3D Part Photograph from Top +Z)
 * 4. `section` — Section View (2D Cross-Section CAD View + 3D Cross-Section Part Photograph)
 * 5. `front` — Front View (2D CAD View + 3D Part Photograph from Front -Y)
 * 6. `side` — Side View (2D CAD View + 3D Part Photograph from Side +X)
 * 7. `isometric` — ISO View (3D Isometric Part Photograph)
 */
export async function renderOrthographicPartPhotographs(
  components: CadComponentMeshData[],
  features: CadFaceFeature[],
  partName: string,
  versionNumber: number,
  dimensions?: CadDimensionRow[],
  metadata?: CadFileMetadata
): Promise<PartPhotograph[]> {
  const width = 960;
  const height = 720;
  const isSoftwareGl = detectSoftwareWebGL();

  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  pmremGenerator.dispose();

  const hemiLight = new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 1.05);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfffbeb, 2.1);
  keyLight.position.set(130, -150, 190);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xbae6fd, 1.15);
  fillLight.position.set(-150, 110, 95);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xf8fafc, 1.25);
  rimLight.position.set(45, 165, -120);
  scene.add(rimLight);

  const modelGroup = new THREE.Group();
  const overallBox = new THREE.Box3();
  const disposables: Array<{ dispose: () => void }> = [];

  for (const comp of components) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(comp.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(comp.normals, 3));

    const vertCount = comp.positions.length / 3;
    const colors = new Float32Array(vertCount * 3);
    const baseColor = new THREE.Color(comp.colorHex || 0x94a3b8);
    const tempColor = new THREE.Color();

    let dominantFinish: SurfaceFinishType = 'default_metallic';
    const triCount = Math.floor(comp.positions.length / 9);
    for (let t = 0; t < triCount; t++) {
      const featIdx = comp.faceIdPerTriangle[t];
      const feat = featIdx >= 0 ? features[featIdx] : undefined;
      const finish = feat?.requiresMachiningHighlight
        ? 'machining_highlight'
        : feat?.surfaceFinish || 'default_metallic';
      if (finish !== 'default_metallic') dominantFinish = finish;

      const pbr = getFinishPbrParams(finish, comp.colorHex);
      tempColor.setHex(pbr.color);
      if (finish === 'default_metallic') tempColor.copy(baseColor);

      const vBase = t * 9;
      for (let k = 0; k < 9; k += 3) {
        colors[vBase + k] = tempColor.r;
        colors[vBase + k + 1] = tempColor.g;
        colors[vBase + k + 2] = tempColor.b;
      }
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();

    const pbrMain = getFinishPbrParams(dominantFinish, comp.colorHex);
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      metalness: pbrMain.metalness,
      roughness: pbrMain.roughness,
      clearcoat: pbrMain.clearcoat,
      envMapIntensity: 1.35,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    modelGroup.add(mesh);
    overallBox.expandByObject(mesh);

    const edgesGeom = new THREE.EdgesGeometry(geometry, 22);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x1e293b,
      transparent: true,
      opacity: 0.55,
    });
    const edgeLines = new THREE.LineSegments(edgesGeom, edgesMat);
    modelGroup.add(edgeLines);

    disposables.push(geometry, material, edgesGeom, edgesMat);
  }

  scene.add(modelGroup);

  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  overallBox.getCenter(center);
  overallBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 10);

  // Extract clean topological edges & triangles for standards-compliant 2D projection
  const { edges: topoEdges, triangles: meshTriangles } =
    extractTopologicalEdgesAndTriangles(components);
  const basis = determinePrincipalProjectionAxes(overallBox, features);

  const photographs: PartPhotograph[] = [];
  const compCanvas = document.createElement('canvas');
  compCanvas.width = width;
  compCanvas.height = height;
  const ctx = compCanvas.getContext('2d')!;

  // ---------------------------------------------------------------------------
  // Render 3D Part Photographs for ISO, Top, Section, Front, and Side Views
  // ---------------------------------------------------------------------------
  const isoPhoto3dDataUrl = renderStudio3DPhotographForView(
    renderer,
    scene,
    center,
    maxDim,
    maxDim,
    maxDim,
    new THREE.Vector3(1.1, -1.25, 0.88),
    new THREE.Vector3(0, 0, 1),
    'ISO VIEW — 3D PART PHOTOGRAPH',
    `3D ISOMETRIC · ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`,
    width,
    height,
    keyLight,
    fillLight,
    rimLight
  );

  const topPhoto3dDataUrl = renderStudio3DPhotographForView(
    renderer,
    scene,
    center,
    maxDim,
    basis.spanCross,
    basis.spanLong,
    new THREE.Vector3(0, 0, 1), // Strictly from the TOP (+Z looking down)
    new THREE.Vector3(0, 1, 0), // +Y is UP, +X is RIGHT (matches 2D Top View 100%)
    'TOP VIEW — 3D PART PHOTOGRAPH',
    `CAMERA: TOP (+Z) · ${basis.crossLabel}=${basis.spanCross.toFixed(2)} × ${basis.longLabel}=${basis.spanLong.toFixed(2)} mm`,
    width,
    height,
    keyLight,
    fillLight,
    rimLight
  );

  // 3D Section View Photograph: Clipped along central plane X = center.x, viewed from Side (+X)
  const sectionClipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), center.x);
  const sectionPhoto3dDataUrl = renderStudio3DPhotographForView(
    renderer,
    scene,
    center,
    maxDim,
    basis.spanLong,
    basis.spanVert,
    new THREE.Vector3(1, 0, 0), // Viewed from +X into the Plane A-A cross-section cut
    new THREE.Vector3(0, 0, 1), // +Z is UP, +Y is RIGHT (matches 2D Section View 100%)
    'SECTION VIEW — 3D PART PHOTOGRAPH (CUT PLANE A—A)',
    `INTERNAL 3D CROSS-SECTION CUT · ${basis.longLabel}=${basis.spanLong.toFixed(2)} × ${basis.vertLabel}=${basis.spanVert.toFixed(2)} mm`,
    width,
    height,
    keyLight,
    fillLight,
    rimLight,
    sectionClipPlane
  );

  const frontPhoto3dDataUrl = renderStudio3DPhotographForView(
    renderer,
    scene,
    center,
    maxDim,
    basis.spanCross,
    basis.spanVert,
    new THREE.Vector3(0, -1, 0), // Strictly from the FRONT (-Y looking toward +Y)
    new THREE.Vector3(0, 0, 1), // +Z is UP, +X is RIGHT (matches 2D Front View 100%)
    'FRONT VIEW — 3D PART PHOTOGRAPH',
    `CAMERA: FRONT (-Y) · ${basis.crossLabel}=${basis.spanCross.toFixed(2)} × ${basis.vertLabel}=${basis.spanVert.toFixed(2)} mm`,
    width,
    height,
    keyLight,
    fillLight,
    rimLight
  );

  const sidePhoto3dDataUrl = renderStudio3DPhotographForView(
    renderer,
    scene,
    center,
    maxDim,
    basis.spanLong,
    basis.spanVert,
    new THREE.Vector3(1, 0, 0), // Strictly from the SIDE (+X looking toward -X)
    new THREE.Vector3(0, 0, 1), // +Z is UP, +Y is RIGHT (matches 2D Side View 100%)
    'SIDE VIEW — 3D PART PHOTOGRAPH',
    `CAMERA: SIDE (+X) · ${basis.longLabel}=${basis.spanLong.toFixed(2)} × ${basis.vertLabel}=${basis.spanVert.toFixed(2)} mm`,
    width,
    height,
    keyLight,
    fillLight,
    rimLight
  );

  // ---------------------------------------------------------------------------
  // 1. Primary 3D Part Photograph (ISO Studio Render)
  // ---------------------------------------------------------------------------
  photographs.push({
    viewId: '3d_photo',
    title: '3D Part Photograph (ISO View)',
    orientationLabel: 'ISO VIEW — 3D PART PHOTOGRAPH',
    projection: 'Orthographic',
    cameraVector: [1.1, -1.25, 0.88],
    upVector: [0, 0, 1],
    dataUrl: isoPhoto3dDataUrl,
    photo3dDataUrl: isoPhoto3dDataUrl,
    renderEngine: 'Connected CAD Studio WebGL Renderer (Three.js PBR)',
    timestamp: new Date().toISOString(),
    resolution: `${width}×${height}`,
  });

  // ---------------------------------------------------------------------------
  // 2. Master Third-Angle 2D Manufacturing Engineering Drawing Sheet
  // ---------------------------------------------------------------------------
  const blueprintDataUrl = render2DCadBlueprintDiagram(
    topoEdges,
    meshTriangles,
    overallBox,
    basis,
    features,
    metadata,
    dimensions,
    partName,
    versionNumber
  );
  photographs.push({
    viewId: 'cad_2d_diagram',
    title: '2D Manufacturing Engineering Drawing (Third-Angle Projection)',
    orientationLabel: 'TOP VIEW · SECTION VIEW · FRONT VIEW · SIDE VIEW',
    projection: '2D CAD Blueprint',
    cameraVector: [0, 0, 1],
    upVector: [0, 1, 0],
    dataUrl: blueprintDataUrl,
    renderEngine: 'Connected CAD Studio WebGL Renderer (Three.js PBR)',
    timestamp: new Date().toISOString(),
    resolution: '1600×1120',
  });

  // ---------------------------------------------------------------------------
  // 3..6. Individual High-Resolution Views with BOTH 2D CAD View & 3D Part Photograph:
  // Top View, Section View, Front View, Side View
  // ---------------------------------------------------------------------------
  const individualViews: Array<{
    viewId: PartPhotograph['viewId'];
    viewKind: 'top' | 'section' | 'front' | 'side';
    title: string;
    header: string;
    sub: string;
    cameraVector: [number, number, number];
    upVector: [number, number, number];
    photo3dDataUrl: string;
  }> = [
    {
      viewId: 'top',
      viewKind: 'top',
      title: 'Top View',
      header: 'TOP VIEW',
      sub: `${basis.crossLabel} = ${basis.spanCross.toFixed(2)} mm × ${basis.longLabel} = ${basis.spanLong.toFixed(2)} mm`,
      cameraVector: [0, 0, 1],
      upVector: [0, 1, 0],
      photo3dDataUrl: topPhoto3dDataUrl,
    },
    {
      viewId: 'section',
      viewKind: 'section',
      title: 'Section View',
      header: 'SECTION VIEW',
      sub: `45° ANSI HATCHED CUT ALONG PLANE A—A`,
      cameraVector: [1, 0, 0],
      upVector: [0, 0, 1],
      photo3dDataUrl: sectionPhoto3dDataUrl,
    },
    {
      viewId: 'front',
      viewKind: 'front',
      title: 'Front View',
      header: 'FRONT VIEW',
      sub: `${basis.crossLabel} = ${basis.spanCross.toFixed(2)} mm × ${basis.vertLabel} = ${basis.spanVert.toFixed(2)} mm`,
      cameraVector: [0, -1, 0],
      upVector: [0, 0, 1],
      photo3dDataUrl: frontPhoto3dDataUrl,
    },
    {
      viewId: 'side',
      viewKind: 'side',
      title: 'Side View',
      header: 'SIDE VIEW',
      sub: `${basis.longLabel} = ${basis.spanLong.toFixed(2)} mm × ${basis.vertLabel} = ${basis.spanVert.toFixed(2)} mm`,
      cameraVector: [1, 0, 0],
      upVector: [0, 0, 1],
      photo3dDataUrl: sidePhoto3dDataUrl,
    },
  ];

  for (const iv of individualViews) {
    ctx.clearRect(0, 0, width, height);
    renderCleanEngineeringView(
      ctx,
      iv.viewKind,
      { x: 0, y: 0, w: width, h: height },
      iv.header,
      iv.sub,
      topoEdges,
      meshTriangles,
      overallBox,
      basis,
      features
    );

    photographs.push({
      viewId: iv.viewId,
      title: iv.title,
      orientationLabel: `${iv.header} (${iv.sub})`,
      projection: '2D CAD Blueprint',
      cameraVector: iv.cameraVector,
      upVector: iv.upVector,
      dataUrl: compCanvas.toDataURL('image/png'),
      photo3dDataUrl: iv.photo3dDataUrl,
      renderEngine: 'Connected CAD Studio WebGL Renderer (Three.js PBR)',
      timestamp: new Date().toISOString(),
      resolution: `${width}×${height}`,
    });
  }

  // ---------------------------------------------------------------------------
  // 7. ISO View
  // ---------------------------------------------------------------------------
  photographs.push({
    viewId: 'isometric',
    title: 'ISO View',
    orientationLabel: `ISO VIEW (${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} mm)`,
    projection: 'Orthographic',
    cameraVector: [1.1, -1.25, 0.88],
    upVector: [0, 0, 1],
    dataUrl: isoPhoto3dDataUrl,
    photo3dDataUrl: isoPhoto3dDataUrl,
    renderEngine: 'Connected CAD Studio WebGL Renderer (Three.js PBR)',
    timestamp: new Date().toISOString(),
    resolution: `${width}×${height}`,
  });

  // ---------------------------------------------------------------------------
  // Populate Pictorial Guide Snippets for every dimension row
  // ---------------------------------------------------------------------------
  if (dimensions && dimensions.length > 0) {
    populateDimensionPictorialSnippets(
      topoEdges,
      meshTriangles,
      basis,
      components,
      features,
      dimensions,
      overallBox
    );
  }

  for (const d of disposables) d.dispose();
  envTex.dispose();
  renderer.dispose();
  renderer.forceContextLoss();

  return photographs;
}
