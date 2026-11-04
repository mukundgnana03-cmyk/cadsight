import * as THREE from 'three';
import * as CFB from 'cfb';

export interface ExtractedCatiaFace {
  positions: number[]; // flat [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...] in mm
  normals: number[];   // flat [nx0,ny0,nz0, ...]
  bodyIndex: number;
  surfaceType?: 'PLANE' | 'CYLINDER' | 'CONE' | 'SPHERE' | 'TORUS' | 'FREEFORM' | 'MESH';
  colorHex?: number;
}

export interface CatiaExtractionResult {
  foundRealTessellation: boolean;
  faces: ExtractedCatiaFace[];
  totalTriangles: number;
  streamCount: number;
  zlibBlocksDecompressed: number;
  embeddedPreviewDataUrl: string | null;
  diagnosticSummary: string;
}

interface LogicalStream {
  name: string;
  bytes: Uint8Array;
}

const SW_GSSF_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00] as const;
const SW_ZLB_MAGIC = [
  0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2,
  0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99,
] as const;

function isValidCoord(v: number): boolean {
  if (!Number.isFinite(v)) return false;
  const abs = Math.abs(v);
  if (abs > 0 && abs < 1e-7) return false; // reject denormals / integer bit noise
  if (abs > 100000) return false; // 100m max in mm
  return true;
}

function isUnitNormal(nx: number, ny: number, nz: number, tol = 0.08): boolean {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return false;
  const lenSq = nx * nx + ny * ny + nz * nz;
  return Math.abs(lenSq - 1.0) <= tol;
}

function computeTriangleNormals(positions: number[]): number[] {
  const normals = new Array(positions.length).fill(0);
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i + 8 < positions.length; i += 9) {
    pA.set(positions[i], positions[i + 1], positions[i + 2]);
    pB.set(positions[i + 3], positions[i + 4], positions[i + 5]);
    pC.set(positions[i + 6], positions[i + 7], positions[i + 8]);
    ab.subVectors(pB, pA);
    ac.subVectors(pC, pA);
    n.crossVectors(ab, ac);
    const len = n.length();
    if (len > 1e-9) {
      n.divideScalar(len);
    } else {
      n.set(0, 0, 1);
    }
    for (let k = 0; k < 9; k += 3) {
      normals[i + k] = n.x;
      normals[i + k + 1] = n.y;
      normals[i + k + 2] = n.z;
    }
  }
  return normals;
}

function uint8ToBase64(slice: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let k = 0; k < slice.length; k += chunkSize) {
    const sub = slice.subarray(k, Math.min(slice.length, k + chunkSize));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

/**
 * Extracts embedded PNG (`PreviewPNG`) or JPEG (`FINJPL`) thumbnail from a binary buffer or stream.
 */
export function extractCatiaEmbeddedJpeg(bytes: Uint8Array): string | null {
  const len = bytes.byteLength;

  // 1. Check for PNG signature: 89 50 4E 47 0D 0A 1A 0A ... IEND (49 45 4E 44 AE 42 60 82)
  for (let i = 0; i < len - 32; i++) {
    if (
      bytes[i] === 0x89 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x4e &&
      bytes[i + 3] === 0x47 &&
      bytes[i + 4] === 0x0d &&
      bytes[i + 5] === 0x0a &&
      bytes[i + 6] === 0x1a &&
      bytes[i + 7] === 0x0a
    ) {
      const maxEnd = Math.min(len - 8, i + 2 * 1024 * 1024);
      for (let j = i + 32; j <= maxEnd; j++) {
        if (
          bytes[j] === 0x49 &&
          bytes[j + 1] === 0x45 &&
          bytes[j + 2] === 0x4e &&
          bytes[j + 3] === 0x44 &&
          bytes[j + 4] === 0xae &&
          bytes[j + 5] === 0x42 &&
          bytes[j + 6] === 0x60 &&
          bytes[j + 7] === 0x82
        ) {
          const pngSlice = bytes.subarray(i, j + 8);
          return `data:image/png;base64,${uint8ToBase64(pngSlice)}`;
        }
      }
    }
  }

  // 2. Check for JPEG SOI: FF D8 FF (E0 | E1 | DB | C0)
  for (let i = 0; i < len - 16; i++) {
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xd8 &&
      bytes[i + 2] === 0xff &&
      (bytes[i + 3] === 0xe0 ||
        bytes[i + 3] === 0xe1 ||
        bytes[i + 3] === 0xdb ||
        bytes[i + 3] === 0xc0)
    ) {
      const maxEnd = Math.min(len - 1, i + 524288);
      for (let j = i + 128; j < maxEnd; j++) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          const jpegSlice = bytes.subarray(i, j + 2);
          return `data:image/jpeg;base64,${uint8ToBase64(jpegSlice)}`;
        }
      }
    }
  }
  return null;
}

/**
 * Decompresses a raw DEFLATE or zlib-wrapped byte slice using the browser's DecompressionStream API.
 */
async function tryDecompressStream(
  slice: Uint8Array,
  preferredFormat: 'deflate' | 'deflate-raw' = 'deflate'
): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined' || slice.byteLength < 6) return null;
  const formats: Array<'deflate' | 'deflate-raw'> =
    preferredFormat === 'deflate-raw'
      ? ['deflate-raw', 'deflate']
      : ['deflate', 'deflate-raw'];

  for (const format of formats) {
    try {
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(slice)).catch(() => {});
      writer.close().catch(() => {});

      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
          if (total > 32 * 1024 * 1024) break;
        }
      }
      if (total >= 16) {
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        return merged;
      }
    } catch {
      // Ignore failed decompression candidate
    }
  }
  return null;
}

/**
 * Decodes a SolidWorks nibble-swapped ASCII block name (`((b & 0x0f) << 4) | (b >> 4)`).
 */
function decodeNibbleSwappedName(raw: Uint8Array): string | null {
  if (raw.byteLength === 0 || raw.byteLength > 512) return null;
  const out = new Uint8Array(raw.byteLength);
  for (let i = 0; i < raw.byteLength; i++) {
    const b = raw[i];
    const swapped = ((b & 0x0f) << 4) | ((b >> 4) & 0x0f);
    if (swapped < 0x20 || swapped >= 0x7f) return null;
    out[i] = swapped;
  }
  return new TextDecoder('ascii').decode(out);
}

function hasMagicAt(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > bytes.byteLength) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Unwraps SolidWorks `__ZLB` streams (`23 1d d5 71 da 81 48 a2 a8 58 98 b2 1b 89 ef 99`),
 * supporting both the single-frame compound wrapper and the chained-section Parasolid wrapper.
 */
async function unwrapSolidWorksZlbPayloads(
  bytes: Uint8Array,
  baseName: string
): Promise<LogicalStream[]> {
  const results: LogicalStream[] = [];
  const len = bytes.byteLength;
  if (len < 28) return results;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i <= len - 24; i++) {
    if (!hasMagicAt(bytes, i, SW_ZLB_MAGIC)) continue;

    const frameChunks: Uint8Array[] = [];
    let totalInflated = 0;
    let cursor = i + 16;

    while (cursor + 8 <= len) {
      const uncompSz = view.getUint32(cursor, true);
      const zlibSz = view.getUint32(cursor + 4, true);
      if (
        uncompSz === 0 ||
        uncompSz > 64 * 1024 * 1024 ||
        zlibSz === 0 ||
        cursor + 8 + zlibSz > len
      ) {
        break;
      }
      const memberSlice = bytes.subarray(cursor + 8, cursor + 8 + zlibSz);
      const inflated = await tryDecompressStream(memberSlice, 'deflate');
      if (!inflated || inflated.byteLength === 0) {
        break;
      }
      frameChunks.push(inflated);
      totalInflated += inflated.byteLength;
      cursor += 8 + zlibSz;
    }

    if (totalInflated > 0) {
      const merged = new Uint8Array(totalInflated);
      let writeOff = 0;
      for (const chunk of frameChunks) {
        merged.set(chunk, writeOff);
        writeOff += chunk.byteLength;
      }
      results.push({
        name: `${baseName}#ZLB@${i}`,
        bytes: merged,
      });
      i = Math.max(i, cursor - 1);
    }
  }

  return results;
}

/**
 * Unpacks Modern SolidWorks (2015+, GSSF) compressed blocks starting with marker `14 00 06 00 08 00`
 * and nibble-swapped member names (`Contents/DisplayLists__Zlb`, `Contents/Config-0-Partition`, `PreviewPNG`, etc.).
 */
async function unpackSolidWorksGssfBlocks(bytes: Uint8Array): Promise<LogicalStream[]> {
  const streams: LogicalStream[] = [];
  const len = bytes.byteLength;
  if (len < 40) return streams;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let i = 8;
  while (i <= len - 26) {
    if (!hasMagicAt(bytes, i, SW_GSSF_MARKER)) {
      i++;
      continue;
    }

    const crc = view.getUint32(i + 10, true);
    const compSz = view.getUint32(i + 14, true);
    const uncompSz = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 22, true);
    const extraLen = view.getUint16(i + 24, true);

    // Filter out §1.2 Cache-cell section-index grid entries where field@+10 == 2*L, field@+14 == L//2, field@+18 == L
    if (uncompSz > 0 && crc === uncompSz * 2 && compSz === Math.floor(uncompSz / 2)) {
      i += 26;
      continue;
    }

    const headerEnd = i + 26 + nameLen + extraLen;
    const payloadEnd = headerEnd + compSz;

    if (
      compSz > 0 &&
      uncompSz > 0 &&
      uncompSz <= 64 * 1024 * 1024 &&
      nameLen <= 512 &&
      payloadEnd <= len
    ) {
      const nameSlice = bytes.subarray(i + 26, i + 26 + nameLen);
      const decodedName = decodeNibbleSwappedName(nameSlice) || `SW_Block_${i}`;
      const compSlice = bytes.subarray(headerEnd, payloadEnd);
      const inflated = await tryDecompressStream(compSlice, 'deflate-raw');

      if (inflated && inflated.byteLength > 0) {
        streams.push({ name: decodedName, bytes: inflated });
        const zlbChildren = await unwrapSolidWorksZlbPayloads(inflated, decodedName);
        streams.push(...zlbChildren);
        i = payloadEnd;
        continue;
      }
    }

    i++;
  }

  return streams;
}

/**
 * Decodes SolidWorks `DisplayLists__Zlb` (`uoTempFaceTessData_c`) 6-descriptor face tessellation tables
 * per `cadmpeg` §8 specification:
 *   Descriptor 0: (item_size=4,  kind=8,   flags=2, count=N) -> List A strip lengths u32le[N]
 *   Descriptor 1: (item_size=12, kind=100, flags=2, count=C) -> Positions f32le[C*3] in METRES (× 1000 -> mm)
 *   Descriptor 2: (item_size=12, kind=100, flags=2, count=0|C) -> Normals f32le[count*3]
 *   Descriptor 3: (item_size=4,  kind=8,   flags=2, count=0|E) -> List B f32le
 *   Descriptor 4: (item_size=4,  kind=8,   flags=2, count=N) -> List C u32le[N] where ListC[i] == 2*ListA[i] - 2
 *   Descriptor 5: (item_size=1,  kind=8,   flags=2, count=0|E) -> List D u8
 */
export function extractSolidWorksDisplayListsFaces(
  bytes: Uint8Array,
  initialBodyIndex = 0
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  if (len < 96) return faces;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate `uoBodyPropInfo_c` class markers so multi-body parts separate into distinct bodyIndex groups
  const bodyMarker = new TextEncoder().encode('uoBodyPropInfo_c');
  const bodySplitOffsets: number[] = [];
  for (let i = 0; i <= len - bodyMarker.length; i++) {
    if (bytes[i] === bodyMarker[0] && hasMagicAt(bytes, i, Array.from(bodyMarker))) {
      bodySplitOffsets.push(i);
    }
  }

  const EXPECTED_DESC: ReadonlyArray<[number, number, number]> = [
    [4, 8, 2],
    [12, 100, 2],
    [12, 100, 2],
    [4, 8, 2],
    [4, 8, 2],
    [1, 8, 2],
  ];

  let at = 0;
  while (at <= len - 96) {
    // Fast check for Descriptor 0: item_size = 4, kind = 8, flags = 2
    if (
      bytes[at] !== 4 ||
      bytes[at + 1] !== 0 ||
      bytes[at + 2] !== 0 ||
      bytes[at + 3] !== 0 ||
      bytes[at + 4] !== 8 ||
      bytes[at + 5] !== 0 ||
      bytes[at + 6] !== 0 ||
      bytes[at + 7] !== 0 ||
      bytes[at + 8] !== 2 ||
      bytes[at + 9] !== 0 ||
      bytes[at + 10] !== 0 ||
      bytes[at + 11] !== 0
    ) {
      at++;
      continue;
    }

    // Walk all 6 descriptors and verify exact grammar
    let cursor = at;
    let validTable = true;
    const descRanges: Array<{ dataStart: number; dataEnd: number; count: number }> = [];

    for (let d = 0; d < 6; d++) {
      if (cursor + 16 > len) {
        validTable = false;
        break;
      }
      const itemSize = view.getUint32(cursor, true);
      const kind = view.getUint32(cursor + 4, true);
      const flags = view.getUint32(cursor + 8, true);
      const count = view.getUint32(cursor + 12, true);
      const [expSize, expKind, expFlags] = EXPECTED_DESC[d];

      if (itemSize !== expSize || kind !== expKind || flags !== expFlags || count > 2000000) {
        validTable = false;
        break;
      }
      const dataStart = cursor + 16;
      const dataEnd = dataStart + itemSize * count;
      if (dataEnd > len) {
        validTable = false;
        break;
      }
      descRanges.push({ dataStart, dataEnd, count });
      cursor = dataEnd;
    }

    if (!validTable) {
      at++;
      continue;
    }

    const stripCount = descRanges[0].count;
    const vertCount = descRanges[1].count;
    const normCount = descRanges[2].count;
    const countB = descRanges[3].count;
    const countC = descRanges[4].count;
    const countD = descRanges[5].count;

    if (
      stripCount === 0 ||
      vertCount < 3 ||
      (normCount !== 0 && normCount !== vertCount) ||
      (countC !== 0 && countC !== stripCount)
    ) {
      at++;
      continue;
    }

    // Read List A strip lengths and check consistency with C and E
    const strips: number[] = [];
    let sumVerts = 0;
    let sumEndpoints = 0;
    for (let s = 0; s < stripCount; s++) {
      const sLen = view.getUint32(descRanges[0].dataStart + s * 4, true);
      if (sLen < 3 || sLen > vertCount) {
        validTable = false;
        break;
      }
      strips.push(sLen);
      sumVerts += sLen;
      sumEndpoints += sLen * 2 - 2;
      if (countC === stripCount) {
        const cVal = view.getUint32(descRanges[4].dataStart + s * 4, true);
        if (cVal !== sLen * 2 - 2) {
          validTable = false;
          break;
        }
      }
    }

    if (
      !validTable ||
      sumVerts !== vertCount ||
      !((countB === 0 && countD === 0) || (countB === sumEndpoints && countD === sumEndpoints))
    ) {
      at++;
      continue;
    }

    // Check compact header (at - 8) or extended header (at - 40):
    // If the header explicitly states 0 triangles and 0 strips, skip superseded table
    if (at >= 8) {
      const hTri = view.getUint32(at - 8, true);
      const hStrip = view.getUint32(at - 4, true);
      if (hTri === 0 && hStrip === 0) {
        // Check if extended header at - 40 has matching non-zero counts
        let hasValidExtended = false;
        if (at >= 40) {
          const extTri = view.getUint32(at - 40, true);
          const extStrip = view.getUint32(at - 36, true);
          const extForm = view.getUint32(at - 32, true);
          if (extForm === 1 && extTri === vertCount - 2 * stripCount && extStrip === stripCount) {
            hasValidExtended = true;
          }
        }
        if (!hasValidExtended) {
          at = cursor;
          continue;
        }
      }
    }

    // Read vertices in METRES and convert × 1000.0 to MILLIMETRES
    const vertsMm = new Float32Array(vertCount * 3);
    const posStart = descRanges[1].dataStart;
    for (let v = 0; v < vertCount * 3; v++) {
      const valM = view.getFloat32(posStart + v * 4, true);
      if (!Number.isFinite(valM)) {
        validTable = false;
        break;
      }
      vertsMm[v] = valM * 1000.0;
    }

    if (!validTable) {
      at++;
      continue;
    }

    let norms: Float32Array | null = null;
    if (normCount === vertCount) {
      norms = new Float32Array(vertCount * 3);
      const normStart = descRanges[2].dataStart;
      for (let v = 0; v < vertCount * 3; v++) {
        const nVal = view.getFloat32(normStart + v * 4, true);
        if (!Number.isFinite(nVal)) {
          validTable = false;
          break;
        }
        norms[v] = nVal;
      }
    }

    if (!validTable) {
      at++;
      continue;
    }

    // Reconstruct triangles from the N strips
    const posOut: number[] = [];
    const normOut: number[] = [];
    let vCursor = 0;

    for (let s = 0; s < stripCount; s++) {
      const sLen = strips[s];
      for (let j = 0; j < sLen - 2; j++) {
        let i0 = vCursor + j;
        let i1 = vCursor + j + 1;
        let i2 = vCursor + j + 2;
        if (j % 2 === 1) {
          const tmp = i0;
          i0 = i1;
          i1 = tmp;
        }

        const ax = vertsMm[i0 * 3],
          ay = vertsMm[i0 * 3 + 1],
          az = vertsMm[i0 * 3 + 2];
        const bx = vertsMm[i1 * 3],
          by = vertsMm[i1 * 3 + 1],
          bz = vertsMm[i1 * 3 + 2];
        const cx = vertsMm[i2 * 3],
          cy = vertsMm[i2 * 3 + 1],
          cz = vertsMm[i2 * 3 + 2];

        // Skip zero-area degenerate strip connectors
        const abx = bx - ax,
          aby = by - ay,
          abz = bz - az;
        const acx = cx - ax,
          acy = cy - ay,
          acz = cz - az;
        const crossX = aby * acz - abz * acy;
        const crossY = abz * acx - abx * acz;
        const crossZ = abx * acy - aby * acx;
        const area2 = Math.hypot(crossX, crossY, crossZ);
        if (area2 < 1e-7) continue;

        if (norms) {
          const nx0 = norms[i0 * 3],
            ny0 = norms[i0 * 3 + 1],
            nz0 = norms[i0 * 3 + 2];
          const nx1 = norms[i1 * 3],
            ny1 = norms[i1 * 3 + 1],
            nz1 = norms[i1 * 3 + 2];
          const nx2 = norms[i2 * 3],
            ny2 = norms[i2 * 3 + 1],
            nz2 = norms[i2 * 3 + 2];
          const avgNx = nx0 + nx1 + nx2;
          const avgNy = ny0 + ny1 + ny2;
          const avgNz = nz0 + nz1 + nz2;
          const dot = crossX * avgNx + crossY * avgNy + crossZ * avgNz;
          if (dot < 0) {
            // Flip winding to match stored outward vertex normals
            posOut.push(bx, by, bz, ax, ay, az, cx, cy, cz);
            normOut.push(nx1, ny1, nz1, nx0, ny0, nz0, nx2, ny2, nz2);
          } else {
            posOut.push(ax, ay, az, bx, by, bz, cx, cy, cz);
            normOut.push(nx0, ny0, nz0, nx1, ny1, nz1, nx2, ny2, nz2);
          }
        } else {
          posOut.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        }
      }
      vCursor += sLen;
    }

    if (posOut.length >= 9) {
      let bodyIdx = initialBodyIndex;
      for (const splitOff of bodySplitOffsets) {
        if (splitOff < at) bodyIdx++;
      }
      faces.push({
        positions: posOut,
        normals: normOut.length === posOut.length ? normOut : computeTriangleNormals(posOut),
        bodyIndex: bodyIdx,
        surfaceType: 'MESH',
      });
    }

    at = cursor;
  }

  return faces;
}

/**
 * Extracts Parasolid binary XT (`PS\0\0` / `Config-0-Partition`) geometry carriers
 * (`00 1d` world points, `00 2d` B-spline control grids, and `00 32..00 36` compact analytic surfaces)
 * per `cadmpeg` §4 and §7 specifications (all coordinates in METRES × 1000 -> MILLIMETRES).
 */
export function extractParasolidBinaryFaces(
  bytes: Uint8Array,
  bodyIndex = 0
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  if (len < 64) return faces;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. Collect all `00 1d` world_point and world_point_tripled coordinates (in mm)
  const worldPointsMm: THREE.Vector3[] = [];
  const minBounds = new THREE.Vector3(Infinity, Infinity, Infinity);
  const maxBounds = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  for (let i = 0; i <= len - 40; i++) {
    if (bytes[i] !== 0x00 || bytes[i + 1] !== 0x1d) continue;
    const bodyStart = bytes[i + 2] === 0xff ? i + 3 : i + 2;
    if (bodyStart + 38 > len) continue;

    const attr = view.getUint16(bodyStart, false);
    if (attr <= 1 || attr > 0x7fff) continue;

    // Check bare form (xyz at bodyStart + 14) and tripled form (xyz at bodyStart + 18)
    const isTripled =
      bodyStart + 42 <= len &&
      bytes[bodyStart + 8] === 0x01 &&
      bytes[bodyStart + 11] === 0x01 &&
      bytes[bodyStart + 14] === 0x01 &&
      bytes[bodyStart + 17] === 0x01;
    const xyzOff = isTripled ? bodyStart + 18 : bodyStart + 14;
    if (xyzOff + 24 > len) continue;

    const xm = view.getFloat64(xyzOff, false);
    const ym = view.getFloat64(xyzOff + 8, false);
    const zm = view.getFloat64(xyzOff + 16, false);

    if (
      !Number.isFinite(xm) ||
      !Number.isFinite(ym) ||
      !Number.isFinite(zm) ||
      ( xm !== 0 && Math.abs(xm) < 1e-20 ) ||
      ( ym !== 0 && Math.abs(ym) < 1e-20 ) ||
      ( zm !== 0 && Math.abs(zm) < 1e-20 ) ||
      Math.abs(xm) > 500 ||
      Math.abs(ym) > 500 ||
      Math.abs(zm) > 500
    ) {
      continue;
    }

    const ptMm = new THREE.Vector3(xm * 1000.0, ym * 1000.0, zm * 1000.0);
    worldPointsMm.push(ptMm);
    minBounds.min(ptMm);
    maxBounds.max(ptMm);
  }

  // 2. Scan for compact analytic records (`00 32` plane, `00 33` cylinder, `00 34` cone, `00 35` sphere, `00 36` torus)
  const checkUnit3 = (v: number[], off: number) =>
    Math.abs(Math.hypot(v[off], v[off + 1], v[off + 2]) - 1.0) <= 1e-5;
  const checkOrtho = (v: number[], o1: number, o2: number) =>
    checkUnit3(v, o1) &&
    checkUnit3(v, o2) &&
    Math.abs(v[o1] * v[o2] + v[o1 + 1] * v[o2 + 1] + v[o1 + 2] * v[o2 + 2]) <= 1e-5;

  const spanBounds = new THREE.Vector3().subVectors(maxBounds, minBounds);
  const defaultSpan =
    worldPointsMm.length >= 2 && spanBounds.length() > 0.5 ? spanBounds.length() * 0.45 : 40.0;

  for (let i = 0; i <= len - 96; i++) {
    if (bytes[i] !== 0x00) continue;
    const tt = bytes[i + 1];
    if (tt < 0x32 || tt > 0x36) continue;

    const valCount =
      tt === 0x32 ? 9 : tt === 0x33 ? 10 : tt === 0x34 ? 12 : tt === 0x35 ? 10 : 11;
    const hdrStart = bytes[i + 2] === 0xff ? i + 3 : i + 2;

    // Try partition marker offset (hdrStart + 16) and deltas marker offset (hdrStart + 21)
    for (const markerRel of [16, 21]) {
      const markerOff = hdrStart + markerRel;
      const valStart = markerOff + 1;
      if (valStart + valCount * 8 > len) continue;
      const marker = bytes[markerOff];
      if (marker !== 0x2b && marker !== 0x2d) continue;

      const vals: number[] = [];
      let allFinite = true;
      for (let k = 0; k < valCount; k++) {
        const fv = view.getFloat64(valStart + k * 8, false);
        if (!Number.isFinite(fv) || Math.abs(fv) > 1e4) {
          allFinite = false;
          break;
        }
        vals.push(fv);
      }
      if (!allFinite) continue;

      if (tt === 0x33 && checkOrtho(vals, 3, 7) && vals[6] > 1e-5 && vals[6] < 50) {
        // Cylinder: origin[0..3], axis[3..6], radius[6], refdir[7..10]
        const origin = new THREE.Vector3(vals[0] * 1000, vals[1] * 1000, vals[2] * 1000);
        const axis = new THREE.Vector3(vals[3], vals[4], vals[5]).normalize();
        const R = vals[6] * 1000;
        const uVec = new THREE.Vector3(vals[7], vals[8], vals[9]).normalize();
        const vVec = new THREE.Vector3().crossVectors(axis, uVec).normalize();

        // Find axial extent from world points lying on this cylinder
        let hMin = Infinity;
        let hMax = -Infinity;
        for (const wp of worldPointsMm) {
          const rel = new THREE.Vector3().subVectors(wp, origin);
          const q = rel.dot(axis);
          const radDist = rel.clone().addScaledVector(axis, -q).length();
          if (Math.abs(radDist - R) <= Math.max(0.5, R * 0.05)) {
            if (q < hMin) hMin = q;
            if (q > hMax) hMax = q;
          }
        }
        if (!Number.isFinite(hMin) || !Number.isFinite(hMax) || hMax - hMin < 0.05) {
          hMin = -defaultSpan * 0.5;
          hMax = defaultSpan * 0.5;
        }

        const segs = 32;
        const posOut: number[] = [];
        for (let s = 0; s < segs; s++) {
          const a0 = (s / segs) * Math.PI * 2;
          const a1 = ((s + 1) / segs) * Math.PI * 2;
          const p00 = origin
            .clone()
            .addScaledVector(axis, hMin)
            .addScaledVector(uVec, R * Math.cos(a0))
            .addScaledVector(vVec, R * Math.sin(a0));
          const p10 = origin
            .clone()
            .addScaledVector(axis, hMin)
            .addScaledVector(uVec, R * Math.cos(a1))
            .addScaledVector(vVec, R * Math.sin(a1));
          const p11 = origin
            .clone()
            .addScaledVector(axis, hMax)
            .addScaledVector(uVec, R * Math.cos(a1))
            .addScaledVector(vVec, R * Math.sin(a1));
          const p01 = origin
            .clone()
            .addScaledVector(axis, hMax)
            .addScaledVector(uVec, R * Math.cos(a0))
            .addScaledVector(vVec, R * Math.sin(a0));

          if (marker === 0x2b) {
            posOut.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z);
            posOut.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
          } else {
            posOut.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p10.x, p10.y, p10.z);
            posOut.push(p00.x, p00.y, p00.z, p01.x, p01.y, p01.z, p11.x, p11.y, p11.z);
          }
        }
        faces.push({
          positions: posOut,
          normals: computeTriangleNormals(posOut),
          bodyIndex,
          surfaceType: 'CYLINDER',
        });
        break;
      } else if (tt === 0x35 && checkOrtho(vals, 4, 7) && vals[3] > 1e-5 && vals[3] < 50) {
        // Sphere: center[0..3], radius[3], axis[4..7], refdir[7..10]
        const cx = vals[0] * 1000;
        const cy = vals[1] * 1000;
        const cz = vals[2] * 1000;
        const R = vals[3] * 1000;
        const sphereGeom = new THREE.SphereGeometry(R, 28, 18);
        sphereGeom.translate(cx, cy, cz);
        const nonIdx = sphereGeom.toNonIndexed();
        const posOut = Array.from(nonIdx.getAttribute('position').array as Float32Array);
        faces.push({
          positions: posOut,
          normals: computeTriangleNormals(posOut),
          bodyIndex,
          surfaceType: 'SPHERE',
        });
        break;
      } else if (
        tt === 0x36 &&
        checkOrtho(vals, 3, 8) &&
        Math.abs(vals[6]) > 1e-5 &&
        vals[7] > 1e-5 &&
        vals[7] < 50
      ) {
        // Torus: center[0..3], axis[3..6], major_r[6], minor_r[7], refdir[8..11]
        const center = new THREE.Vector3(vals[0] * 1000, vals[1] * 1000, vals[2] * 1000);
        const axis = new THREE.Vector3(vals[3], vals[4], vals[5]).normalize();
        const majorR = Math.abs(vals[6]) * 1000;
        const minorR = vals[7] * 1000;
        const uVec = new THREE.Vector3(vals[8], vals[9], vals[10]).normalize();
        const vVec = new THREE.Vector3().crossVectors(axis, uVec).normalize();

        const uSegs = 32;
        const vSegs = 18;
        const posOut: number[] = [];
        for (let u = 0; u < uSegs; u++) {
          const u0 = (u / uSegs) * Math.PI * 2;
          const u1 = ((u + 1) / uSegs) * Math.PI * 2;
          for (let v = 0; v < vSegs; v++) {
            const v0 = (v / vSegs) * Math.PI * 2;
            const v1 = ((v + 1) / vSegs) * Math.PI * 2;
            const evalTorus = (angU: number, angV: number) => {
              const rRing = majorR + minorR * Math.cos(angV);
              return center
                .clone()
                .addScaledVector(uVec, rRing * Math.cos(angU))
                .addScaledVector(vVec, rRing * Math.sin(angU))
                .addScaledVector(axis, minorR * Math.sin(angV));
            };
            const p00 = evalTorus(u0, v0);
            const p10 = evalTorus(u1, v0);
            const p11 = evalTorus(u1, v1);
            const p01 = evalTorus(u0, v1);
            posOut.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z);
            posOut.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
          }
        }
        faces.push({
          positions: posOut,
          normals: computeTriangleNormals(posOut),
          bodyIndex,
          surfaceType: 'TORUS',
        });
        break;
      } else if (tt === 0x32 && checkOrtho(vals, 3, 6)) {
        // Plane: origin[0..3], normal[3..6], refdir[6..9]
        const origin = new THREE.Vector3(vals[0] * 1000, vals[1] * 1000, vals[2] * 1000);
        const normal = new THREE.Vector3(vals[3], vals[4], vals[5]).normalize();
        const uVec = new THREE.Vector3(vals[6], vals[7], vals[8]).normalize();
        const vVec = new THREE.Vector3().crossVectors(normal, uVec).normalize();

        // Collect coplanar world points within 0.05 mm of this plane
        const planeUVs: Array<[number, number]> = [];
        let uMin = Infinity,
          uMax = -Infinity,
          vMin = Infinity,
          vMax = -Infinity;
        for (const wp of worldPointsMm) {
          const rel = new THREE.Vector3().subVectors(wp, origin);
          if (Math.abs(rel.dot(normal)) <= 0.05) {
            const u = rel.dot(uVec);
            const v = rel.dot(vVec);
            planeUVs.push([u, v]);
            if (u < uMin) uMin = u;
            if (u > uMax) uMax = u;
            if (v < vMin) vMin = v;
            if (v > vMax) vMax = v;
          }
        }

        if (planeUVs.length >= 3 && uMax - uMin > 0.05 && vMax - vMin > 0.05) {
          const p00 = origin.clone().addScaledVector(uVec, uMin).addScaledVector(vVec, vMin);
          const p10 = origin.clone().addScaledVector(uVec, uMax).addScaledVector(vVec, vMin);
          const p11 = origin.clone().addScaledVector(uVec, uMax).addScaledVector(vVec, vMax);
          const p01 = origin.clone().addScaledVector(uVec, uMin).addScaledVector(vVec, vMax);
          const posOut =
            marker === 0x2b
              ? [
                  p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
                  p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z,
                ]
              : [
                  p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p10.x, p10.y, p10.z,
                  p00.x, p00.y, p00.z, p01.x, p01.y, p01.z, p11.x, p11.y, p11.z,
                ];
          faces.push({
            positions: posOut,
            normals: computeTriangleNormals(posOut),
            bodyIndex,
            surfaceType: 'PLANE',
          });
          break;
        }
      }
    }
  }

  return faces;
}

/**
 * Unpacks logical streams from a Dassault Systèmes V5_CFV2 container
 * using the exact extent descriptor table layout:
 *   ds + 0x0c: logical_stream_length (u32be)
 *   ds + 0x50: extent_count k (u32be)
 *   ds + 0x54: k * 20-byte extent records [phys_off:u32be, phys_len:u32be, log_len:u32be, log_off:u32be, trail:u32be]
 */
export function unpackV5Cfv2LogicalStreams(bytes: Uint8Array): LogicalStream[] {
  const streams: LogicalStream[] = [];
  const len = bytes.byteLength;
  if (len < 128) return streams;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find all "V5_CFV2\0" magic offsets (56 35 5F 43 46 56 32 00)
  const magicOffsets: number[] = [];
  for (let i = 0; i <= len - 64; i++) {
    if (
      bytes[i] === 0x56 &&
      bytes[i + 1] === 0x35 &&
      bytes[i + 2] === 0x5f &&
      bytes[i + 3] === 0x43 &&
      bytes[i + 4] === 0x46 &&
      bytes[i + 5] === 0x56 &&
      bytes[i + 6] === 0x32 &&
      bytes[i + 7] === 0x00
    ) {
      magicOffsets.push(i);
    }
  }

  const seenStreamSignatures = new Set<string>();

  for (const base of magicOffsets) {
    if (base + 16 > len) continue;
    const A = view.getUint32(base + 8, false);
    const B = view.getUint32(base + 12, false);
    const diroff = base + A;
    if (diroff <= base || diroff >= len - 0x60) continue;

    const scanEnd = Math.min(len - 0x68, diroff + Math.max(B, 131072));
    for (let ds = diroff; ds <= scanEnd; ds++) {
      const logicalLen = view.getUint32(ds + 0x0c, false);
      const k = view.getUint32(ds + 0x50, false);

      if (k < 1 || k > 4096 || logicalLen < 4 || logicalLen > len) continue;
      if (ds + 0x54 + k * 20 > len) continue;

      let sumLogLen = 0;
      let validExtents = true;
      const extents: Array<{ physOff: number; physLen: number }> = [];

      for (let e = 0; e < k; e++) {
        const extPos = ds + 0x54 + e * 20;
        const physOff = view.getUint32(extPos, false);
        const physLen = view.getUint32(extPos + 4, false);
        const logLen = view.getUint32(extPos + 8, false);
        const logOff = view.getUint32(extPos + 12, false);

        if (
          physLen === 0 ||
          physLen !== logLen ||
          logOff !== sumLogLen ||
          base + physOff + physLen > len
        ) {
          validExtents = false;
          break;
        }
        extents.push({ physOff: base + physOff, physLen });
        sumLogLen += logLen;
      }

      if (!validExtents || sumLogLen !== logicalLen) continue;

      const sig = `${base}:${extents[0].physOff}:${logicalLen}`;
      if (seenStreamSignatures.has(sig)) continue;
      seenStreamSignatures.add(sig);

      // Extract UTF-16LE name before ds (ending at ds - 3 with 00 00 00 at ds-3..ds)
      let streamName = `Stream_${streams.length}`;
      if (ds >= 12 && bytes[ds - 1] === 0 && bytes[ds - 2] === 0 && bytes[ds - 3] === 0) {
        let nameEnd = ds - 3;
        let nameStart = nameEnd;
        while (nameStart >= 2 && nameEnd - nameStart < 128) {
          const ch = view.getUint16(nameStart - 2, true);
          if (ch >= 0x20 && ch <= 0x7e) {
            nameStart -= 2;
          } else {
            break;
          }
        }
        if (nameEnd > nameStart) {
          const decoded = new TextDecoder('utf-16le', { fatal: false })
            .decode(bytes.subarray(nameStart, nameEnd))
            .replace(/\0/g, '')
            .trim();
          if (decoded.length >= 2) {
            streamName = decoded;
          }
        }
      }

      const out = new Uint8Array(logicalLen);
      let writeCursor = 0;
      for (const ext of extents) {
        out.set(bytes.subarray(ext.physOff, ext.physOff + ext.physLen), writeCursor);
        writeCursor += ext.physLen;
      }
      streams.push({ name: streamName, bytes: out });
      ds += 0x54 + k * 20 - 1;
    }
  }

  return streams;
}

/**
 * Decodes all `ff ff 02 00 01 ff` Indexed Visualization-Point Coordinate Tables (Mode 0 & Mode 1)
 * from a CATIA V5 stream (`MainDataStream` / `SceneGraph`).
 */
function extractVisuCoordinateTables(bytes: Uint8Array): Array<{
  offset: number;
  endOffset: number;
  entryCount: number;
  coords: Float32Array;
}> {
  const tables: Array<{
    offset: number;
    endOffset: number;
    entryCount: number;
    coords: Float32Array;
  }> = [];
  const len = bytes.byteLength;
  if (len < 32) return tables;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i <= len - 24; i++) {
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xff &&
      bytes[i + 2] === 0x02 &&
      bytes[i + 3] === 0x00 &&
      bytes[i + 4] === 0x01 &&
      bytes[i + 5] === 0xff
    ) {
      const entryCount = view.getUint32(i + 6, true);
      if (bytes[i + 10] !== 0xff) continue;
      const secondaryCount = view.getUint32(i + 11, true);
      if (
        entryCount < 3 ||
        entryCount > 500000 ||
        secondaryCount > entryCount + 16
      ) {
        continue;
      }
      if (bytes[i + 15] !== 0 || bytes[i + 16] !== 0 || bytes[i + 17] !== 0) continue;
      const mode = bytes[i + 18];

      if (mode === 1) {
        const coordStart = i + 19;
        const coordEnd = coordStart + entryCount * 12;
        if (coordEnd > len) continue;

        const coords = new Float32Array(entryCount * 3);
        let validCount = 0;
        for (let v = 0; v < entryCount; v++) {
          const x = view.getFloat32(coordStart + v * 12, true);
          const y = view.getFloat32(coordStart + v * 12 + 4, true);
          const z = view.getFloat32(coordStart + v * 12 + 8, true);
          if (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Number.isFinite(z) &&
            Math.abs(x) < 1e5 &&
            Math.abs(y) < 1e5 &&
            Math.abs(z) < 1e5
          ) {
            validCount++;
          }
          coords[v * 3] = x;
          coords[v * 3 + 1] = y;
          coords[v * 3 + 2] = z;
        }
        if (validCount >= entryCount * 0.9) {
          tables.push({
            offset: i,
            endOffset: coordEnd,
            entryCount,
            coords,
          });
          i = coordEnd - 1;
        }
      } else if (mode === 0) {
        // Mode 0: 2-bit prefix-compressed coordinates
        const ctrlLen = Math.ceil(entryCount / 4);
        const ctrlStart = i + 19;
        const sepOff = ctrlStart + ctrlLen;
        if (sepOff + 5 > len || bytes[sepOff] !== 0xff) continue;

        const scalarCount = view.getUint32(sepOff + 1, true);
        const scalarStart = sepOff + 5;
        const scalarEnd = scalarStart + scalarCount * 4;
        if (scalarCount === 0 || scalarCount > entryCount * 3 || scalarEnd > len) continue;

        for (const msbFirst of [false, true]) {
          const coords = new Float32Array(entryCount * 3);
          let sIdx = 0;
          let prevX = 0;
          let prevY = 0;
          let prevZ = 0;
          let ok = true;

          for (let h = 0; h < entryCount; h++) {
            const rawByte = bytes[ctrlStart + (h >> 2)];
            const shift = msbFirst ? 6 - 2 * (h & 3) : 2 * (h & 3);
            const code = h === 0 ? 0 : (rawByte >> shift) & 0x03;
            let x = prevX;
            let y = prevY;
            let z = prevZ;

            if (code === 0) {
              if (sIdx + 3 > scalarCount) {
                ok = false;
                break;
              }
              x = view.getFloat32(scalarStart + sIdx * 4, true);
              y = view.getFloat32(scalarStart + (sIdx + 1) * 4, true);
              z = view.getFloat32(scalarStart + (sIdx + 2) * 4, true);
              sIdx += 3;
            } else if (code === 1) {
              // repeat X, Y, Z
            } else if (code === 2) {
              if (sIdx + 1 > scalarCount) {
                ok = false;
                break;
              }
              z = view.getFloat32(scalarStart + sIdx * 4, true);
              sIdx += 1;
            } else {
              if (sIdx + 2 > scalarCount) {
                ok = false;
                break;
              }
              y = view.getFloat32(scalarStart + sIdx * 4, true);
              z = view.getFloat32(scalarStart + (sIdx + 1) * 4, true);
              sIdx += 2;
            }

            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
              ok = false;
              break;
            }
            coords[h * 3] = x;
            coords[h * 3 + 1] = y;
            coords[h * 3 + 2] = z;
            prevX = x;
            prevY = y;
            prevZ = z;
          }

          if (ok && sIdx === scalarCount) {
            tables.push({
              offset: i,
              endOffset: scalarEnd,
              entryCount,
              coords,
            });
            i = scalarEnd - 1;
            break;
          }
        }
      }
    }
  }

  return tables;
}

function readVarCount(
  bytes: Uint8Array,
  view: DataView,
  pos: number
): { val: number; next: number } | null {
  if (pos >= bytes.byteLength) return null;
  const b = bytes[pos];
  if (b < 0xff) {
    return { val: b, next: pos + 1 };
  }
  if (pos + 5 > bytes.byteLength) return null;
  const val = view.getUint32(pos + 1, true);
  return { val, next: pos + 5 };
}

/**
 * Extracts `01 <0x40 | mask>` Indexed Triangle-Mesh Trim Packets from a stream
 * and binds their handles against the decoded visualization coordinate table.
 */
function extractTrimPacketsFromStream(
  bytes: Uint8Array,
  coordTable: Float32Array,
  entryCount: number,
  bodyIndex: number
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let p = 0;
  while (p <= len - 10) {
    if (bytes[p] !== 0x01) {
      p++;
      continue;
    }
    const kind = bytes[p + 1];
    if ((kind & 0xf0) !== 0x40) {
      p++;
      continue;
    }
    const mask = kind & 0x0f;
    if ((mask & 0x07) === 0) {
      p++;
      continue;
    }

    let cur = p + 2;
    let A = 0;
    let B = 0;
    let C = 0;
    let validHeader = true;

    if ((mask & 0x07) === 0x02 && bytes[cur] === 0xff) {
      B = 2;
    } else {
      if (mask & 0x01) {
        const r = readVarCount(bytes, view, cur);
        if (!r || r.val === 0 || r.val > 100000) {
          validHeader = false;
        } else {
          A = r.val;
          cur = r.next;
        }
      }
      if (validHeader && (mask & 0x02)) {
        const r = readVarCount(bytes, view, cur);
        if (!r || r.val === 0 || r.val > 50000) {
          validHeader = false;
        } else {
          B = r.val;
          cur = r.next;
        }
      }
      if (validHeader && (mask & 0x04)) {
        const r = readVarCount(bytes, view, cur);
        if (!r || r.val === 0 || r.val > 50000) {
          validHeader = false;
        } else {
          C = r.val;
          cur = r.next;
        }
      }
    }

    if (!validHeader || cur + 5 > len || bytes[cur] !== 0xff) {
      p++;
      continue;
    }

    const N = view.getUint32(cur + 1, true);
    cur += 5;

    if (N < 3 || N > 300000 || N < 3 * A + 3 * (B + C)) {
      p++;
      continue;
    }

    let packetNormal: [number, number, number] | null = null;
    if (mask & 0x08) {
      if (cur + 12 > len) {
        p++;
        continue;
      }
      const nx = view.getFloat32(cur, true);
      const ny = view.getFloat32(cur + 4, true);
      const nz = view.getFloat32(cur + 8, true);
      if (!isUnitNormal(nx, ny, nz, 0.03)) {
        p++;
        continue;
      }
      packetNormal = [nx, ny, nz];
      cur += 12;
    }

    const numPrim = B + C;
    let K: number[] | null = null;
    let handleStart = cur;

    if (numPrim === 0) {
      if (3 * A === N) {
        K = [];
        handleStart = cur;
      }
    } else {
      let c1 = cur;
      const k1: number[] = [];
      let sum1 = 0;
      let ok1 = true;
      for (let i = 0; i < numPrim; i++) {
        const r = readVarCount(bytes, view, c1);
        if (!r || r.val < 3 || r.val > N) {
          ok1 = false;
          break;
        }
        k1.push(r.val);
        sum1 += r.val;
        c1 = r.next;
      }
      if (ok1 && 3 * A + sum1 === N) {
        K = k1;
        handleStart = c1;
      }

      if (!K && cur + numPrim * 2 <= len) {
        const k2: number[] = [];
        let sum2 = 0;
        let ok2 = true;
        for (let i = 0; i < numPrim; i++) {
          const kv = view.getUint16(cur + i * 2, false);
          if (kv < 3 || kv > N) {
            ok2 = false;
            break;
          }
          k2.push(kv);
          sum2 += kv;
        }
        if (ok2 && 3 * A + sum2 === N) {
          K = k2;
          handleStart = cur + numPrim * 2;
        }
      }

      if (!K && cur + numPrim * 4 <= len) {
        const k3: number[] = [];
        let sum3 = 0;
        let ok3 = true;
        for (let i = 0; i < numPrim; i++) {
          const kv = view.getUint32(cur + i * 4, true);
          if (kv < 3 || kv > N) {
            ok3 = false;
            break;
          }
          k3.push(kv);
          sum3 += kv;
        }
        if (ok3 && 3 * A + sum3 === N) {
          K = k3;
          handleStart = cur + numPrim * 4;
        }
      }
    }

    if (!K) {
      p++;
      continue;
    }

    const handleModes: Array<{ W: number; isLE: boolean }> = [
      { W: 2, isLE: false },
      { W: 2, isLE: true },
      { W: 1, isLE: false },
      { W: 3, isLE: false },
    ];

    let bestHandles: number[] | null = null;
    let bestScore = Infinity;
    let bytesAfterHandles = handleStart;

    for (const { W, isLE } of handleModes) {
      if (handleStart + N * W > len) continue;
      if (W === 1 && entryCount > 256) continue;

      const rawH: number[] = [];
      let minH = Infinity;
      let maxH = -Infinity;
      for (let i = 0; i < N; i++) {
        const off = handleStart + i * W;
        let h = 0;
        if (W === 1) {
          h = bytes[off];
        } else if (W === 2) {
          h = view.getUint16(off, isLE);
        } else {
          h = (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
        }
        rawH.push(h);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }

      let normalized: number[] | null = null;
      if (maxH < entryCount && minH >= 0) {
        normalized = rawH;
      } else if (maxH === entryCount && minH >= 1) {
        normalized = rawH.map((h) => h - 1);
      }

      if (!normalized) continue;

      let edgeSum = 0;
      const sampleLim = Math.min(normalized.length - 1, 32);
      for (let s = 0; s < sampleLim; s++) {
        const h0 = normalized[s] * 3;
        const h1 = normalized[s + 1] * 3;
        const dx = coordTable[h1] - coordTable[h0];
        const dy = coordTable[h1 + 1] - coordTable[h0 + 1];
        const dz = coordTable[h1 + 2] - coordTable[h0 + 2];
        edgeSum += Math.hypot(dx, dy, dz);
      }
      const avgEdge = sampleLim > 0 ? edgeSum / sampleLim : 0;
      const score = avgEdge * (W === 2 && !isLE ? 0.9 : 1.0);
      if (score < bestScore) {
        bestScore = score;
        bestHandles = normalized;
        bytesAfterHandles = handleStart + N * W;
      }
    }

    if (!bestHandles) {
      p++;
      continue;
    }

    const matchedHandles = bestHandles;
    const tris: Array<[number, number, number]> = [];
    let hCursor = 0;

    for (let t = 0; t < A; t++) {
      const i0 = matchedHandles[hCursor++];
      const i1 = matchedHandles[hCursor++];
      const i2 = matchedHandles[hCursor++];
      if (i0 !== i1 && i1 !== i2 && i0 !== i2) {
        tris.push([i0, i1, i2]);
      }
    }

    for (let s = 0; s < B; s++) {
      const sLen = K[s];
      for (let j = 0; j < sLen - 2; j++) {
        const i0 = matchedHandles[hCursor + j];
        const i1 = matchedHandles[hCursor + j + 1];
        const i2 = matchedHandles[hCursor + j + 2];
        if (i0 !== i1 && i1 !== i2 && i0 !== i2) {
          tris.push(j % 2 === 0 ? [i0, i1, i2] : [i1, i0, i2]);
        }
      }
      hCursor += sLen;
    }

    for (let f = 0; f < C; f++) {
      const fLen = K[B + f];
      const center = matchedHandles[hCursor];
      for (let j = 1; j < fLen - 1; j++) {
        const i1 = matchedHandles[hCursor + j];
        const i2 = matchedHandles[hCursor + j + 1];
        if (center !== i1 && i1 !== i2 && center !== i2) {
          tris.push([center, i1, i2]);
        }
      }
      hCursor += fLen;
    }

    if (tris.length > 0) {
      const posOut: number[] = [];
      for (const [a, b, c] of tris) {
        const ax = coordTable[a * 3],
          ay = coordTable[a * 3 + 1],
          az = coordTable[a * 3 + 2];
        const bx = coordTable[b * 3],
          by = coordTable[b * 3 + 1],
          bz = coordTable[b * 3 + 2];
        const cx = coordTable[c * 3],
          cy = coordTable[c * 3 + 1],
          cz = coordTable[c * 3 + 2];
        posOut.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }

      let normOut: number[];
      if (packetNormal) {
        const [nx, ny, nz] = packetNormal;
        normOut = new Array(posOut.length);
        for (let i = 0; i < posOut.length; i += 3) {
          normOut[i] = nx;
          normOut[i + 1] = ny;
          normOut[i + 2] = nz;
        }
      } else {
        normOut = computeTriangleNormals(posOut);
      }

      faces.push({
        positions: posOut,
        normals: normOut,
        bodyIndex,
        surfaceType: 'MESH',
      });
      p = bytesAfterHandles;
      continue;
    }

    p++;
  }

  return faces;
}

/**
 * Extracts SurfacicReps analytic surfaces (Plane 00 33 32, Cylinder 00 33 33, Cone 00 33 34,
 * Sphere 00 33 35) when a CATIA file is stored in B-Rep / SurfacicReps mode.
 */
function extractSurfacicRepsAndVertices(
  bytes: Uint8Array,
  bodyIndex = 0
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  if (len < 64) return faces;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 3; i <= len - 75; i++) {
    if (bytes[i] !== 0x00 || bytes[i + 2] !== 0x00 || bytes[i + 3] !== 0x33) continue;
    const plen = bytes[i + 1];
    const kind = bytes[i + 4];

    if (plen === 0x1a && kind === 0x33 && i + 70 <= len) {
      const gOff = i + 5;
      const px = view.getFloat32(gOff, false);
      const py = view.getFloat32(gOff + 4, false);
      const pz = view.getFloat32(gOff + 8, false);
      const ax = view.getFloat32(gOff + 12, false);
      const ay = view.getFloat32(gOff + 16, false);
      const signedR = view.getFloat32(gOff + 20, false);

      const bOff = gOff + 24;
      const uMin = view.getFloat32(bOff, true);
      const uMax = view.getFloat32(bOff + 4, true);
      const vMin = view.getFloat32(bOff + 8, true);
      const vMax = view.getFloat32(bOff + 12, true);
      const xMin = view.getFloat32(bOff + 16, true);
      const xMax = view.getFloat32(bOff + 20, true);
      const yMin = view.getFloat32(bOff + 24, true);
      const yMax = view.getFloat32(bOff + 28, true);
      const zMin = view.getFloat32(bOff + 32, true);
      const zMax = view.getFloat32(bOff + 36, true);
      const sign = view.getInt8(bOff + 40);

      const R = Math.abs(signedR);
      const azSq = 1.0 - ax * ax - ay * ay;
      if (
        R > 0.1 &&
        R < 10000 &&
        azSq >= -0.02 &&
        (sign === 1 || sign === -1) &&
        Number.isFinite(px) &&
        Number.isFinite(py) &&
        Number.isFinite(pz) &&
        xMax >= xMin &&
        yMax >= yMin &&
        zMax >= zMin &&
        vMax > vMin
      ) {
        const az = (signedR >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, azSq));
        const axis = new THREE.Vector3(ax, ay, az).normalize();
        const origin = new THREE.Vector3(px, py, pz);

        const ref = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const uVec = new THREE.Vector3().crossVectors(axis, ref).normalize();
        const vVec = new THREE.Vector3().crossVectors(axis, uVec).normalize();

        let theta0 = 0;
        let theta1 = Math.PI * 2;
        const uSpan = uMax - uMin;
        if (uSpan > 0.05 && uSpan < Math.PI * 2 * R * 0.98) {
          theta0 = uMin / R;
          theta1 = uMax / R;
        }
        const segs = 32;
        const posOut: number[] = [];
        const h0 = vMin;
        const h1 = vMax;

        for (let s = 0; s < segs; s++) {
          const a0 = theta0 + ((theta1 - theta0) * s) / segs;
          const a1 = theta0 + ((theta1 - theta0) * (s + 1)) / segs;

          const p00 = origin
            .clone()
            .addScaledVector(axis, h0)
            .addScaledVector(uVec, R * Math.cos(a0))
            .addScaledVector(vVec, R * Math.sin(a0));
          const p10 = origin
            .clone()
            .addScaledVector(axis, h0)
            .addScaledVector(uVec, R * Math.cos(a1))
            .addScaledVector(vVec, R * Math.sin(a1));
          const p11 = origin
            .clone()
            .addScaledVector(axis, h1)
            .addScaledVector(uVec, R * Math.cos(a1))
            .addScaledVector(vVec, R * Math.sin(a1));
          const p01 = origin
            .clone()
            .addScaledVector(axis, h1)
            .addScaledVector(uVec, R * Math.cos(a0))
            .addScaledVector(vVec, R * Math.sin(a0));

          if (sign >= 0) {
            posOut.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z);
            posOut.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
          } else {
            posOut.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p10.x, p10.y, p10.z);
            posOut.push(p00.x, p00.y, p00.z, p01.x, p01.y, p01.z, p11.x, p11.y, p11.z);
          }
        }

        faces.push({
          positions: posOut,
          normals: computeTriangleNormals(posOut),
          bodyIndex,
          surfaceType: 'CYLINDER',
        });
      }
    }

    if (plen === 0x12 && kind === 0x35 && i + 62 <= len) {
      const gOff = i + 5;
      const cx = view.getFloat32(gOff, false);
      const cy = view.getFloat32(gOff + 4, false);
      const cz = view.getFloat32(gOff + 8, false);
      const R = Math.abs(view.getFloat32(gOff + 12, false));
      const bOff = gOff + 16;
      const sign = view.getInt8(bOff + 40);

      if (
        R > 0.1 &&
        R < 10000 &&
        (sign === 1 || sign === -1) &&
        Number.isFinite(cx) &&
        Number.isFinite(cy) &&
        Number.isFinite(cz)
      ) {
        const sphereGeom = new THREE.SphereGeometry(R, 24, 16);
        sphereGeom.translate(cx, cy, cz);
        const nonIdx = sphereGeom.toNonIndexed();
        const posAttr = nonIdx.getAttribute('position');
        const posOut = Array.from(posAttr.array as Float32Array);
        faces.push({
          positions: posOut,
          normals: computeTriangleNormals(posOut),
          bodyIndex,
          surfaceType: 'SPHERE',
        });
      }
    }

    if (plen === 0x02 && kind === 0x32 && i + 46 <= len) {
      const bOff = i + 5;
      const xMin = view.getFloat32(bOff + 16, true);
      const xMax = view.getFloat32(bOff + 20, true);
      const yMin = view.getFloat32(bOff + 24, true);
      const yMax = view.getFloat32(bOff + 28, true);
      const zMin = view.getFloat32(bOff + 32, true);
      const zMax = view.getFloat32(bOff + 36, true);
      const sign = view.getInt8(bOff + 40);

      const dx = xMax - xMin;
      const dy = yMax - yMin;
      const dz = zMax - zMin;
      const diag = Math.hypot(dx, dy, dz);

      if (
        (sign === 1 || sign === -1) &&
        dx >= -1e-4 &&
        dy >= -1e-4 &&
        dz >= -1e-4 &&
        diag > 0.5 &&
        diag < 25000 &&
        Math.abs(xMin) < 50000 &&
        Math.abs(yMin) < 50000 &&
        Math.abs(zMin) < 50000
      ) {
        const posOut: number[] = [];
        if (dz <= Math.min(dx, dy) && dx > 0.1 && dy > 0.1) {
          const z = 0.5 * (zMin + zMax);
          posOut.push(xMin, yMin, z, xMax, yMin, z, xMax, yMax, z);
          posOut.push(xMin, yMin, z, xMax, yMax, z, xMin, yMax, z);
        } else if (dy <= Math.min(dx, dz) && dx > 0.1 && dz > 0.1) {
          const y = 0.5 * (yMin + yMax);
          posOut.push(xMin, y, zMin, xMax, y, zMin, xMax, y, zMax);
          posOut.push(xMin, y, zMin, xMax, y, zMax, xMin, y, zMax);
        } else if (dx <= Math.min(dy, dz) && dy > 0.1 && dz > 0.1) {
          const x = 0.5 * (xMin + xMax);
          posOut.push(x, yMin, zMin, x, yMax, zMin, x, yMax, zMax);
          posOut.push(x, yMin, zMin, x, yMax, zMax, x, yMin, zMax);
        }
        if (posOut.length >= 18) {
          faces.push({
            positions: posOut,
            normals: computeTriangleNormals(posOut),
            bodyIndex,
            surfaceType: 'PLANE',
          });
        }
      }
    }
  }

  return faces;
}

function parseConnectivityTable(
  view: DataView,
  connStart: number,
  V: number,
  isLE: boolean
): { triangles: Array<[number, number, number]>; bytesConsumed: number } | null {
  const len = view.byteLength;

  for (const padOffset of [0, 4, 8, 12, 16]) {
    const basePos = connStart + padOffset;
    if (basePos + 12 > len) continue;

    const res32 = tryParseConn32(view, basePos, V, isLE);
    if (res32 && res32.triangles.length > 0) {
      return {
        triangles: res32.triangles,
        bytesConsumed: padOffset + res32.bytesConsumed,
      };
    }

    const res16 = tryParseConn16(view, basePos, V, isLE);
    if (res16 && res16.triangles.length > 0) {
      return {
        triangles: res16.triangles,
        bytesConsumed: padOffset + res16.bytesConsumed,
      };
    }
  }

  return null;
}

function normalizeIndexList(rawIndices: number[], V: number): number[] | null {
  if (rawIndices.length === 0) return [];
  let allMult3 = true;
  let maxRaw = 0;
  for (let i = 0; i < rawIndices.length; i++) {
    const r = rawIndices[i];
    if (r < 0) return null;
    if (r % 3 !== 0) allMult3 = false;
    if (r > maxRaw) maxRaw = r;
  }

  if (allMult3 && maxRaw < 3 * V && (maxRaw >= V || V <= 4)) {
    return rawIndices.map((r) => r / 3);
  }
  if (maxRaw < V) {
    return rawIndices;
  }
  return null;
}

function tryParseConn32(
  view: DataView,
  pos: number,
  V: number,
  isLE: boolean
): { triangles: Array<[number, number, number]>; bytesConsumed: number } | null {
  const len = view.byteLength;
  if (pos + 4 > len) return null;

  let cur = pos;
  const rawTriHeader = view.getInt32(cur, isLE);
  if (rawTriHeader < 0 || rawTriHeader > V * 6) return null;
  cur += 4;

  let numTriIndices = rawTriHeader * 3;
  if (rawTriHeader > 0 && rawTriHeader % 3 === 0 && cur + rawTriHeader * 4 <= len) {
    const testVal = view.getInt32(cur, isLE);
    if (testVal < 0 || testVal >= 3 * V) return null;
  }
  if (cur + numTriIndices * 4 > len) {
    if (rawTriHeader % 3 === 0 && cur + rawTriHeader * 4 <= len) {
      numTriIndices = rawTriHeader;
    } else {
      return null;
    }
  }

  const rawTriIndices: number[] = [];
  for (let i = 0; i < numTriIndices; i++) {
    const idx = view.getInt32(cur, isLE);
    if (idx < 0 || idx >= 3 * V) return null;
    rawTriIndices.push(idx);
    cur += 4;
  }

  const triangles: Array<[number, number, number]> = [];
  const normTriIndices = normalizeIndexList(rawTriIndices, V);
  if (!normTriIndices) return null;
  for (let i = 0; i + 2 < normTriIndices.length; i += 3) {
    const a = normTriIndices[i];
    const b = normTriIndices[i + 1];
    const c = normTriIndices[i + 2];
    if (a !== b && b !== c && a !== c) {
      triangles.push([a, b, c]);
    }
  }

  if (cur + 4 <= len) {
    const nbStrips = view.getInt32(cur, isLE);
    if (nbStrips >= 0 && nbStrips <= V) {
      const stripStart = cur + 4;
      if (nbStrips === 0) {
        cur = stripStart;
      } else if (stripStart + nbStrips * 4 <= len) {
        const stripLens: number[] = [];
        let totalStripVerts = 0;
        let validStrips = true;
        for (let s = 0; s < nbStrips; s++) {
          const sl = view.getInt32(stripStart + s * 4, isLE);
          if (sl < 3 || sl > V + 2) {
            validStrips = false;
            break;
          }
          stripLens.push(sl);
          totalStripVerts += sl;
        }
        if (validStrips && stripStart + (nbStrips + totalStripVerts) * 4 <= len) {
          let idxCursor = stripStart + nbStrips * 4;
          const allStripRaw: number[] = [];
          for (let i = 0; i < totalStripVerts; i++) {
            const vIdx = view.getInt32(idxCursor, isLE);
            if (vIdx < 0 || vIdx >= 3 * V) {
              validStrips = false;
              break;
            }
            allStripRaw.push(vIdx);
            idxCursor += 4;
          }
          if (validStrips) {
            const normStrip = normalizeIndexList(allStripRaw, V);
            if (normStrip) {
              let offset = 0;
              for (const sl of stripLens) {
                for (let k = 0; k < sl - 2; k++) {
                  const i0 = normStrip[offset + k];
                  const i1 = normStrip[offset + k + 1];
                  const i2 = normStrip[offset + k + 2];
                  if (i0 !== i1 && i1 !== i2 && i0 !== i2) {
                    triangles.push(k % 2 === 0 ? [i0, i1, i2] : [i1, i0, i2]);
                  }
                }
                offset += sl;
              }
              cur = idxCursor;
            }
          }
        }
      }
    }
  }

  if (cur + 4 <= len) {
    const nbFans = view.getInt32(cur, isLE);
    if (nbFans > 0 && nbFans <= V) {
      const fanStart = cur + 4;
      if (fanStart + nbFans * 4 <= len) {
        const fanLens: number[] = [];
        let totalFanVerts = 0;
        let validFans = true;
        for (let f = 0; f < nbFans; f++) {
          const fl = view.getInt32(fanStart + f * 4, isLE);
          if (fl < 3 || fl > V + 2) {
            validFans = false;
            break;
          }
          fanLens.push(fl);
          totalFanVerts += fl;
        }
        if (validFans && fanStart + (nbFans + totalFanVerts) * 4 <= len) {
          let idxCursor = fanStart + nbFans * 4;
          const allFanRaw: number[] = [];
          for (let i = 0; i < totalFanVerts; i++) {
            const vIdx = view.getInt32(idxCursor, isLE);
            if (vIdx < 0 || vIdx >= 3 * V) {
              validFans = false;
              break;
            }
            allFanRaw.push(vIdx);
            idxCursor += 4;
          }
          if (validFans) {
            const normFan = normalizeIndexList(allFanRaw, V);
            if (normFan) {
              let offset = 0;
              for (const fl of fanLens) {
                const centerIdx = normFan[offset];
                for (let k = 1; k < fl - 1; k++) {
                  const i1 = normFan[offset + k];
                  const i2 = normFan[offset + k + 1];
                  if (centerIdx !== i1 && i1 !== i2 && centerIdx !== i2) {
                    triangles.push([centerIdx, i1, i2]);
                  }
                }
                offset += fl;
              }
              cur = idxCursor;
            }
          }
        }
      }
    }
  }

  if (triangles.length === 0) return null;
  return { triangles, bytesConsumed: cur - pos };
}

function tryParseConn16(
  view: DataView,
  pos: number,
  V: number,
  isLE: boolean
): { triangles: Array<[number, number, number]>; bytesConsumed: number } | null {
  const len = view.byteLength;
  if (pos + 2 > len) return null;

  let cur = pos;
  const nbTris = view.getUint16(cur, isLE);
  if (nbTris > V * 4) return null;
  cur += 2;

  const numTriIndices = nbTris * 3;
  if (cur + numTriIndices * 2 > len) return null;

  const rawTriIndices: number[] = [];
  for (let i = 0; i < numTriIndices; i++) {
    const idx = view.getUint16(cur, isLE);
    if (idx >= 3 * V) return null;
    rawTriIndices.push(idx);
    cur += 2;
  }

  const triangles: Array<[number, number, number]> = [];
  const normTriIndices = normalizeIndexList(rawTriIndices, V);
  if (!normTriIndices) return null;
  for (let i = 0; i + 2 < normTriIndices.length; i += 3) {
    const a = normTriIndices[i];
    const b = normTriIndices[i + 1];
    const c = normTriIndices[i + 2];
    if (a !== b && b !== c && a !== c) {
      triangles.push([a, b, c]);
    }
  }

  if (triangles.length === 0) return null;
  return { triangles, bytesConsumed: cur - pos };
}

function triangulateVerifiedFaceVertices(
  verts: Float32Array,
  V: number
): Array<[number, number, number]> {
  const tris: Array<[number, number, number]> = [];
  if (V === 3) {
    return [[0, 1, 2]];
  }
  if (V === 4) {
    return [
      [0, 1, 2],
      [0, 2, 3],
    ];
  }
  for (let i = 0; i < V - 2; i++) {
    const a = i;
    const b = i + 1;
    const c = i + 2;
    const ax = verts[a * 3],
      ay = verts[a * 3 + 1],
      az = verts[a * 3 + 2];
    const bx = verts[b * 3],
      by = verts[b * 3 + 1],
      bz = verts[b * 3 + 2];
    const cx = verts[c * 3],
      cy = verts[c * 3 + 1],
      cz = verts[c * 3 + 2];
    const d1 = Math.hypot(bx - ax, by - ay, bz - az);
    const d2 = Math.hypot(cx - bx, cy - by, cz - bz);
    const d3 = Math.hypot(ax - cx, ay - cy, az - cz);
    if (d1 > 1e-6 && d2 > 1e-6 && d3 > 1e-6) {
      tris.push(i % 2 === 0 ? [a, b, c] : [b, a, c]);
    }
  }
  return tris;
}

/**
 * Scans a binary buffer for CAT3DFaceGP and CAT3DPlanarFaceGP faces (used in CGR and CATVisuCont streams).
 */
export function scanStreamForCatiaFaces(
  bytes: Uint8Array,
  bodyIndex = 0
): ExtractedCatiaFace[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  const extractedFaces: ExtractedCatiaFace[] = [];

  for (const isLE of [false, true]) {
    let offset = 0;
    while (offset <= len - 40) {
      const nVertFloats = view.getInt32(offset, isLE);

      if (nVertFloats >= 9 && nVertFloats <= 105000 && nVertFloats % 3 === 0) {
        const V = nVertFloats / 3;
        const vertBytes = nVertFloats * 4;
        const vertStart = offset + 4;
        const vertEnd = vertStart + vertBytes;

        if (vertEnd + 16 <= len) {
          const x0 = view.getFloat32(vertStart, isLE);
          const y0 = view.getFloat32(vertStart + 4, isLE);
          const z0 = view.getFloat32(vertStart + 8, isLE);
          const xLast = view.getFloat32(vertEnd - 12, isLE);
          const yLast = view.getFloat32(vertEnd - 8, isLE);
          const zLast = view.getFloat32(vertEnd - 4, isLE);

          if (
            isValidCoord(x0) &&
            isValidCoord(y0) &&
            isValidCoord(z0) &&
            isValidCoord(xLast) &&
            isValidCoord(yLast) &&
            isValidCoord(zLast)
          ) {
            let normHeaderSize = 0;
            let hasPerVertexNormals = false;
            if (vertEnd + 4 + vertBytes <= len) {
              const nNormCandidate = view.getInt32(vertEnd, isLE);
              if (nNormCandidate === nVertFloats || nNormCandidate === V) {
                normHeaderSize = 4;
                hasPerVertexNormals = true;
              }
            }
            if (!hasPerVertexNormals && V >= 4 && vertEnd + vertBytes <= len) {
              const nx0 = view.getFloat32(vertEnd, isLE);
              const ny0 = view.getFloat32(vertEnd + 4, isLE);
              const nz0 = view.getFloat32(vertEnd + 8, isLE);
              const nx1 = view.getFloat32(vertEnd + 12, isLE);
              const ny1 = view.getFloat32(vertEnd + 16, isLE);
              const nz1 = view.getFloat32(vertEnd + 20, isLE);
              if (isUnitNormal(nx0, ny0, nz0, 0.04) && isUnitNormal(nx1, ny1, nz1, 0.04)) {
                normHeaderSize = 0;
                hasPerVertexNormals = true;
              }
            }

            if (hasPerVertexNormals) {
              const normStart = vertEnd + normHeaderSize;
              const normEnd = normStart + vertBytes;
              if (normEnd <= len) {
                let allValid = true;
                let minX = Infinity,
                  minY = Infinity,
                  minZ = Infinity;
                let maxX = -Infinity,
                  maxY = -Infinity,
                  maxZ = -Infinity;

                for (let i = 0; i < V; i++) {
                  const vOff = vertStart + i * 12;
                  const vx = view.getFloat32(vOff, isLE);
                  const vy = view.getFloat32(vOff + 4, isLE);
                  const vz = view.getFloat32(vOff + 8, isLE);
                  if (!isValidCoord(vx) || !isValidCoord(vy) || !isValidCoord(vz)) {
                    allValid = false;
                    break;
                  }
                  if (vx < minX) minX = vx;
                  if (vy < minY) minY = vy;
                  if (vz < minZ) minZ = vz;
                  if (vx > maxX) maxX = vx;
                  if (vy > maxY) maxY = vy;
                  if (vz > maxZ) maxZ = vz;

                  const nOff = normStart + i * 12;
                  const nx = view.getFloat32(nOff, isLE);
                  const ny = view.getFloat32(nOff + 4, isLE);
                  const nz = view.getFloat32(nOff + 8, isLE);
                  if (!isUnitNormal(nx, ny, nz, 0.06)) {
                    allValid = false;
                    break;
                  }
                }

                const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
                if (allValid && diag >= 1e-4 && diag <= 25000) {
                  const verts = new Float32Array(nVertFloats);
                  const norms = new Float32Array(nVertFloats);
                  for (let i = 0; i < nVertFloats; i++) {
                    verts[i] = view.getFloat32(vertStart + i * 4, isLE);
                    norms[i] = view.getFloat32(normStart + i * 4, isLE);
                  }

                  const conn = parseConnectivityTable(view, normEnd, V, isLE);
                  const tris = conn
                    ? conn.triangles
                    : triangulateVerifiedFaceVertices(verts, V);

                  if (tris.length > 0) {
                    const posOut: number[] = [];
                    const normOut: number[] = [];
                    for (const [a, b, c] of tris) {
                      posOut.push(
                        verts[a * 3],
                        verts[a * 3 + 1],
                        verts[a * 3 + 2],
                        verts[b * 3],
                        verts[b * 3 + 1],
                        verts[b * 3 + 2],
                        verts[c * 3],
                        verts[c * 3 + 1],
                        verts[c * 3 + 2]
                      );
                      normOut.push(
                        norms[a * 3],
                        norms[a * 3 + 1],
                        norms[a * 3 + 2],
                        norms[b * 3],
                        norms[b * 3 + 1],
                        norms[b * 3 + 2],
                        norms[c * 3],
                        norms[c * 3 + 1],
                        norms[c * 3 + 2]
                      );
                    }
                    extractedFaces.push({
                      positions: posOut,
                      normals: normOut,
                      bodyIndex,
                    });
                    offset = normEnd + (conn ? conn.bytesConsumed : 0);
                    continue;
                  }
                }
              }
            }

            let planarNormal: [number, number, number] | null = null;
            let connStartPlanar = vertEnd;

            if (offset >= 12) {
              const pnx = view.getFloat32(offset - 12, isLE);
              const pny = view.getFloat32(offset - 8, isLE);
              const pnz = view.getFloat32(offset - 4, isLE);
              if (isUnitNormal(pnx, pny, pnz, 0.03)) {
                planarNormal = [pnx, pny, pnz];
                connStartPlanar = vertEnd;
              }
            }
            if (!planarNormal && vertEnd + 12 <= len) {
              const pnx = view.getFloat32(vertEnd, isLE);
              const pny = view.getFloat32(vertEnd + 4, isLE);
              const pnz = view.getFloat32(vertEnd + 8, isLE);
              if (isUnitNormal(pnx, pny, pnz, 0.03)) {
                planarNormal = [pnx, pny, pnz];
                connStartPlanar = vertEnd + 12;
              } else if (vertEnd + 16 <= len) {
                const nCount = view.getInt32(vertEnd, isLE);
                if (nCount === 3 || nCount === 1) {
                  const nx2 = view.getFloat32(vertEnd + 4, isLE);
                  const ny2 = view.getFloat32(vertEnd + 8, isLE);
                  const nz2 = view.getFloat32(vertEnd + 12, isLE);
                  if (isUnitNormal(nx2, ny2, nz2, 0.03)) {
                    planarNormal = [nx2, ny2, nz2];
                    connStartPlanar = vertEnd + 16;
                  }
                }
              }
            }

            if (planarNormal && V >= 3) {
              const [nx, ny, nz] = planarNormal;
              let allCoplanar = true;
              let minX = Infinity,
                minY = Infinity,
                minZ = Infinity;
              let maxX = -Infinity,
                maxY = -Infinity,
                maxZ = -Infinity;

              for (let i = 0; i < V; i++) {
                const vOff = vertStart + i * 12;
                const vx = view.getFloat32(vOff, isLE);
                const vy = view.getFloat32(vOff + 4, isLE);
                const vz = view.getFloat32(vOff + 8, isLE);
                if (!isValidCoord(vx) || !isValidCoord(vy) || !isValidCoord(vz)) {
                  allCoplanar = false;
                  break;
                }
                const planeDist = Math.abs((vx - x0) * nx + (vy - y0) * ny + (vz - z0) * nz);
                if (planeDist > 0.04) {
                  allCoplanar = false;
                  break;
                }
                if (vx < minX) minX = vx;
                if (vy < minY) minY = vy;
                if (vz < minZ) minZ = vz;
                if (vx > maxX) maxX = vx;
                if (vy > maxY) maxY = vy;
                if (vz > maxZ) maxZ = vz;
              }

              const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
              if (allCoplanar && diag >= 1e-4 && diag <= 25000) {
                const conn = parseConnectivityTable(view, connStartPlanar, V, isLE);
                if (conn && conn.triangles.length > 0) {
                  const verts = new Float32Array(nVertFloats);
                  for (let i = 0; i < nVertFloats; i++) {
                    verts[i] = view.getFloat32(vertStart + i * 4, isLE);
                  }
                  const posOut: number[] = [];
                  const normOut: number[] = [];
                  for (const [a, b, c] of conn.triangles) {
                    posOut.push(
                      verts[a * 3],
                      verts[a * 3 + 1],
                      verts[a * 3 + 2],
                      verts[b * 3],
                      verts[b * 3 + 1],
                      verts[b * 3 + 2],
                      verts[c * 3],
                      verts[c * 3 + 1],
                      verts[c * 3 + 2]
                    );
                    normOut.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
                  }
                  extractedFaces.push({
                    positions: posOut,
                    normals: normOut,
                    bodyIndex,
                  });
                  offset = connStartPlanar + conn.bytesConsumed;
                  continue;
                }
              }
            }
          }
        }
      }
      offset += 1;
    }

    if (extractedFaces.length > 0) {
      break;
    }
  }

  return extractedFaces;
}

/**
 * Scans a decompressed Inventor / JT / CAD stream for interleaved 24-byte [vx, vy, vz, nx, ny, nz]
 * vertex-normal display lists.
 */
export function scanStreamForInterleavedDisplayList(
  bytes: Uint8Array,
  bodyIndex = 0
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  if (len < 76) return faces;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  while (offset <= len - 76) {
    const vCount = view.getInt32(offset, true);
    if (vCount >= 3 && vCount <= 50000 && offset + 4 + vCount * 24 <= len) {
      const dataStart = offset + 4;
      const x0 = view.getFloat32(dataStart, true);
      const y0 = view.getFloat32(dataStart + 4, true);
      const z0 = view.getFloat32(dataStart + 8, true);
      const nx0 = view.getFloat32(dataStart + 12, true);
      const ny0 = view.getFloat32(dataStart + 16, true);
      const nz0 = view.getFloat32(dataStart + 20, true);

      const lastOff = dataStart + (vCount - 1) * 24;
      const xL = view.getFloat32(lastOff, true);
      const yL = view.getFloat32(lastOff + 4, true);
      const zL = view.getFloat32(lastOff + 8, true);
      const nxL = view.getFloat32(lastOff + 12, true);
      const nyL = view.getFloat32(lastOff + 16, true);
      const nzL = view.getFloat32(lastOff + 20, true);

      if (
        isValidCoord(x0) &&
        isValidCoord(y0) &&
        isValidCoord(z0) &&
        isUnitNormal(nx0, ny0, nz0, 0.04) &&
        isValidCoord(xL) &&
        isValidCoord(yL) &&
        isValidCoord(zL) &&
        isUnitNormal(nxL, nyL, nzL, 0.04)
      ) {
        let allValid = true;
        const verts = new Float32Array(vCount * 3);
        const norms = new Float32Array(vCount * 3);
        for (let i = 0; i < vCount; i++) {
          const rec = dataStart + i * 24;
          const vx = view.getFloat32(rec, true);
          const vy = view.getFloat32(rec + 4, true);
          const vz = view.getFloat32(rec + 8, true);
          const nx = view.getFloat32(rec + 12, true);
          const ny = view.getFloat32(rec + 16, true);
          const nz = view.getFloat32(rec + 20, true);
          if (!isValidCoord(vx) || !isValidCoord(vy) || !isValidCoord(vz) || !isUnitNormal(nx, ny, nz, 0.06)) {
            allValid = false;
            break;
          }
          verts[i * 3] = vx;
          verts[i * 3 + 1] = vy;
          verts[i * 3 + 2] = vz;
          norms[i * 3] = nx;
          norms[i * 3 + 1] = ny;
          norms[i * 3 + 2] = nz;
        }

        if (allValid) {
          const tris: Array<[number, number, number]> = [];
          if (vCount % 3 === 0) {
            for (let i = 0; i + 2 < vCount; i += 3) {
              tris.push([i, i + 1, i + 2]);
            }
          } else {
            tris.push(...triangulateVerifiedFaceVertices(verts, vCount));
          }
          if (tris.length > 0) {
            const posOut: number[] = [];
            const normOut: number[] = [];
            for (const [a, b, c] of tris) {
              posOut.push(
                verts[a * 3],
                verts[a * 3 + 1],
                verts[a * 3 + 2],
                verts[b * 3],
                verts[b * 3 + 1],
                verts[b * 3 + 2],
                verts[c * 3],
                verts[c * 3 + 1],
                verts[c * 3 + 2]
              );
              normOut.push(
                norms[a * 3],
                norms[a * 3 + 1],
                norms[a * 3 + 2],
                norms[b * 3],
                norms[b * 3 + 1],
                norms[b * 3 + 2],
                norms[c * 3],
                norms[c * 3 + 1],
                norms[c * 3 + 2]
              );
            }
            faces.push({
              positions: posOut,
              normals: normOut,
              bodyIndex,
            });
            offset = dataStart + vCount * 24;
            continue;
          }
        }
      }
    }
    offset++;
  }
  return faces;
}

/**
 * Parses Dassault 3DXML (<Positions> and <Triangles>) or 3MF (<vertices> and <triangles>) XML text if present.
 */
export function parse3dxmlText(xmlText: string): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const repRegex = /<PolygonalRep[\s\S]*?<\/PolygonalRep>/gi;
  let repMatch: RegExpExecArray | null;
  let bodyIdx = 0;

  while ((repMatch = repRegex.exec(xmlText)) !== null) {
    const repBlock = repMatch[0];
    const posMatch = repBlock.match(/<Positions[^>]*>([\s\S]*?)<\/Positions>/i);
    if (!posMatch) continue;

    const coords = posMatch[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    if (coords.length < 9) continue;

    const triRegex = /<Triangles[^>]*triangles="([^"]+)"/gi;
    let tm: RegExpExecArray | null;
    const posOut: number[] = [];

    while ((tm = triRegex.exec(repBlock)) !== null) {
      const indices = tm[1]
        .trim()
        .split(/[\s,]+/)
        .map((s) => parseInt(s, 10))
        .filter(Number.isFinite);
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i] * 3;
        const b = indices[i + 1] * 3;
        const c = indices[i + 2] * 3;
        if (c + 2 < coords.length && a >= 0 && b >= 0 && c >= 0) {
          posOut.push(
            coords[a],
            coords[a + 1],
            coords[a + 2],
            coords[b],
            coords[b + 1],
            coords[b + 2],
            coords[c],
            coords[c + 1],
            coords[c + 2]
          );
        }
      }
    }

    if (posOut.length >= 9) {
      faces.push({
        positions: posOut,
        normals: computeTriangleNormals(posOut),
        bodyIndex: bodyIdx++,
      });
    }
  }

  // Also check for 3MF <mesh><vertices><vertex x="" y="" z=""/>...</vertices><triangles><triangle v1="" v2="" v3=""/>...</triangles></mesh>
  const meshRegex = /<mesh[\s\S]*?<\/mesh>/gi;
  let mMatch: RegExpExecArray | null;
  while ((mMatch = meshRegex.exec(xmlText)) !== null) {
    const meshBlock = mMatch[0];
    const verts: Array<[number, number, number]> = [];
    const vRegex = /<vertex\s+[^>]*x="([^"]+)"[^>]*y="([^"]+)"[^>]*z="([^"]+)"/gi;
    let vm: RegExpExecArray | null;
    while ((vm = vRegex.exec(meshBlock)) !== null) {
      verts.push([parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3])]);
    }
    if (verts.length < 3) continue;

    const posOut: number[] = [];
    const tRegex = /<triangle\s+[^>]*v1="(\d+)"[^>]*v2="(\d+)"[^>]*v3="(\d+)"/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tRegex.exec(meshBlock)) !== null) {
      const i1 = parseInt(tm[1], 10);
      const i2 = parseInt(tm[2], 10);
      const i3 = parseInt(tm[3], 10);
      if (i1 < verts.length && i2 < verts.length && i3 < verts.length) {
        posOut.push(
          verts[i1][0],
          verts[i1][1],
          verts[i1][2],
          verts[i2][0],
          verts[i2][1],
          verts[i2][2],
          verts[i3][0],
          verts[i3][1],
          verts[i3][2]
        );
      }
    }
    if (posOut.length >= 9) {
      faces.push({
        positions: posOut,
        normals: computeTriangleNormals(posOut),
        bodyIndex: bodyIdx++,
      });
    }
  }

  return faces;
}

/**
 * Unpacks Siemens NX `SPLMSSTR` directory streams (`/Root/UG_PART/UG_PART`, `/Root/FastLoad/JT`, `/Root/images/preview`, etc.)
 * per `cadmpeg` `docs/formats/siemens_nx.md` §2 specification.
 */
function unpackSplmsstrStreams(bytes: Uint8Array): LogicalStream[] {
  const streams: LogicalStream[] = [];
  const len = bytes.byteLength;
  if (len < 64) return streams;
  if (
    bytes[0] !== 0x53 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x4d ||
    bytes[4] !== 0x53 ||
    bytes[5] !== 0x53 ||
    bytes[6] !== 0x54 ||
    bytes[7] !== 0x52
  ) {
    return streams;
  }
  if (
    bytes[0x19] !== 0x48 ||
    bytes[0x1a] !== 0x45 ||
    bytes[0x1b] !== 0x41 ||
    bytes[0x1c] !== 0x44 ||
    bytes[0x1d] !== 0x45 ||
    bytes[0x1e] !== 0x52
  ) {
    return streams;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint32(0x1f, true);
  if (entryCount < 1 || entryCount > 2048) return streams;

  let pos = 0x23;
  for (let i = 0; i < entryCount; i++) {
    if (pos + 4 > len) break;
    const nameLen = view.getUint32(pos, true);
    pos += 4;
    if (nameLen < 1 || nameLen > 256 || pos + nameLen + 16 > len) break;
    const name = new TextDecoder('ascii', { fatal: false }).decode(
      bytes.subarray(pos, pos + nameLen)
    );
    pos += nameLen;
    const fileOff = view.getUint32(pos, true);
    const fileOffHi = view.getUint32(pos + 4, true);
    const fileSize = view.getUint32(pos + 8, true);
    const fileSizeHi = view.getUint32(pos + 12, true);
    pos += 16;

    if (
      fileOffHi === 0 &&
      fileSizeHi === 0 &&
      fileSize >= 16 &&
      fileOff + fileSize <= len
    ) {
      streams.push({
        name: name || `SPLMSSTR_${i}`,
        bytes: bytes.subarray(fileOff, fileOff + fileSize),
      });
    }
  }

  return streams;
}

/**
 * Extracts Autodesk Inventor `PmGraphics` pre-tessellated B-Rep faces from an inflated RSe `B<token>` bulk stream:
 *   Vertex header: `[0x30000002:u32le, V:u32le, V:u32le, 0x00000123:u32le]` + `V * 3` f32le coordinates (in mm)
 *   Index header:  `[0x30000002:u32le, I:u32le, I:u32le, 0x00000000:u32le]` + `I` u32le 0-based vertex indices (`I % 3 === 0`)
 *   Normal header: `[0x30000002:u32le, N:u32le, N:u32le, 0x0000012a:u32le]` + `N * 3` f32le unit normals (optional)
 */
export function extractInventorPmGraphicsFaces(
  bytes: Uint8Array,
  bodyIndex = 0
): ExtractedCatiaFace[] {
  const faces: ExtractedCatiaFace[] = [];
  const len = bytes.byteLength;
  if (len < 48) return faces;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i <= len - 48; i++) {
    if (
      bytes[i] !== 0x02 ||
      bytes[i + 1] !== 0x00 ||
      bytes[i + 2] !== 0x00 ||
      bytes[i + 3] !== 0x30
    ) {
      continue;
    }
    if (view.getUint32(i + 12, true) !== 0x00000123) continue;

    const V = view.getUint32(i + 4, true);
    const V2 = view.getUint32(i + 8, true);
    if (V < 3 || V > 250000 || V !== V2) continue;

    const vertStart = i + 16;
    const idxHdr = vertStart + V * 12;
    if (idxHdr + 16 > len) continue;

    if (
      view.getUint32(idxHdr, true) !== 0x30000002 ||
      view.getUint32(idxHdr + 12, true) !== 0x00000000
    ) {
      continue;
    }

    const I = view.getUint32(idxHdr + 4, true);
    const I2 = view.getUint32(idxHdr + 8, true);
    if (I < 3 || I > 750000 || I % 3 !== 0 || I !== I2) continue;

    const idxStart = idxHdr + 16;
    const normHdr = idxStart + I * 4;
    if (normHdr > len) continue;

    // Optional normal table `[0x30000002, V, V, 0x0000012a]`
    let normStart = -1;
    let nextPos = normHdr;
    if (
      normHdr + 16 + V * 12 <= len &&
      view.getUint32(normHdr, true) === 0x30000002 &&
      view.getUint32(normHdr + 4, true) === V &&
      view.getUint32(normHdr + 8, true) === V &&
      view.getUint32(normHdr + 12, true) === 0x0000012a
    ) {
      normStart = normHdr + 16;
      nextPos = normStart + V * 12;
    }

    const posOut: number[] = [];
    const normOut: number[] = [];
    let validFace = true;

    for (let t = 0; t < I; t += 3) {
      const i0 = view.getUint32(idxStart + t * 4, true);
      const i1 = view.getUint32(idxStart + (t + 1) * 4, true);
      const i2 = view.getUint32(idxStart + (t + 2) * 4, true);
      if (i0 >= V || i1 >= V || i2 >= V) {
        validFace = false;
        break;
      }
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;

      const ax = view.getFloat32(vertStart + i0 * 12, true);
      const ay = view.getFloat32(vertStart + i0 * 12 + 4, true);
      const az = view.getFloat32(vertStart + i0 * 12 + 8, true);
      const bx = view.getFloat32(vertStart + i1 * 12, true);
      const by = view.getFloat32(vertStart + i1 * 12 + 4, true);
      const bz = view.getFloat32(vertStart + i1 * 12 + 8, true);
      const cx = view.getFloat32(vertStart + i2 * 12, true);
      const cy = view.getFloat32(vertStart + i2 * 12 + 4, true);
      const cz = view.getFloat32(vertStart + i2 * 12 + 8, true);

      if (
        !Number.isFinite(ax) ||
        !Number.isFinite(ay) ||
        !Number.isFinite(az) ||
        !Number.isFinite(bx) ||
        !Number.isFinite(by) ||
        !Number.isFinite(bz) ||
        !Number.isFinite(cx) ||
        !Number.isFinite(cy) ||
        !Number.isFinite(cz)
      ) {
        validFace = false;
        break;
      }

      posOut.push(ax, ay, az, bx, by, bz, cx, cy, cz);

      if (normStart >= 0) {
        for (const vi of [i0, i1, i2]) {
          normOut.push(
            view.getFloat32(normStart + vi * 12, true),
            view.getFloat32(normStart + vi * 12 + 4, true),
            view.getFloat32(normStart + vi * 12 + 8, true)
          );
        }
      }
    }

    if (validFace && posOut.length >= 9) {
      faces.push({
        positions: posOut,
        normals: normOut.length === posOut.length ? normOut : computeTriangleNormals(posOut),
        bodyIndex,
        surfaceType: 'MESH',
      });
      i = nextPos - 1;
    }
  }

  return faces;
}

/**
 * Full asynchronous CAD binary geometry extractor supporting:
 * - SolidWorks `.SLDPRT` / `.SLDASM` (Modern GSSF `14 00 06 00 08 00` blocks + Legacy OLE2 CFB + `__ZLB` wrapper + `DisplayLists__Zlb` `uoTempFaceTessData_c` 6-descriptor tables + Parasolid `PS\0\0` B-Rep)
 * - Dassault CATIA V5 (`V5_CFV2`, `OLE2 CFB`, `CGR`, `3DXML`, `SurfacicReps`)
 * - Autodesk Inventor (`.ipt`, `.iam` RSe `B<token>` `PmGraphics` face meshes)
 * - Siemens NX (`.prt` `SPLMSSTR` + `UG_PART` Parasolid `PS\0\0` B-Rep)
 * - PTC Creo / Parasolid / JT / 3MF (`.prt`, `.x_t`, `.x_b`, `.jt`, `.3mf`)
 */
export async function extractCatiaBinaryGeometry(
  buffer: ArrayBuffer
): Promise<CatiaExtractionResult> {
  const bytes = new Uint8Array(buffer);
  let embeddedPreviewDataUrl = extractCatiaEmbeddedJpeg(bytes);
  const allFaces: ExtractedCatiaFace[] = [];
  let zlibBlocksDecompressed = 0;

  // Step 0: Check for 3DXML or 3MF XML text
  const textSample = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 4096))
  );
  if (
    textSample.includes('<Model_3dxml') ||
    textSample.includes('<PolygonalRep') ||
    textSample.includes('<model')
  ) {
    const fullXml = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const xmlFaces = parse3dxmlText(fullXml);
    if (xmlFaces.length > 0) {
      const totalTriangles = xmlFaces.reduce((s, f) => s + Math.floor(f.positions.length / 9), 0);
      return {
        foundRealTessellation: true,
        faces: xmlFaces,
        totalTriangles,
        streamCount: 1,
        zlibBlocksDecompressed: 0,
        embeddedPreviewDataUrl,
        diagnosticSummary: `Decoded ${xmlFaces.length} PolygonalRep faces (${totalTriangles} triangles) from XML container.`,
      };
    }
  }

  // Step 1: Unpack V5_CFV2 logical streams (`MainDataStream`, `SurfacicReps`, `SceneGraph`, etc.)
  const candidateStreams: LogicalStream[] = unpackV5Cfv2LogicalStreams(bytes);

  // Step 1b: Unpack Modern SolidWorks (2015+, GSSF) blocks (`14 00 06 00 08 00` + nibble-swapped names)
  const swGssfStreams = await unpackSolidWorksGssfBlocks(bytes);
  if (swGssfStreams.length > 0) {
    zlibBlocksDecompressed += swGssfStreams.length;
    candidateStreams.push(...swGssfStreams);
  }

  // Step 1c: Unpack Siemens NX `SPLMSSTR` directory streams (`/Root/UG_PART/UG_PART`, `/Root/FastLoad/JT`, `/Root/images/preview`)
  const nxSplmsstrStreams = unpackSplmsstrStreams(bytes);
  if (nxSplmsstrStreams.length > 0) {
    candidateStreams.push(...nxSplmsstrStreams);
  }

  // Step 2: Check if the file is an OLE2 Compound File Binary (D0 CF 11 E0 A1 B1 1A E1) — used by CATIA, SolidWorks <= 2014, Inventor, Legacy NX
  if (
    bytes.byteLength > 512 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    try {
      const cfbContainer = CFB.read(bytes, { type: 'array' });
      for (const entry of cfbContainer.FileIndex) {
        if (entry.type === 2 && entry.content && entry.content.length >= 16) {
          const contentBytes =
            entry.content instanceof Uint8Array
              ? entry.content
              : new Uint8Array(entry.content);
          const streamName = entry.name || 'CFB_Stream';
          candidateStreams.push({
            name: streamName,
            bytes: contentBytes,
          });
          // Unwrap SolidWorks `__ZLB` wrapper if present in this CFB stream
          const zlbStreams = await unwrapSolidWorksZlbPayloads(contentBytes, streamName);
          if (zlbStreams.length > 0) {
            zlibBlocksDecompressed += zlbStreams.length;
            candidateStreams.push(...zlbStreams);
          }
          // Unwrap Autodesk Inventor RSe `B<token>` bulk stream (16-byte prefix + u16 form where byte 17 === 1 is zlib at offset 18)
          if (
            streamName.startsWith('B') &&
            contentBytes.byteLength > 22 &&
            contentBytes[17] === 1 &&
            contentBytes[18] === 0x78
          ) {
            const invInflated =
              (await tryDecompressStream(contentBytes.subarray(20), 'deflate-raw')) ||
              (await tryDecompressStream(contentBytes.subarray(18), 'deflate'));
            if (invInflated && invInflated.byteLength >= 32) {
              zlibBlocksDecompressed++;
              candidateStreams.push({
                name: `${streamName}__RSeBulk`,
                bytes: invInflated,
              });
            }
          }
          const nested = unpackV5Cfv2LogicalStreams(contentBytes);
          candidateStreams.push(...nested);
        }
      }
    } catch {
      // Ignore CFB parse errors
    }
  }

  // Step 2b: Check for standard PKZIP local file headers (50 4B 03 04) — used by zipped .3dxml and .3mf
  if (bytes.byteLength > 32) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pkCount = 0;
    for (let p = 0; p < bytes.byteLength - 30 && pkCount < 32; p++) {
      if (
        bytes[p] === 0x50 &&
        bytes[p + 1] === 0x4b &&
        bytes[p + 2] === 0x03 &&
        bytes[p + 3] === 0x04
      ) {
        const compMethod = view.getUint16(p + 8, true);
        const compSize = view.getUint32(p + 18, true);
        const nameLen = view.getUint16(p + 26, true);
        const extraLen = view.getUint16(p + 28, true);
        const dataStart = p + 30 + nameLen + extraLen;
        if (dataStart < bytes.byteLength && nameLen < 256) {
          const entryName = new TextDecoder('utf-8', { fatal: false }).decode(
            bytes.subarray(p + 30, p + 30 + nameLen)
          );
          const sliceLen =
            compSize > 0 && dataStart + compSize <= bytes.byteLength
              ? compSize
              : Math.min(bytes.byteLength - dataStart, 524288);
          const rawEntry = bytes.subarray(dataStart, dataStart + sliceLen);
          if (compMethod === 0 && rawEntry.byteLength >= 32) {
            candidateStreams.push({ name: entryName || 'ZIP_Entry', bytes: rawEntry });
          } else if (compMethod === 8 && rawEntry.byteLength >= 12) {
            const inflated = await tryDecompressStream(rawEntry, 'deflate-raw');
            if (inflated && inflated.byteLength >= 32) {
              zlibBlocksDecompressed++;
              candidateStreams.push({ name: entryName || 'ZIP_Inflated', bytes: inflated });
              const inflatedText = new TextDecoder('utf-8', { fatal: false }).decode(
                inflated.subarray(0, Math.min(inflated.byteLength, 2048))
              );
              if (inflatedText.includes('<PolygonalRep') || inflatedText.includes('<mesh')) {
                const xmlFaces = parse3dxmlText(
                  new TextDecoder('utf-8', { fatal: false }).decode(inflated)
                );
                if (xmlFaces.length > 0) {
                  allFaces.push(...xmlFaces);
                }
              }
            }
          }
          pkCount++;
        }
      }
    }
  }

  // Always include the raw file buffer as a fallback stream
  candidateStreams.push({ name: 'RawContainer', bytes });

  // Check if any unpacked stream (such as `PreviewPNG` or `/Root/images/preview`) holds an embedded PNG or JPEG preview
  if (!embeddedPreviewDataUrl) {
    for (const s of candidateStreams) {
      if (s.name === 'RawContainer') continue;
      const preview = extractCatiaEmbeddedJpeg(s.bytes);
      if (preview) {
        embeddedPreviewDataUrl = preview;
        break;
      }
    }
  }

  // Step 2c: Decode SolidWorks `DisplayLists__Zlb` (`uoTempFaceTessData_c` 6-descriptor tables)
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const s = candidateStreams[sIdx];
      const swFaces = extractSolidWorksDisplayListsFaces(s.bytes, 0);
      if (swFaces.length > 0) {
        allFaces.push(...swFaces);
      }
    }
  }

  // Step 2d: Decode Autodesk Inventor `PmGraphics` (`0x30000002 / 0x00000123`) B-Rep face meshes
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const invFaces = extractInventorPmGraphicsFaces(candidateStreams[sIdx].bytes, 0);
      if (invFaces.length > 0) {
        allFaces.push(...invFaces);
      }
    }
  }

  // Step 3: Decode CATIA V5 `ff ff 02 00 01 ff` Visualization-Point Coordinate Tables + `01 <0x40|mask>` Trim Packets
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const stream = candidateStreams[sIdx];
      const visuTables = extractVisuCoordinateTables(stream.bytes);
      for (let tIdx = 0; tIdx < visuTables.length; tIdx++) {
        const vt = visuTables[tIdx];
        const prevEnd = tIdx > 0 ? visuTables[tIdx - 1].endOffset : 0;
        const packetSlice = stream.bytes.subarray(prevEnd, vt.offset);
        const bodyFaces = extractTrimPacketsFromStream(
          packetSlice,
          vt.coords,
          vt.entryCount,
          tIdx
        );
        if (bodyFaces.length > 0) {
          allFaces.push(...bodyFaces);
        } else {
          const fullFaces = extractTrimPacketsFromStream(
            stream.bytes,
            vt.coords,
            vt.entryCount,
            tIdx
          );
          if (fullFaces.length > 0) {
            allFaces.push(...fullFaces);
          }
        }
      }
      if (allFaces.length > 0) {
        break;
      }
    }
  }

  // Step 3b: Decode Parasolid Binary XT (`PS\0\0` / `Config-0-Partition`) geometry carriers if no DisplayLists mesh was present
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const psFaces = extractParasolidBinaryFaces(candidateStreams[sIdx].bytes, 0);
      if (psFaces.length > 0) {
        allFaces.push(...psFaces);
        break;
      }
    }
  }

  // Step 4: Scan streams for CAT3DFaceGP / CAT3DPlanarFaceGP and Inventor/JT interleaved DisplayLists
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const sBytes = candidateStreams[sIdx].bytes;
      const directFaces = scanStreamForCatiaFaces(sBytes, 0);
      if (directFaces.length > 0) {
        allFaces.push(...directFaces);
      } else {
        const dlFaces = scanStreamForInterleavedDisplayList(sBytes, 0);
        if (dlFaces.length > 0) {
          allFaces.push(...dlFaces);
        }
      }
    }
  }

  // Step 4b: Scan for embedded zlib-compressed blocks (0x78 0x9C, 0x78 0xDA, 0x78 0x01) across unpacked streams & raw file
  if (allFaces.length === 0) {
    for (const stream of candidateStreams) {
      const sBytes = stream.bytes;
      const zlibOffsets: number[] = [];
      for (let i = 0; i < sBytes.byteLength - 16; i++) {
        if (
          sBytes[i] === 0x78 &&
          (sBytes[i + 1] === 0x9c || sBytes[i + 1] === 0xda || sBytes[i + 1] === 0x01)
        ) {
          zlibOffsets.push(i);
          if (zlibOffsets.length >= 64) break;
        }
      }

      for (const zOff of zlibOffsets) {
        const rawDeflateSlice = sBytes.subarray(
          zOff + 2,
          Math.min(sBytes.byteLength, zOff + 524288)
        );
        const decompressed =
          (await tryDecompressStream(rawDeflateSlice, 'deflate-raw')) ||
          (await tryDecompressStream(
            sBytes.subarray(zOff, Math.min(sBytes.byteLength, zOff + 524288)),
            'deflate'
          ));
        if (decompressed && decompressed.byteLength >= 36) {
          zlibBlocksDecompressed++;
          const swFaces = extractSolidWorksDisplayListsFaces(decompressed, 0);
          if (swFaces.length > 0) {
            allFaces.push(...swFaces);
            break;
          }
          const invFaces = extractInventorPmGraphicsFaces(decompressed, 0);
          if (invFaces.length > 0) {
            allFaces.push(...invFaces);
            break;
          }
          const visuTables = extractVisuCoordinateTables(decompressed);
          for (let tIdx = 0; tIdx < visuTables.length; tIdx++) {
            const vt = visuTables[tIdx];
            const packetFaces = extractTrimPacketsFromStream(
              decompressed,
              vt.coords,
              vt.entryCount,
              tIdx
            );
            allFaces.push(...packetFaces);
          }
          if (allFaces.length > 0) break;

          const psFaces = extractParasolidBinaryFaces(decompressed, 0);
          if (psFaces.length > 0) {
            allFaces.push(...psFaces);
            break;
          }
          const gpFaces = scanStreamForCatiaFaces(decompressed, 0);
          if (gpFaces.length > 0) {
            allFaces.push(...gpFaces);
            break;
          } else {
            const dlFaces = scanStreamForInterleavedDisplayList(decompressed, 0);
            if (dlFaces.length > 0) {
              allFaces.push(...dlFaces);
              break;
            }
          }
        }
      }
      if (allFaces.length > 0) break;
    }
  }

  // Step 5: Check CATIA SurfacicReps analytic surfaces (00 33 32..35) if no visualization mesh was pre-baked
  if (allFaces.length === 0) {
    for (let sIdx = 0; sIdx < candidateStreams.length; sIdx++) {
      const surfFaces = extractSurfacicRepsAndVertices(candidateStreams[sIdx].bytes, 0);
      if (surfFaces.length > 0) {
        allFaces.push(...surfFaces);
        break;
      }
    }
  }

  // Normalize metre-unit streams if the overall model envelope is < 1.5 m and stored in metres
  if (allFaces.length > 0) {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (const f of allFaces) {
      const pos = f.positions;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i],
          y = pos[i + 1],
          z = pos[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    if (diag > 1e-5 && diag < 0.85) {
      for (const f of allFaces) {
        for (let i = 0; i < f.positions.length; i++) {
          f.positions[i] *= 1000.0;
        }
      }
    }
  }

  const totalTriangles = allFaces.reduce(
    (sum, f) => sum + Math.floor(f.positions.length / 9),
    0
  );

  return {
    foundRealTessellation: allFaces.length > 0 && totalTriangles >= 2,
    faces: allFaces,
    totalTriangles,
    streamCount: candidateStreams.length,
    zlibBlocksDecompressed,
    embeddedPreviewDataUrl,
    diagnosticSummary:
      allFaces.length > 0
        ? `Decoded ${allFaces.length} B-Rep faces (${totalTriangles} triangles) across ${candidateStreams.length} CAD streams.`
        : `Scanned ${candidateStreams.length} streams (${zlibBlocksDecompressed} compressed blocks); no embedded visualization mesh found.`,
  };
}
