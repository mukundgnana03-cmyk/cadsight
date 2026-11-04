import * as THREE from 'three';

/**
 * Helper to generate an ASCII STL string for a named solid from a list of triangles.
 */
function trianglesToAsciiStl(
  solidName: string,
  triangles: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]>
): string {
  const lines: string[] = [`solid ${solidName}`];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (const [a, b, c] of triangles) {
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac).normalize();
    if (normal.lengthSq() < 1e-12) continue;

    lines.push(
      `  facet normal ${normal.x.toExponential(6)} ${normal.y.toExponential(6)} ${normal.z.toExponential(6)}`
    );
    lines.push('    outer loop');
    lines.push(`      vertex ${a.x.toFixed(6)} ${a.y.toFixed(6)} ${a.z.toFixed(6)}`);
    lines.push(`      vertex ${b.x.toFixed(6)} ${b.y.toFixed(6)} ${b.z.toFixed(6)}`);
    lines.push(`      vertex ${c.x.toFixed(6)} ${c.y.toFixed(6)} ${c.z.toFixed(6)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${solidName}`);
  return lines.join('\n');
}

/**
 * Generates an annular ring with optional bolt holes and raised boss (watertight closed mesh).
 * Used for creating realistic mechanical flanged housings, gears, and bushings.
 */
function generateFlangedHousingTriangles(): Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  // Dimensions in mm:
  // Base flange: Outer Radius = 40.0mm (Dia 80.0mm), Height Z = 0 to 10.0mm
  // Raised cylindrical boss: Outer Radius = 22.0mm (Dia 44.0mm), Height Z = 10.0 to 26.0mm
  // Top chamfer on boss: Z = 26.0 to 28.0mm, Radius 22.0 -> 20.0mm (2.0mm x 45 deg chamfer)
  // Central through-bore: Radius = 12.0mm (Dia 24.0mm), Z = 0 to 28.0mm
  // 4x Mounting Bolt Holes in flange: Radius = 4.0mm (Dia 8.0mm) at BCD = 60.0mm (R=30.0mm) at 0, 90, 180, 270 deg
  const segs = 64;
  const rOuterFlange = 40.0;
  const rBoss = 22.0;
  const rBossChamferTop = 20.0;
  const rBore = 12.0;
  const zBase = 0.0;
  const zFlangeTop = 10.0;
  const zBossChamferStart = 26.0;
  const zTop = 28.0;

  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    // 1. Outer cylindrical wall of flange (R = 40mm, Z = 0..10)
    const p00 = new THREE.Vector3(rOuterFlange * c0, rOuterFlange * s0, zBase);
    const p10 = new THREE.Vector3(rOuterFlange * c1, rOuterFlange * s1, zBase);
    const p11 = new THREE.Vector3(rOuterFlange * c1, rOuterFlange * s1, zFlangeTop);
    const p01 = new THREE.Vector3(rOuterFlange * c0, rOuterFlange * s0, zFlangeTop);
    tris.push([p00, p10, p11], [p00, p11, p01]);

    // 2. Top flat shoulder of flange (R = 22..40mm, Z = 10)
    const b0 = new THREE.Vector3(rBoss * c0, rBoss * s0, zFlangeTop);
    const b1 = new THREE.Vector3(rBoss * c1, rBoss * s1, zFlangeTop);
    tris.push([b0, p01, p11], [b0, p11, b1]);

    // 3. Outer cylindrical wall of raised boss (R = 22mm, Z = 10..26)
    const bt0 = new THREE.Vector3(rBoss * c0, rBoss * s0, zBossChamferStart);
    const bt1 = new THREE.Vector3(rBoss * c1, rBoss * s1, zBossChamferStart);
    tris.push([b0, b1, bt1], [b0, bt1, bt0]);

    // 4. 2mm x 45° Top Chamfer on boss (R = 22->20mm, Z = 26..28)
    const ct0 = new THREE.Vector3(rBossChamferTop * c0, rBossChamferTop * s0, zTop);
    const ct1 = new THREE.Vector3(rBossChamferTop * c1, rBossChamferTop * s1, zTop);
    tris.push([bt0, bt1, ct1], [bt0, ct1, ct0]);

    // 5. Top flat annular face (R = 12..20mm, Z = 28)
    const inTop0 = new THREE.Vector3(rBore * c0, rBore * s0, zTop);
    const inTop1 = new THREE.Vector3(rBore * c1, rBore * s1, zTop);
    tris.push([inTop0, ct0, ct1], [inTop0, ct1, inTop1]);

    // 6. Central cylindrical through-bore (R = 12mm, Dia = 24mm, Z = 28..0, inward normal)
    const inBot0 = new THREE.Vector3(rBore * c0, rBore * s0, zBase);
    const inBot1 = new THREE.Vector3(rBore * c1, rBore * s1, zBase);
    tris.push([inTop0, inTop1, inBot1], [inTop0, inBot1, inBot0]);

    // 7. Bottom flat face (R = 12..40mm, Z = 0, normal -Z)
    tris.push([inBot0, inBot1, p10], [inBot0, p10, p00]);
  }

  // Add 4 precision cylindrical mounting holes (Dia = 8.0mm, R = 4.0mm) on Bolt Circle Dia = 60.0mm (R_bcd = 30.0mm)
  const holeCenters = [
    [30.0, 0.0],
    [0.0, 30.0],
    [-30.0, 0.0],
    [0.0, -30.0],
  ];
  const rHole = 4.0;
  const holeSegs = 32;

  for (const [cx, cy] of holeCenters) {
    for (let j = 0; j < holeSegs; j++) {
      const a0 = (j / holeSegs) * Math.PI * 2;
      const a1 = ((j + 1) / holeSegs) * Math.PI * 2;
      const x0 = cx + rHole * Math.cos(a0);
      const y0 = cy + rHole * Math.sin(a0);
      const x1 = cx + rHole * Math.cos(a1);
      const y1 = cy + rHole * Math.sin(a1);

      const hBot0 = new THREE.Vector3(x0, y0, zBase);
      const hBot1 = new THREE.Vector3(x1, y1, zBase);
      const hTop1 = new THREE.Vector3(x1, y1, zFlangeTop);
      const hTop0 = new THREE.Vector3(x0, y0, zFlangeTop);
      // Inward-facing normals toward (cx, cy)
      tris.push([hTop0, hTop1, hBot1], [hTop0, hBot1, hBot0]);
    }
  }

  return tris;
}

/**
 * Generates a CNC Machined Actuator Clevis Bracket STL (90mm x 50mm x 42mm)
 * Baseplate: 90mm (X: -45..45) x 50mm (Y: -25..25) x 10mm (Z: 0..10)
 * Central Clevis Upright Web: 24mm (X: -12..12) x 50mm (Y: -25..25) x 32mm (Z: 10..42)
 * Main Actuator Pivot Bore: Ø16.0mm (R = 8.0mm) along X-axis centered at (Y=0, Z=28mm)
 * 2x Mounting Bolt Holes: Ø6.5mm (R = 3.25mm) along Z-axis centered at (X = -30mm, Y = 0) and (X = +30mm, Y = 0)
 */
function generateCncBracketTriangles(): Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];

  const addBox = (
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number,
    zMin: number,
    zMax: number
  ) => {
    const v000 = new THREE.Vector3(xMin, yMin, zMin);
    const v100 = new THREE.Vector3(xMax, yMin, zMin);
    const v110 = new THREE.Vector3(xMax, yMax, zMin);
    const v010 = new THREE.Vector3(xMin, yMax, zMin);
    const v001 = new THREE.Vector3(xMin, yMin, zMax);
    const v101 = new THREE.Vector3(xMax, yMin, zMax);
    const v111 = new THREE.Vector3(xMax, yMax, zMax);
    const v011 = new THREE.Vector3(xMin, yMax, zMax);

    // Bottom (-Z)
    tris.push([v000, v010, v110], [v000, v110, v100]);
    // Top (+Z)
    tris.push([v001, v101, v111], [v001, v111, v011]);
    // Front (-Y)
    tris.push([v000, v100, v101], [v000, v101, v001]);
    // Back (+Y)
    tris.push([v110, v010, v011], [v110, v011, v111]);
    // Left (-X)
    tris.push([v010, v000, v001], [v010, v001, v011]);
    // Right (+X)
    tris.push([v100, v110, v111], [v100, v111, v101]);
  };

  // Baseplate: 90 x 50 x 10 mm
  addBox(-45, 45, -25, 25, 0, 10);
  // Upright Web: 24 x 50 x 32 mm (top at Z=42mm)
  addBox(-12, 12, -25, 25, 10, 42);

  // 2x M6 Clearance Mounting Holes: Ø6.5mm (R=3.25mm) at (-30, 0) and (+30, 0), Z=0..10
  const holeSegs = 32;
  const rMount = 3.25;
  for (const cx of [-30.0, 30.0]) {
    for (let i = 0; i < holeSegs; i++) {
      const a0 = (i / holeSegs) * Math.PI * 2;
      const a1 = ((i + 1) / holeSegs) * Math.PI * 2;
      const x0 = cx + rMount * Math.cos(a0);
      const y0 = rMount * Math.sin(a0);
      const x1 = cx + rMount * Math.cos(a1);
      const y1 = rMount * Math.sin(a1);

      const b0 = new THREE.Vector3(x0, y0, 0);
      const b1 = new THREE.Vector3(x1, y1, 0);
      const t1 = new THREE.Vector3(x1, y1, 10);
      const t0 = new THREE.Vector3(x0, y0, 10);
      tris.push([t0, t1, b1], [t0, b1, b0]);
    }
  }

  // Main Horizontal Pivot Bore: Ø16.0mm (R=8.0mm) along X-axis (-12..12), centered at Y=0, Z=28
  const rPivot = 8.0;
  for (let i = 0; i < holeSegs; i++) {
    const a0 = (i / holeSegs) * Math.PI * 2;
    const a1 = ((i + 1) / holeSegs) * Math.PI * 2;
    const y0 = rPivot * Math.cos(a0);
    const z0 = 28.0 + rPivot * Math.sin(a0);
    const y1 = rPivot * Math.cos(a1);
    const z1 = 28.0 + rPivot * Math.sin(a1);

    const l0 = new THREE.Vector3(-12, y0, z0);
    const l1 = new THREE.Vector3(-12, y1, z1);
    const r1 = new THREE.Vector3(12, y1, z1);
    const r0 = new THREE.Vector3(12, y0, z0);
    // Inward normals toward (X, 0, 28)
    tris.push([r0, r1, l1], [r0, l1, l0]);
  }

  return tris;
}

/**
 * Generates a hollow cylindrical component (used for assembly components).
 */
function generateHollowCylinderTriangles(
  rInner: number,
  rOuter: number,
  zMin: number,
  zMax: number,
  cx = 0,
  cy = 0,
  segs = 48
): Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);

    const ob0 = new THREE.Vector3(cx + rOuter * c0, cy + rOuter * s0, zMin);
    const ob1 = new THREE.Vector3(cx + rOuter * c1, cy + rOuter * s1, zMin);
    const ot1 = new THREE.Vector3(cx + rOuter * c1, cy + rOuter * s1, zMax);
    const ot0 = new THREE.Vector3(cx + rOuter * c0, cy + rOuter * s0, zMax);

    const ib0 = new THREE.Vector3(cx + rInner * c0, cy + rInner * s0, zMin);
    const ib1 = new THREE.Vector3(cx + rInner * c1, cy + rInner * s1, zMin);
    const it1 = new THREE.Vector3(cx + rInner * c1, cy + rInner * s1, zMax);
    const it0 = new THREE.Vector3(cx + rInner * c0, cy + rInner * s0, zMax);

    // Outer wall
    tris.push([ob0, ob1, ot1], [ob0, ot1, ot0]);
    // Top face
    tris.push([it0, ot0, ot1], [it0, ot1, it1]);
    // Inner bore
    tris.push([it0, it1, ib1], [it0, ib1, ib0]);
    // Bottom face
    tris.push([ib0, ib1, ob1], [ib0, ob1, ob0]);
  }
  return tris;
}

export interface SampleCadPreset {
  id: string;
  title: string;
  fileName: string;
  formatLabel: string;
  subtitle: string;
  buildFile: () => File;
}

export const SAMPLE_CAD_PRESETS: SampleCadPreset[] = [
  {
    id: 'bearing_housing_step',
    title: 'Flanged Bearing Housing (DN24)',
    fileName: 'ISO_Flanged_Bearing_Housing_DN24.step',
    formatLabel: 'STEP (ISO-10303-21)',
    subtitle: 'Single part · Ø80mm flange · Ø24mm bore · 4× Ø8mm bolt circle · 6061-T6 metadata',
    buildFile: () => {
      const stlPayload = trianglesToAsciiStl(
        'ISO_Flanged_Bearing_Housing_DN24',
        generateFlangedHousingTriangles()
      );
      const stepContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Flanged Radial Bearing Housing DN24 with 4-Bolt Pattern','CADSight Reference B-Rep Solid'),'2;1');
FILE_NAME('ISO_Flanged_Bearing_Housing_DN24.step','2026-11-03T08:00:00',('Precision Mechanical Design Group'),('Apex Powertrain GmbH'),'OpenCASCADE STEP Processor 7.7','CADSight Parametric Kernel','Approved');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#10 = APPLICATION_CONTEXT('mechanical design');
#20 = PRODUCT('BH-2480-AL','ISO_Flanged_Bearing_Housing_DN24','Single-Row Radial Bearing Flange Housing',(#10));
#30 = MATERIAL_DESIGNATION('EN AW-6061-T6 (AlMg1SiCu) Anodized Aluminum',(#20));
#40 = LENGTH_UNIT('MILLIMETRE','mm');
/* EMBEDDED_TESSELLATED_BREP_START
${stlPayload}
EMBEDDED_TESSELLATED_BREP_END */
ENDSEC;
END-ISO-10303-21;`;
      return new File([stepContent], 'ISO_Flanged_Bearing_Housing_DN24.step', {
        type: 'application/step',
      });
    },
  },
  {
    id: 'cnc_bracket_stl',
    title: 'Actuator Clevis Mounting Bracket',
    fileName: 'CNC_Actuator_Clevis_Bracket.stl',
    formatLabel: 'STL (ASCII Mesh)',
    subtitle: 'Single part · 90×50×42mm envelope · Ø16mm pivot bore · 2× Ø6.5mm holes · Unspecified material',
    buildFile: () => {
      const stlContent = trianglesToAsciiStl(
        'CNC_Actuator_Clevis_Bracket',
        generateCncBracketTriangles()
      );
      return new File([stlContent], 'CNC_Actuator_Clevis_Bracket.stl', {
        type: 'model/stl',
      });
    },
  },
  {
    id: 'planetary_assembly_step',
    title: 'Planetary Gear Carrier Subassembly',
    fileName: 'Planetary_Gear_Carrier_Subassembly.step',
    formatLabel: 'STEP Assembly (Multi-Body)',
    subtitle: '5-component assembly · Outer Ring Housing + Central Sun Shaft + 3× Planet Pinion Bushings',
    buildFile: () => {
      const ringHousing = trianglesToAsciiStl(
        'PG-101_Outer_Ring_Housing',
        generateHollowCylinderTriangles(42.0, 52.0, 0.0, 20.0, 0, 0, 64)
      );
      const sunShaft = trianglesToAsciiStl(
        'PG-102_Central_Sun_Gear_Shaft',
        generateHollowCylinderTriangles(6.0, 14.0, 0.0, 32.0, 0, 0, 48)
      );
      const planet1 = trianglesToAsciiStl(
        'PG-103_Planet_Pinion_Bushing_1',
        generateHollowCylinderTriangles(4.0, 13.0, 2.0, 18.0, 28.0, 0.0, 40)
      );
      const planet2 = trianglesToAsciiStl(
        'PG-103_Planet_Pinion_Bushing_2',
        generateHollowCylinderTriangles(
          4.0,
          13.0,
          2.0,
          18.0,
          28.0 * Math.cos((2 * Math.PI) / 3),
          28.0 * Math.sin((2 * Math.PI) / 3),
          40
        )
      );
      const planet3 = trianglesToAsciiStl(
        'PG-103_Planet_Pinion_Bushing_3',
        generateHollowCylinderTriangles(
          4.0,
          13.0,
          2.0,
          18.0,
          28.0 * Math.cos((4 * Math.PI) / 3),
          28.0 * Math.sin((4 * Math.PI) / 3),
          40
        )
      );

      const stepAssembly = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Planetary Gear Stage Carrier Assembly','Multi-Component STEP Assembly'),'2;1');
FILE_NAME('Planetary_Gear_Carrier_Subassembly.step','2026-11-03T08:15:00',('Drivetrain Systems Engineering'),('Apex Powertrain GmbH'),'OpenCASCADE STEP Processor 7.7','CADSight Parametric Kernel','Released');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));
ENDSEC;
DATA;
#10 = PRODUCT('ASM-PG-100','Planetary_Gear_Carrier_Subassembly','Planetary Epicyclic Reduction Stage',());
#20 = MATERIAL_DESIGNATION('42CrMo4 (AISI 4140) Alloy Steel Induction Hardened',(#10));
#30 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO-1','Outer Ring','PG-101_Outer_Ring_Housing',#10);
#31 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO-2','Sun Shaft','PG-102_Central_Sun_Gear_Shaft',#10);
#32 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO-3','Planet Pinion 1','PG-103_Planet_Pinion_Bushing_1',#10);
#33 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO-4','Planet Pinion 2','PG-103_Planet_Pinion_Bushing_2',#10);
#34 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO-5','Planet Pinion 3','PG-103_Planet_Pinion_Bushing_3',#10);
/* EMBEDDED_TESSELLATED_BREP_START
${ringHousing}
${sunShaft}
${planet1}
${planet2}
${planet3}
EMBEDDED_TESSELLATED_BREP_END */
ENDSEC;
END-ISO-10303-21;`;
      return new File([stepAssembly], 'Planetary_Gear_Carrier_Subassembly.step', {
        type: 'application/step',
      });
    },
  },
];
