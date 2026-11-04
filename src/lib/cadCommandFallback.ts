import { CadFaceFeature } from '../types/cad';
import { ModificationCommandInput } from './cadGeometryEngine';

/**
 * Deterministic command parser for conversational CAD modifications.
 * Handles both relative deltas ("increase the diameter by 12 mm") and target values ("set diameter to 12 mm").
 */
export function parseCadInstructionDeterministic(
  instruction: string,
  selectedFeatureId: string | null,
  features: CadFaceFeature[]
): ModificationCommandInput {
  const lower = instruction.toLowerCase().trim();

  const idMatch = instruction.match(/\b(HOLE-\d+|BOSS-\d+|FACE-P\d+|CHAM-\d+)\b/i);
  const explicitTargetId = idMatch ? idMatch[1].toUpperCase() : selectedFeatureId;

  const numMatch = instruction.match(/([+-]?\d+(?:\.\d+)?)\s*(?:mm|millimeter|millimetre)?/i);
  const numericVal = numMatch ? parseFloat(numMatch[1]) : undefined;

  const isByDelta =
    /\bby\s+[+-]?\d+/i.test(instruction) ||
    ((lower.includes('increase') || lower.includes('add') || lower.includes('expand')) &&
      !lower.includes(' to '));
  const isDecrease =
    lower.includes('decrease') || lower.includes('reduce') || lower.includes('shrink');

  // 1. Highlight surfaces requiring machining
  if (
    lower.includes('highlight') &&
    (lower.includes('machin') || lower.includes('surface') || lower.includes('bore'))
  ) {
    return {
      operation: 'annotate_machining',
      targetFeatureId: explicitTargetId,
      annotationLabel: 'CNC Finish Machining Required (Ra 0.8 μm)',
      explanation: 'Highlighted functional bores and datum faces requiring CNC machining.',
    };
  }

  // 2. Apply surface finish
  if (
    lower.includes('finish') ||
    lower.includes('appearance') ||
    lower.includes('anodiz') ||
    lower.includes('bead') ||
    (lower.includes('apply') && lower.includes('machin'))
  ) {
    let finish: ModificationCommandInput['surfaceFinish'] = 'machined_cnc';
    if (lower.includes('anodiz') || lower.includes('blue') || lower.includes('cobalt')) {
      finish = 'anodized_cobalt';
    } else if (lower.includes('bead') || lower.includes('blast') || lower.includes('matte')) {
      finish = 'bead_blasted';
    } else if (lower.includes('polish') || lower.includes('ground') || lower.includes('mirror')) {
      finish = 'ground_polished';
    } else if (lower.includes('cast') || lower.includes('raw')) {
      finish = 'cast_raw';
    }
    return {
      operation: 'apply_surface_finish',
      targetFeatureId: explicitTargetId,
      surfaceFinish: finish,
      explanation: `Applied ${finish.replace(/_/g, ' ')} surface finish.`,
    };
  }

  // 3. Smooth surface
  if (lower.includes('smooth') || lower.includes('polish')) {
    return {
      operation: 'smooth_surface',
      targetFeatureId: explicitTargetId,
      explanation: 'Applied surface smoothing and ground Ra 0.2 μm finish.',
    };
  }

  // 4. Add / Drill / Cut / Create a New Hole or Bore on a Planar Surface
  // e.g. "add a hole at the middle of this rectangular planar surface", "drill a 10mm hole in the center"
  const hasAddVerb = /\b(add|drill|cut|create|make|bore|punch|insert|put|place|mill)\b/i.test(lower);
  const hasHoleNoun = /\b(hole|bore|through-hole|opening|aperture)\b/i.test(lower);
  const hasResizeVerb = /\b(increase|decrease|reduce|shrink|expand|widen|enlarge|resize|change)\b/i.test(lower);

  if (
    (hasAddVerb && hasHoleNoun && !hasResizeVerb) ||
    ((lower.includes('middle') || lower.includes('center') || lower.includes('planar') || lower.includes('rectangular')) &&
      hasHoleNoun &&
      !hasResizeVerb)
  ) {
    const planarFaces = features
      .filter((f) => f.type === 'planar_face')
      .sort((a, b) => b.areaMm2 - a.areaMm2);

    let chosenPlane = explicitTargetId
      ? features.find((f) => f.id === explicitTargetId && f.type === 'planar_face')
      : undefined;

    if (!chosenPlane) {
      if (lower.includes('top') || lower.includes('upper')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[2] > 0.8) || planarFaces[0];
      } else if (lower.includes('bottom') || lower.includes('lower') || lower.includes('base')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[2] < -0.8) || planarFaces[0];
      } else if (lower.includes('front')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[1] < -0.8) || planarFaces[0];
      } else if (lower.includes('back') || lower.includes('rear')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[1] > 0.8) || planarFaces[0];
      } else if (lower.includes('right')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[0] > 0.8) || planarFaces[0];
      } else if (lower.includes('left')) {
        chosenPlane = planarFaces.find((f) => f.normalOrAxis[0] < -0.8) || planarFaces[0];
      } else {
        chosenPlane = planarFaces[0];
      }
    }

    const isRadius = lower.includes('radius') && !lower.includes('diameter');
    const requestedDiaMm =
      numericVal !== undefined ? (isRadius ? numericVal * 2 : numericVal) : undefined;

    return {
      operation: 'add_hole',
      targetFeatureId: chosenPlane?.id || explicitTargetId || null,
      parameterMm: requestedDiaMm,
      explanation: `Drilled cylindrical through-hole${requestedDiaMm ? ` Ø${requestedDiaMm.toFixed(2)} mm` : ''} at the center of ${chosenPlane?.id || 'planar surface'}.`,
    };
  }

  // 5. Diameter / Hole / Bore / Radius resize modification
  if (
    lower.includes('diameter') ||
    lower.includes('hole') ||
    lower.includes('bore') ||
    lower.includes('radius') ||
    (numericVal !== undefined && (lower.includes('increase') || lower.includes('decrease')))
  ) {
    const wantsBoss = lower.includes('boss') || lower.includes('outer') || lower.includes('shaft');
    const chosenFeat =
      (explicitTargetId
        ? features.find((f) => f.id === explicitTargetId)
        : undefined) ||
      (wantsBoss
        ? features.find((f) => f.type === 'boss')
        : features.find((f) => f.type === 'hole')) ||
      features.find((f) => f.type === 'boss') ||
      features.find((f) => f.type === 'hole');

    const currentDia = chosenFeat?.diameterMm || 20.0;
    const isRadius = lower.includes('radius') && !lower.includes('diameter');
    const rawMm = numericVal !== undefined ? (isRadius ? numericVal * 2 : numericVal) : 12.0;

    let finalDiameterMm: number;
    if (isByDelta) {
      finalDiameterMm = isDecrease ? Math.max(2, currentDia - Math.abs(rawMm)) : currentDia + Math.abs(rawMm);
    } else if (lower.includes('increase') && rawMm <= currentDia) {
      finalDiameterMm = currentDia + Math.abs(rawMm);
    } else {
      finalDiameterMm = Math.max(2, rawMm);
    }

    return {
      operation: 'resize_hole_or_boss',
      targetFeatureId: chosenFeat?.id || explicitTargetId,
      parameterMm: finalDiameterMm,
      isRelativeDelta: isByDelta,
      deltaMm: isByDelta ? (isDecrease ? -Math.abs(rawMm) : Math.abs(rawMm)) : undefined,
      explanation: `Updated diameter from Ø${currentDia.toFixed(2)} mm to Ø${finalDiameterMm.toFixed(2)} mm.`,
    };
  }

  // 6. Add chamfer
  if (lower.includes('chamfer') || lower.includes('bevel')) {
    const chamTarget =
      explicitTargetId ||
      features.find((f) => f.type === 'planar_face')?.id ||
      features[0]?.id ||
      null;
    return {
      operation: 'add_chamfer',
      targetFeatureId: chamTarget,
      parameterMm: numericVal || 3.0,
      explanation: `Added ${(numericVal || 3.0).toFixed(2)} mm × 45° chamfer.`,
    };
  }

  // 7. Remove / reduce raised boss
  if (
    (lower.includes('remove') || lower.includes('reduce') || lower.includes('mill') || lower.includes('trim')) &&
    (lower.includes('boss') || lower.includes('protrusion'))
  ) {
    const bossTarget =
      explicitTargetId || features.find((f) => f.type === 'boss')?.id || null;
    return {
      operation: 'remove_boss',
      targetFeatureId: bossTarget,
      explanation: `Reduced raised boss feature ${bossTarget || ''} to low-profile shoulder.`,
    };
  }

  // 8. Extrude / offset / trim planar face
  if (
    lower.includes('extrude') ||
    lower.includes('offset') ||
    lower.includes('thicken') ||
    lower.includes('thickness') ||
    lower.includes('trim') ||
    lower.includes('inward') ||
    lower.includes('outward') ||
    lower.includes('height')
  ) {
    const faceTarget =
      explicitTargetId || features.find((f) => f.type === 'planar_face')?.id || null;
    const rawVal = numericVal !== undefined ? Math.abs(numericVal) : 2.5;
    const wantsInward =
      lower.includes('inward') ||
      lower.includes('trim') ||
      lower.includes('thin') ||
      lower.includes('reduce') ||
      (numericVal !== undefined && numericVal < 0);
    const signedOffset = wantsInward ? -rawVal : rawVal;
    return {
      operation: 'offset_face',
      targetFeatureId: faceTarget,
      parameterMm: signedOffset,
      explanation: `${signedOffset < 0 ? 'Trimmed' : 'Offset'} planar face ${faceTarget || ''} by ${signedOffset >= 0 ? '+' : ''}${signedOffset.toFixed(2)} mm.`,
    };
  }

  return {
    operation: 'unsupported',
    targetFeatureId: explicitTargetId,
    explanation: `Operation "${instruction}" requires a parametric CSG kernel operation not supported on this mesh.`,
  };
}
