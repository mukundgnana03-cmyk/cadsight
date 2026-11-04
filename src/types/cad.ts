export type SupportedCadFormat =
  | 'STL'
  | 'STEP'
  | 'IGES'
  | 'BREP'
  | 'CATIA'
  | 'SOLIDWORKS'
  | 'INVENTOR'
  | 'NX_CREO'
  | 'PARASOLID'
  | 'ACIS'
  | 'JT'
  | 'OBJ'
  | 'GLTF'
  | '3MF'
  | 'PLY'
  | 'DAE'
  | 'FBX'
  | 'VRML';

export type SurfaceFinishType =
  | 'default_metallic'
  | 'machined_cnc'
  | 'ground_polished'
  | 'bead_blasted'
  | 'anodized_cobalt'
  | 'cast_raw'
  | 'machining_highlight';

export interface CadEngineeringAnnotation {
  id: string;
  featureId: string;
  label: string;
  specification: string;
  category: 'machining_required' | 'surface_finish' | 'datum' | 'inspection_note';
  createdAt: string;
}

export interface CadFaceFeature {
  id: string; // e.g., "HOLE-01", "BOSS-01", "FACE-P01", "CHAM-01", "FIL-01"
  name: string;
  type: 'hole' | 'boss' | 'planar_face' | 'chamfer' | 'fillet' | 'freeform_surface';
  componentIndex: number;
  componentName: string;
  triangleIndices: number[]; // indices of triangles belonging to this face/feature
  vertexIndices: number[]; // unique vertex indices belonging to this face/feature
  areaMm2: number;
  centroid: [number, number, number];
  normalOrAxis: [number, number, number];
  // Cylindrical properties (when type === 'hole' | 'boss' | 'fillet')
  diameterMm?: number;
  radiusMm?: number;
  depthOrLengthMm?: number;
  axisOrigin?: [number, number, number];
  angularCoverageDeg?: number;
  verificationConfidence?: 'High' | 'Medium' | 'Low';
  // Chamfer properties
  chamferWidthMm?: number;
  chamferAngleDeg?: number;
  // Planar bounding span
  spanMm?: [number, number];
  // Visual & Engineering state
  surfaceFinish: SurfaceFinishType;
  requiresMachiningHighlight: boolean;
  annotation?: string;
}

export interface CandidateCylindricalFeature {
  candidateId: string;
  mappedFeatureId: string | null;
  componentName: string;
  fittedDiameterMm: number;
  fittedRadiusMm: number;
  axialLengthMm: number;
  angularCoverageDeg: number;
  rmsFitErrorRatio: number;
  normalOrientation: 'Inward (Concave)' | 'Outward (Convex)';
  fitsWithinPartBoundary: boolean;
  verificationStatus:
    | 'Verified Closed Hole'
    | 'Verified Cylindrical Boss'
    | 'Reclassified as Fillet / Partial Arc'
    | 'Rejected — Exceeds Boundary / Unverified Arc';
  confidencePercent: number;
  confidenceLevel: 'High' | 'Medium' | 'Low / Rejected';
  rejectionOrVerificationReason: string;
}

export interface SurfaceClassificationSummary {
  classification: 'Planar Datum Faces' | 'Verified Cylindrical Holes' | 'Verified Cylindrical Bosses' | 'Fillets & Chamfer Blends' | 'Freeform / Other Surfaces';
  faceCount: number;
  totalAreaMm2: number;
  areaPercentage: number;
  detectionConfidence: 'High' | 'Medium';
}

export interface KernelAndMeshVerification {
  representationType: 'Analytical B-Rep + Tessellation' | 'Tessellated Surface Mesh (Faceted)';
  sourceFormat: SupportedCadFormat;
  volumeComputationMethod: string;
  boreMeasurementMethod: string;
  meanChordalDeviationMm: number;
  volumetricDiscretizationUncertaintyPct: number;
  canVerifyPrecisionTolerancesFromMesh: boolean;
  toleranceVerificationLimitationNote: string;
}

export interface CadFactVsAssumptionRow {
  category: string;
  parameter: string;
  value: string;
  classification:
    | 'CAD_EXTRACTED_FACT'
    | 'MESH_DERIVED_WITH_UNCERTAINTY'
    | 'COSTING_ASSUMPTION'
    | 'USER_OVERRIDDEN';
  sourceOrBasis: string;
}

export interface GeometryAnalysisReport {
  totalFacesDetected: number;
  totalTriangles: number;
  totalVertices: number;
  boundingDimensionsMm: {
    lengthX: number;
    widthY: number;
    heightZ: number;
    diagonal3D: number;
  };
  materialVolumeEstimates: {
    netSolidVolumeCm3: number;
    netSolidVolumeMm3: number;
    boundingEnvelopeVolumeCm3: number;
    volumetricFillRatioPct: number;
    totalSurfaceAreaCm2: number;
    materialDeclaredInFile: string | null;
  };
  kernelAndMeshVerification?: KernelAndMeshVerification;
  factsVsAssumptions?: CadFactVsAssumptionRow[];
  surfaceClassifications: SurfaceClassificationSummary[];
  candidateHolesAndCylinders: CandidateCylindricalFeature[];
  missingManufacturingSpecifications: {
    attribute: string;
    status: 'SPECIFIED IN CAD' | 'MISSING IN CAD FILE';
    detail: string;
  }[];
}

export interface CadDimensionRow {
  id: string;
  category:
    | 'Overall Envelope'
    | 'Mass & Volumetric'
    | 'Hole / Bore'
    | 'Cylindrical Boss / Shaft'
    | 'Chamfer / Fillet'
    | 'Feature Position & Spacing'
    | 'Planar Surface';
  parameter: string;
  value: number;
  formattedValue: string;
  unit: string;
  geometricReference: string;
  linkedFeatureId?: string;
  extractionMethod: string;
  verificationStatus?: 'Verified Geometry' | 'Requires Inspection Validation';
  confidencePercent?: number;
  previousValue?: number;
  visualSnippetDataUrl?: string;
}

export interface RawStockGeometryValidation {
  stockShape:
    | 'round_bar'
    | 'rectangular_billet'
    | 'sheet_plate_blank'
    | 'near_net_cast_or_forged_preform';
  stockDimensionsFormatted: string;
  axialAllowanceMm: number;
  radialOrLateralAllowanceMm: number;
  partEnvelopeMm: [number, number, number];
  requiredCircumscribedDiameterMm: number;
  proposedStockEnvelopeMm: [number, number, number];
  geometricallyContainsPart: boolean;
  containmentVerificationNote: string;
  rawStockVolumeCm3: number;
  netPartVolumeCm3: number;
}

export interface BomEntry {
  itemNumber: number;
  partNumber?: string;
  componentName: string;
  structuralRole: string;
  quantity: number;
  material: string;
  densityGPerCm3: number;
  remarks: string;
  manufacturingProcess: string;
  secondaryOperations: string;
  boundingBoxMm: string;
  rawStockDimensionsMm: string;
  rawStockVolumeCm3: number;
  volumeCm3: number;
  rawVolumeM3: number;
  netVolumeM3: number;
  volumeConversionExplanation: string;
  chipRemovalRatioPct: number;
  chipRemovalExplanation: string;
  surfaceAreaCm2: number;
  estimatedMassGrams: number;
  featureSummary: string;
  triangleCount: number;
  componentIndices: number[];
  stockValidation?: RawStockGeometryValidation;
}

export interface CostBatchTier {
  batchSize: number;
  label: string;
  setupCostPerUnitSek: number;
  unitMaterialCostSek: number;
  unitElectricityCostSek: number;
  unitManpowerCostSek: number;
  unitToolingAndOverheadSek: number;
  unitTotalCostSek: number;
  unitTotalCostEur: number;
}

export interface ComponentCostOperationRow {
  operationStep: string;
  costElement: string;
  rateAndCalculationBasis: string;
  explicitEquation?: string;
  costSek: number;
  costEur: number;
}

export interface ComponentCostBreakdown {
  itemNumber: number;
  componentName: string;
  quantity: number;
  material: string;
  primaryProcess: string;
  rawMassKg: number;
  netMassKg: number;
  scrapMassKg?: number;
  manufacturingSteps: string[];
  operationCosts: ComponentCostOperationRow[];
  totalComponentCostSek: number;
  totalComponentCostEur: number;
}

export interface PreviewGeometryOverlay {
  kind: 'hole_or_pocket' | 'bore_resize' | 'boss_modify' | 'chamfer_edge' | 'face_offset';
  center: [number, number, number];
  normalOrAxis: [number, number, number];
  currentRadiusMm: number;
  targetRadiusMm: number;
  depthOrOffsetMm: number;
  label: string;
}

export interface PartEngineeringRecommendation {
  id: string;
  title: string;
  category:
    | 'Bore & Fastener Engineering'
    | 'Mass & Pocket Relief'
    | 'Collar & Boss Geometry'
    | 'Edge Break & Stress Relief'
    | 'Datum & Wall Thickness';
  targetFeatureId: string;
  locationOnPart: string;
  currentGeometrySpec: string;
  proposedModificationSpec: string;
  engineeringRationale: string;
  prompt: string;
  badge: string;
  previewGeometry: PreviewGeometryOverlay;
}

export interface CostReductionOpportunity {
  id: string;
  strategyNumber?: number;
  strategyCategory?:
    | 'Raw Stock & Near-Net Blank'
    | 'Tooling & Bore Standardization'
    | 'Cycle-Time & Pocket Relief'
    | 'In-Cycle Edge Break & Setup Reduction';
  title: string;
  componentName: string;
  linkedFeatureId: string | null;
  locationOn3dModel: string;
  currentCostDriver: string;
  recommendation: string;
  featureOrConsideration?: string;
  proposedHypothesis?: string;
  manufacturabilityOrCostRationale?: string;
  functionalOrManufacturingConstraints?: string;
  engineeringValidationRequired?: string;
  manufacturingImpactSummary?: string;
  unverifiedDesignConstraints?: string;
  recalculatedScenarioUnitCostSek?: number;
  estimatedSavingSek: number;
  estimatedSavingEur: number;
  savingPercent: number;
  suggested3dPrompt?: string;
  previewGeometry?: PreviewGeometryOverlay;
}

export type ManufacturingProcessRouteKey =
  | 'BILLET_CNC'
  | 'NEAR_NET_FORGING_CNC'
  | 'PRECISION_BLANK_CNC';

export interface ProcessRouteComparisonRow {
  routeKey: ManufacturingProcessRouteKey;
  routeName: string;
  includedOperationsSummary: string;
  rawMassKg: number;
  netMassKg: number;
  chipRemovalPct: number;
  cycleTimeMin: number;
  setupAndToolingAmortizedSek: number;
  unitMaterialNetSek: number;
  unitConversionAndMachiningSek: number;
  unitTotalCostSek: number;
  unitTotalCostEur: number;
  recommendedForBatchRange: string;
  isSelectedRoute: boolean;
}

export interface CycleTimePhysicsBreakdown {
  cuttingSpeedVcMPerMin: number;
  feedPerToothFzMm: number;
  effectiveSpindleRpm: number;
  tableFeedRateMmPerMin: number;
  roughingMrrCm3PerMin: number;
  finishingAreaRateCm2PerMin: number;
  drillingPenetrationMmPerMin: number;
  removedChipVolumeCm3: number;
  finishedSurfaceAreaCm2: number;
  totalBoreDrillingDepthMm: number;
  toolChangeCount: number;
  roughingTimeMin: number;
  finishingTimeMin: number;
  drillingAndBoringTimeMin: number;
  chamferAndEdgeBreakTimeMin: number;
  toolChangeAndRapidTimeMin: number;
  workholdingLoadUnloadTimeMin: number;
  totalMachiningCycleTimeMin: number;
  setupTimeTotalMin: number;
  setupTimeAmortizedPerPieceMin: number;
  deburrAndCmmInspectionTimeMin: number;
  batchSize: number;
  explicitCycleTimeEquation: string;
}

export interface MarketRateProvenanceRow {
  parameter: string;
  valueFormatted: string;
  unit: string;
  currency: 'SEK' | 'EUR' | 'SEK/EUR';
  rateScope: string;
  sourceAuthority: string;
  applicableDate: string;
  provenanceType:
    | 'Published Benchmark'
    | 'Verified Live FX'
    | 'Engineering Assumption'
    | 'User Override';
}

export interface CostValidationCheckItem {
  checkId: string;
  domain: string;
  label: string;
  status:
    | 'VERIFIED'
    | 'MESH_APPROXIMATION'
    | 'ASSUMED_BASELINE'
    | 'USER_OVERRIDDEN'
    | 'ARITHMETIC_PASSED'
    | 'DISCREPANCY_DETECTED';
  expectedOrExtracted: string;
  actualOrApplied: string;
  verificationNote: string;
}

export interface CostValidationReport {
  isArithmeticValid: boolean;
  overallStatus:
    | 'VALIDATED'
    | 'VALIDATED_WITH_ASSUMPTIONS'
    | 'ENGINEERING_REVIEW_REQUIRED'
    | 'DISCREPANCY_DETECTED';
  authoritativeVolumeCm3: number;
  bomTotalVolumeCm3: number;
  dimensionTableVolumeCm3: number;
  volumeConsistencyPassed: boolean;
  massBalancePassed: boolean;
  operationSumPassed: boolean;
  componentSumPassed: boolean;
  componentIdentityConsistent?: boolean;
  materialDensityPriceConsistent?: boolean;
  stockGeometryContainmentPassed?: boolean;
  machiningCycleEquationsPassed?: boolean;
  routeCompatibilityPassed?: boolean;
  dfmFeatureReferencesPassed?: boolean;
  bomCostAiSyncPassed?: boolean;
  validationMatrix: CostValidationCheckItem[];
}

export interface CombinedInteractingDfmScenario {
  baselineUnitCostSek: number;
  naiveSumOfIndividualSavingsSek: number;
  integratedScenarioUnitCostSek: number;
  integratedScenarioUnitCostEur: number;
  integratedInteractingSavingSek: number;
  integratedInteractingSavingEur: number;
  integratedSavingPercent: number;
  interactionExplanation: string;
}

export interface CostingCustomOverrides {
  materialGradeKey?: 'AL_6082' | 'STEEL_42CRMO4' | 'SS_316L' | 'TI_6AL4V' | 'BRASS_CW614N';
  processRouteKey?: ManufacturingProcessRouteKey;
  batchSize?: number;
  stockAllowanceMm?: number;
  includeHeatTreatment?: boolean;
  roughingMrrCm3PerMin?: number;
  setupTimeMinutes?: number;
  inspectionTimeMinutes?: number;
  electricitySekPerKwh?: number;
  laborSekPerHour?: number;
  machineRateSekPerHour?: number;
  sekPerEur?: number;
  rawMaterialPriceSekPerKg?: number;
  scrapCreditSekPerKg?: number;
  liveFxVerified?: boolean;
  fxDate?: string;
  dataSourceType?:
    | 'live_web_scraped'
    | 'live_fx_and_sweden_benchmarks'
    | 'sweden_industrial_benchmark'
    | 'user_custom_parameters';
  sources?: Array<{ title: string; url: string; snippet: string }>;
}

export interface ManufacturingCostEstimate {
  country: string;
  currencyPrimary: 'SEK';
  currencySecondary: 'EUR';
  exchangeRateSekPerEur: number;
  selectedProcessRouteKey?: ManufacturingProcessRouteKey;
  batchSize?: number;
  stockAllowanceMm?: number;
  includeHeatTreatment?: boolean;
  alignedManufacturingProcess: string;
  assumedOrDeclaredMaterial: string;
  materialKey?: 'AL_6082' | 'STEEL_42CRMO4' | 'SS_316L' | 'TI_6AL4V' | 'BRASS_CW614N';
  materialIsAssumed?: boolean;
  materialDensityGPerCm3: number;
  authoritativeVolumeCm3?: number;
  rawStockVolumeCm3?: number;
  stockValidation?: RawStockGeometryValidation;
  netPartMassGrams: number;
  rawStockMassGrams: number;
  scrapMassGrams: number;
  cycleTimeMinutes: number;
  setupTimeMinutes: number;
  spindlePowerKw: number;
  energyConsumptionKwh: number;
  marketRates: {
    rawMaterialPriceSekPerKg: number;
    rawMaterialPriceEurPerKg: number;
    scrapCreditSekPerKg: number;
    electricityPriceSekPerKwh: number;
    electricityPriceEurPerKwh: number;
    cncOperatorHourlyRateSek: number;
    cncOperatorHourlyRateEur: number;
    camSetupHourlyRateSek: number;
    machineDepreciationHourlySek: number;
    swedishEmployerSocialFeePct: number;
  };
  costBreakdownPerUnit: {
    rawMaterialCostSek: number;
    rawMaterialCostEur: number;
    electricityCostSek: number;
    electricityCostEur: number;
    manpowerCostSek: number;
    manpowerCostEur: number;
    toolingAndMachineDepreciationSek: number;
    toolingAndMachineDepreciationEur: number;
    setupAndCamAmortizedSek: number;
    setupAndCamAmortizedEur: number;
    totalUnitCostSek: number;
    totalUnitCostEur: number;
  };
  componentCostBreakdowns: ComponentCostBreakdown[];
  processRouteComparisons?: ProcessRouteComparisonRow[];
  cycleTimeBreakdown?: CycleTimePhysicsBreakdown;
  rateProvenanceTable?: MarketRateProvenanceRow[];
  validationReport?: CostValidationReport;
  combinedDfmScenario?: CombinedInteractingDfmScenario;
  costReductionOpportunities: CostReductionOpportunity[];
  batchTiers: CostBatchTier[];
  processAlignmentExplanation: string;
  dataSourceType:
    | 'live_web_scraped'
    | 'live_fx_and_sweden_benchmarks'
    | 'sweden_industrial_benchmark'
    | 'user_custom_parameters';
  lastScrapedAt: string;
  sources: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

export interface CadChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  referencedSections?: string[];
}

export interface PartPhotograph {
  viewId: '3d_photo' | 'cad_2d_diagram' | 'isometric' | 'front' | 'side' | 'top' | 'section';
  title: string;
  orientationLabel: string;
  projection: 'Orthographic' | 'Perspective' | '2D CAD Blueprint';
  cameraVector: [number, number, number];
  upVector: [number, number, number];
  dataUrl: string;
  photo3dDataUrl?: string;
  renderEngine: 'Blender bpy API' | 'Connected CAD Studio WebGL Renderer (Three.js PBR)';
  timestamp: string;
  resolution: string;
}

export interface BlenderBridgeReport {
  attempted: boolean;
  blenderConnected: boolean;
  executionMode: 'local_blender_cli' | 'remote_blender_api' | 'webgl_studio_fallback';
  statusMessage: string;
  blenderScriptPy: string;
  endpointTested?: string;
}

export interface PartEngineeringDescription {
  partIdentification: string;
  functionalSummary: string;
  majorGeometricFeatures: string[];
  materialSpecification: {
    value: string;
    source: 'CAD Header Metadata' | 'Not Specified in CAD File';
    notes: string;
  };
  manufacturingProcesses: {
    processName: string;
    suitability: 'Primary Candidate' | 'Secondary Operation' | 'Alternative';
    geometricJustification: string;
  }[];
  machiningConsiderations: string[];
  generatedBy: 'Gemini Multimodal CAD Analysis' | 'Deterministic Geometry Analyzer';
}

export interface CadComponentMeshData {
  index: number;
  name: string;
  partNumber: string;
  materialFromMetadata: string | null;
  colorHex: number;
  positions: Float32Array; // non-indexed or indexed triangle soup (3 floats per vertex)
  normals: Float32Array;
  faceIdPerTriangle: Int32Array; // maps each triangle to feature index
}

export interface CadFileMetadata {
  fileName: string;
  fileSizeBytes: number;
  format: SupportedCadFormat;
  schemaVersion: string;
  unitsDeclared: string;
  authorOrOrg: string | null;
  materialDeclared: string | null;
  headerComments: string[];
  isAssembly: boolean;
  uploadedAt: string;
}

export interface CadModificationRecord {
  id: string;
  timestamp: string;
  userInstruction: string;
  modificationType:
    | 'solid_geometry'
    | 'surface_appearance'
    | 'engineering_annotation'
    | 'unsupported';
  operationName: string;
  targetFeatureId: string | null;
  status: 'applied' | 'no_op_rejected' | 'validation_failed' | 'unsupported_error';
  summary: string;
  technicalDetails: string;
  affectedDimensionIds: string[];
  volumeDeltaCm3?: number;
  displacedVertexCount?: number;
  geometryValidationPassed?: boolean;
  noOpRejected?: boolean;
  appliedDfmOpportunityId?: string;
  estimatedCostSavingSek?: number;
  estimatedCostSavingEur?: number;
}

export interface AuthoritativePartEngineeringModel {
  partIdentity: {
    fileName: string;
    format: SupportedCadFormat;
    revisionNumber: number;
    revisionLabel: string;
    componentNames: string[];
    geometricArchetype: string;
    isIdentityAssumed: boolean;
  };
  geometryAndFeatures: {
    netSolidVolumeCm3: number;
    netSolidVolumeMm3: number;
    surfaceAreaCm2: number;
    boundingBoxMm: [number, number, number];
    volumetricFillRatioPct: number;
    holeCount: number;
    cylindricalSectionCount: number;
    planarDatumCount: number;
    chamferFilletCount: number;
    featureIds: string[];
  };
  cadMaterialMetadata: {
    declaredInCad: string | null;
    source: 'CAD Header Metadata' | 'Scenario Assumption (Not Specified in CAD)';
  };
  activeMaterialAndDensity: {
    materialKey: 'AL_6082' | 'STEEL_42CRMO4' | 'SS_316L' | 'TI_6AL4V' | 'BRASS_CW614N';
    materialName: string;
    densityGPerCm3: number;
    isAssumed: boolean;
    virginPriceSekPerKg: number;
    swarfCreditSekPerKg: number;
    roughingMrrCm3PerMin: number;
    finishingRateCm2PerMin: number;
    drillingRateMmPerMin: number;
  };
  candidateProcesses: {
    selectedRouteKey: ManufacturingProcessRouteKey;
    primaryProcessName: string;
    candidateRoutes: Array<{
      routeKey: ManufacturingProcessRouteKey;
      routeName: string;
      suitabilityReason: string;
    }>;
  };
  rawStockGeometry: RawStockGeometryValidation;
  machiningOperations: {
    includedSteps: string[];
    cycleTimeMinutes: number;
    setupTimeMinutes: number;
    includeHeatTreatment: boolean;
  };
  costingParameters: {
    batchSize: number;
    sekPerEur: number;
    electricitySekPerKwh: number;
    operatorRateSekPerHour: number;
    machineRateSekPerHour: number;
    unitTotalCostSek: number;
    unitTotalCostEur: number;
  };
}

export interface CadModelVersion {
  versionNumber: number;
  versionLabel: string;
  createdAt: string;
  parentVersionNumber: number | null;
  metadata: CadFileMetadata;
  components: CadComponentMeshData[];
  features: CadFaceFeature[];
  dimensions: CadDimensionRow[];
  bom: {
    isMultiComponentAssembly: boolean;
    assemblySummaryNote: string;
    entries: BomEntry[];
  };
  geometryAnalysisReport: GeometryAnalysisReport;
  costEstimate: ManufacturingCostEstimate;
  photographs: PartPhotograph[];
  blenderReport: BlenderBridgeReport;
  description: PartEngineeringDescription;
  annotations: CadEngineeringAnnotation[];
  modificationHistory: CadModificationRecord[];
  engineeringModel?: AuthoritativePartEngineeringModel;
}

