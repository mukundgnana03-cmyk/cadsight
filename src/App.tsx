import React, { useCallback, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Upload,
} from 'lucide-react';
import {
  BlenderBridgeReport,
  CadChatMessage,
  CadModelVersion,
  CadModificationRecord,
  CostingCustomOverrides,
  ManufacturingProcessRouteKey,
  PartEngineeringDescription,
} from './types/cad';
import {
  analyzeCadGeometryAndTopology,
  buildDeterministicDescription,
  computeSwedenManufacturingCostEstimate,
  executeCadModification,
  exportCadModelBlob,
  generatePartAlignedModificationSuggestions,
  ModificationCommandInput,
  parseUploadedCadFile,
  synchronizePartEngineeringData,
  validateCadFile,
} from './lib/cadGeometryEngine';
import { renderOrthographicPartPhotographs } from './lib/studioPhotographRenderer';
import { parseCadInstructionDeterministic } from './lib/cadCommandFallback';
import { CadInteractiveViewer } from './components/CadInteractiveViewer';

export default function App() {
  const [versions, setVersions] = useState<CadModelVersion[]>([]);
  const [activeVersionIndex, setActiveVersionIndex] = useState<number>(0);
  const [uploadSessionId, setUploadSessionId] = useState<number>(0);
  const uploadSessionRef = useRef<number>(0);
  const revealTimersRef = useRef<number[]>([]);

  // Controls how many stages (1..7) have been revealed one-by-one
  const [revealedStageCount, setRevealedStageCount] = useState<number>(0);

  const [isProcessingUpload, setIsProcessingUpload] = useState<boolean>(false);
  const [processingStage, setProcessingStage] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [isolatedComponentIndex, setIsolatedComponentIndex] = useState<number | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [costSelectedFeatureId, setCostSelectedFeatureId] = useState<string | null>(null);
  const [selectedCostOpportunityId, setSelectedCostOpportunityId] = useState<string | null>(null);
  const [instructionInput, setInstructionInput] = useState<string>('');
  const [isModifying, setIsModifying] = useState<boolean>(false);
  const [isScrapingCostRates, setIsScrapingCostRates] = useState<boolean>(false);
  const [costOverrides, setCostOverrides] = useState<CostingCustomOverrides>({});
  const [lastRejectedMod, setLastRejectedMod] = useState<CadModificationRecord | null>(null);
  const [previewSnippet, setPreviewSnippet] = useState<{
    title: string;
    dataUrl: string;
    detail: string;
  } | null>(null);

  // Part Engineering & Cost AI Chatbot state
  const [chatMessages, setChatMessages] = useState<CadChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isChatLoading, setIsChatLoading] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const currentVersion: CadModelVersion | null =
    versions[activeVersionIndex] || versions[versions.length - 1] || null;

  const handleUpdateCostOverrides = (
    patch: Partial<CostingCustomOverrides>,
    resetAll = false
  ) => {
    let nextOverrides: CostingCustomOverrides;
    if (resetAll) {
      nextOverrides = {};
    } else {
      const materialChanged =
        patch.materialGradeKey !== undefined &&
        patch.materialGradeKey !== (costOverrides.materialGradeKey || currentVersion?.costEstimate?.materialKey);
      nextOverrides = {
        ...costOverrides,
        ...(materialChanged
          ? {
              rawMaterialPriceSekPerKg: undefined,
              scrapCreditSekPerKg: undefined,
              roughingMrrCm3PerMin: undefined,
            }
          : {}),
        ...patch,
      };
    }
    setCostOverrides(nextOverrides);

    if (!currentVersion) return;
    setVersions((prev) =>
      prev.map((ver) => {
        const synced = synchronizePartEngineeringData({
          versionNumber: ver.versionNumber,
          versionLabel: ver.versionLabel,
          metadata: ver.metadata,
          components: ver.components,
          features: ver.features,
          dimensions: ver.dimensions,
          baseBom: ver.bom,
          geometryAnalysisReport: ver.geometryAnalysisReport,
          costOverrides: nextOverrides,
          modificationHistory: ver.modificationHistory,
        });
        return {
          ...ver,
          bom: synced.bom,
          geometryAnalysisReport: synced.geometryAnalysisReport,
          costEstimate: synced.costEstimate,
          description: synced.description,
          engineeringModel: synced.engineeringModel,
        };
      })
    );
  };

  const runBlenderBridge = async (
    partName: string,
    bboxMm: [number, number, number]
  ): Promise<BlenderBridgeReport> => {
    try {
      const resp = await fetch('/api/blender/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partName, bboxMm }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch {
      return {
        attempted: true,
        blenderConnected: false,
        executionMode: 'webgl_studio_fallback',
        statusMessage: 'Rendered via Connected CAD Studio Engine.',
        blenderScriptPy: '',
      };
    }
  };

  const triggerGeminiPartAnalysis = async (version: CadModelVersion, sessionId: number) => {
    try {
      const resp = await fetch('/api/cad/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: version.metadata,
          dimensions: version.dimensions,
          features: version.features,
          bom: version.bom,
          photographs: version.photographs,
        }),
      });
      if (!resp.ok || uploadSessionRef.current !== sessionId) return;
      const aiDesc: any = await resp.json();
      if (
        !aiDesc ||
        aiDesc.fallback ||
        !aiDesc.partIdentification ||
        !Array.isArray(aiDesc.majorGeometricFeatures) ||
        uploadSessionRef.current !== sessionId
      ) {
        return;
      }
      // Keep authoritative partIdentification, functionalSummary, majorGeometricFeatures,
      // materialSpecification, and manufacturingProcesses strictly bound to synchronizePartEngineeringData
      // so AI text generation can never contradict the authoritative engineering model.
      setVersions((prev) =>
        prev.map((v) =>
          v.versionNumber === version.versionNumber && v.metadata.fileName === version.metadata.fileName
            ? {
                ...v,
                description: {
                  ...v.description,
                  machiningConsiderations:
                    Array.isArray(aiDesc.machiningConsiderations) &&
                    aiDesc.machiningConsiderations.length > 0
                      ? aiDesc.machiningConsiderations
                      : v.description.machiningConsiderations,
                },
              }
            : v
        )
      );
    } catch {
      // Keep deterministic geometry description if AI call fails
    }
  };

  const handleProcessCadFile = useCallback(async (file: File) => {
    setUploadError(null);

    const validation = validateCadFile(file);
    if (!validation.valid) {
      setUploadError(validation.errorMessage || 'Invalid CAD file.');
      return;
    }

    // Clear any pending timers and immediately reset all previous part state
    revealTimersRef.current.forEach((id) => window.clearTimeout(id));
    revealTimersRef.current = [];

    const nextSessionId = uploadSessionRef.current + 1;
    uploadSessionRef.current = nextSessionId;
    setUploadSessionId(nextSessionId);

    setVersions([]);
    setActiveVersionIndex(0);
    setSelectedFeatureId(null);
    setSelectedRecommendationId(null);
    setCostSelectedFeatureId(null);
    setSelectedCostOpportunityId(null);
    setIsolatedComponentIndex(null);
    setInstructionInput('');
    setCostOverrides({});
    setLastRejectedMod(null);
    setPreviewSnippet(null);
    setChatMessages([]);
    setChatInput('');
    setIsProcessingUpload(true);
    setRevealedStageCount(0);

    try {
      setProcessingStage(`Stage 1/7: Generating 2D Orthographic Drawings & 3D Analysis for ${file.name}...`);
      const { metadata, components } = await parseUploadedCadFile(file);
      const analyzed = analyzeCadGeometryAndTopology(metadata, components);
      const synced = synchronizePartEngineeringData({
        versionNumber: 1,
        versionLabel: 'v1 (Original)',
        metadata,
        components,
        features: analyzed.features,
        dimensions: analyzed.dimensions,
        baseBom: analyzed.bom,
        geometryAnalysisReport: analyzed.geometryAnalysisReport,
        costOverrides: {},
        modificationHistory: [],
      });

      const { features, dimensions } = analyzed;
      const { bom, geometryAnalysisReport, costEstimate, description: initialDescription, engineeringModel } = synced;

      const envX = dimensions.find((d) => d.id === 'DIM-ENV-X')?.value || 80;
      const envY = dimensions.find((d) => d.id === 'DIM-ENV-Y')?.value || 80;
      const envZ = dimensions.find((d) => d.id === 'DIM-ENV-Z')?.value || 28;

      const [blenderReport, photographs] = await Promise.all([
        runBlenderBridge(metadata.fileName, [envX, envY, envZ]),
        renderOrthographicPartPhotographs(components, features, metadata.fileName, 1, dimensions, metadata),
      ]);

      if (uploadSessionRef.current !== nextSessionId) return;

      const v1: CadModelVersion = {
        versionNumber: 1,
        versionLabel: 'v1 (Original)',
        createdAt: new Date().toISOString(),
        parentVersionNumber: null,
        metadata,
        components,
        features,
        dimensions,
        bom,
        geometryAnalysisReport,
        costEstimate,
        photographs,
        blenderReport,
        description: initialDescription,
        annotations: [],
        modificationHistory: [],
        engineeringModel,
      };

      setVersions([v1]);
      setActiveVersionIndex(0);
      setSelectedFeatureId(null);
      setSelectedRecommendationId(null);
      setCostSelectedFeatureId(costEstimate.costReductionOpportunities[0]?.linkedFeatureId || null);
      setSelectedCostOpportunityId(costEstimate.costReductionOpportunities[0]?.id || null);
      setIsolatedComponentIndex(null);
      setIsProcessingUpload(false);
      setProcessingStage('');

      // Initialize the Part Engineering and Cost Assistant with a concise 3D-grounded summary of the uploaded part
      setChatMessages([
        {
          id: `MSG-INIT-${Date.now()}`,
          role: 'assistant',
          content: `Loaded **${metadata.fileName}** (${metadata.format}) — Revision **v1**.\n• **3D Dimension Extraction Basis**: Measured directly from the 3D CAD model coordinates — Overall Envelope **${envX.toFixed(2)} × ${envY.toFixed(2)} × ${envZ.toFixed(2)} mm** | Enclosed 3D Solid Volume **${costEstimate.authoritativeVolumeCm3 ?? geometryAnalysisReport.materialVolumeEstimates.netSolidVolumeCm3} cm³**\n• **BOM & Manufacturing Route**: ${bom.entries.length} BOM component(s) → **${costEstimate.alignedManufacturingProcess}**\n• **Material & Specifications**: *${costEstimate.assumedOrDeclaredMaterial}* (${costEstimate.materialDensityGPerCm3} g/cm³) — ${metadata.materialDeclared ? 'Extracted from CAD file metadata' : 'Predicted / Assumed for costing because material & 2D tolerances are not embedded in the 3D geometry'}\n• **Final Part Cost (Sum of BOM Components, N=${costEstimate.batchSize ?? 10} pcs)**: **${costEstimate.costBreakdownPerUnit.totalUnitCostSek.toFixed(2)} SEK** (€${costEstimate.costBreakdownPerUnit.totalUnitCostEur.toFixed(2)} EUR)\n\nAsk any question about the ${metadata.fileName} part.`,
          timestamp: new Date().toISOString(),
          referencedSections: [
            'Stage 1: 3D-to-2D Views & 3D Extracted Dimensions',
            'Stage 4: Consolidated Bill of Materials',
            'Stage 6: Component & Final Part Cost Calculation',
          ],
        },
      ]);

      // Reveal outputs one by one sequentially up to Stage 7
      setRevealedStageCount(1);
      triggerGeminiPartAnalysis(v1, nextSessionId);

      revealTimersRef.current = [
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 2)), 380),
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 3)), 760),
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 4)), 1140),
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 5)), 1520),
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 6)), 1900),
        window.setTimeout(() => setRevealedStageCount((c) => Math.max(c, 7)), 2250),
      ];
    } catch (err: any) {
      setIsProcessingUpload(false);
      setProcessingStage('');
      setUploadError(err?.message || 'Failed to parse CAD file.');
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleProcessCadFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleProcessCadFile(file);
    }
  };

  const handleExecuteModification = async (
    customPrompt?: string,
    targetFeatureOverride?: string | null,
    dfmMeta?: {
      opportunityId?: string;
      estimatedSavingSek?: number;
      estimatedSavingEur?: number;
    }
  ) => {
    const promptToRun = (customPrompt ?? instructionInput).trim();
    if (!promptToRun || !currentVersion || isModifying) return;

    const effectiveFeatureId =
      targetFeatureOverride !== undefined ? targetFeatureOverride : selectedFeatureId;

    setIsModifying(true);
    setLastRejectedMod(null);
    try {
      let command: ModificationCommandInput;
      try {
        const resp = await fetch('/api/cad/modify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction: promptToRun,
            selectedFeatureId: effectiveFeatureId,
            features: currentVersion.features,
          }),
        });
        if (resp.ok) {
          command = await resp.json();
        } else {
          command = parseCadInstructionDeterministic(
            promptToRun,
            effectiveFeatureId,
            currentVersion.features
          );
        }
      } catch {
        command = parseCadInstructionDeterministic(
          promptToRun,
          effectiveFeatureId,
          currentVersion.features
        );
      }

      const modOutcome = executeCadModification(
        promptToRun,
        command,
        currentVersion.components,
        currentVersion.features,
        currentVersion.annotations
      );

      if (dfmMeta) {
        modOutcome.record.appliedDfmOpportunityId = dfmMeta.opportunityId;
        modOutcome.record.estimatedCostSavingSek = dfmMeta.estimatedSavingSek;
        modOutcome.record.estimatedCostSavingEur = dfmMeta.estimatedSavingEur;
      }

      if (!modOutcome.success) {
        // Reject no-op or invalid modifications WITHOUT creating a new geometry revision!
        setLastRejectedMod(modOutcome.record);
        const updatedHistory = [...currentVersion.modificationHistory, modOutcome.record];
        setVersions((prev) =>
          prev.map((v, idx) =>
            idx === activeVersionIndex ? { ...v, modificationHistory: updatedHistory } : v
          )
        );
        setInstructionInput('');
        setIsModifying(false);
        return;
      }

      const prevHoleIds = new Set(
        currentVersion.features.filter((f) => f.type === 'hole').map((f) => f.id)
      );

      const reanalyzed = analyzeCadGeometryAndTopology(
        currentVersion.metadata,
        modOutcome.newComponents,
        currentVersion.dimensions
      );

      // Identify the newly created or modified feature so we can highlight and select it in the 3D viewer!
      let autoHighlightFeatureId: string | null = null;
      if (command.operation === 'add_hole') {
        const newlyDrilledHole =
          reanalyzed.features.find((f) => f.type === 'hole' && !prevHoleIds.has(f.id)) ||
          reanalyzed.features.filter((f) => f.type === 'hole').slice(-1)[0];
        if (newlyDrilledHole) {
          autoHighlightFeatureId = newlyDrilledHole.id;
          modOutcome.featureMachiningHighlights[newlyDrilledHole.id] = true;
          modOutcome.record.targetFeatureId = `${modOutcome.record.targetFeatureId || ''} → ${newlyDrilledHole.id}`;
        }
      } else if (modOutcome.record.targetFeatureId) {
        const firstId = modOutcome.record.targetFeatureId.split(',')[0].trim();
        if (reanalyzed.features.some((f) => f.id === firstId)) {
          autoHighlightFeatureId = firstId;
          modOutcome.featureMachiningHighlights[firstId] = true;
        }
      }

      for (const feat of reanalyzed.features) {
        if (modOutcome.featureFinishOverrides[feat.id]) {
          feat.surfaceFinish = modOutcome.featureFinishOverrides[feat.id];
        }
        if (modOutcome.featureMachiningHighlights[feat.id]) {
          feat.requiresMachiningHighlight = true;
        }
      }

      const nextVerNum = versions.length + 1;
      const nextVerLabel = `v${nextVerNum} (${modOutcome.record.operationName})`;
      const newPhotos = await renderOrthographicPartPhotographs(
        modOutcome.newComponents,
        reanalyzed.features,
        currentVersion.metadata.fileName,
        nextVerNum,
        reanalyzed.dimensions,
        currentVersion.metadata
      );

      const nextHistory = [...currentVersion.modificationHistory, modOutcome.record];

      const syncedMod = synchronizePartEngineeringData({
        versionNumber: nextVerNum,
        versionLabel: nextVerLabel,
        metadata: currentVersion.metadata,
        components: modOutcome.newComponents,
        features: reanalyzed.features,
        dimensions: reanalyzed.dimensions,
        baseBom: reanalyzed.bom,
        geometryAnalysisReport: reanalyzed.geometryAnalysisReport,
        costOverrides,
        modificationHistory: nextHistory,
      });

      const newVersion: CadModelVersion = {
        versionNumber: nextVerNum,
        versionLabel: nextVerLabel,
        createdAt: new Date().toISOString(),
        parentVersionNumber: currentVersion.versionNumber,
        metadata: currentVersion.metadata,
        components: modOutcome.newComponents,
        features: reanalyzed.features,
        dimensions: reanalyzed.dimensions,
        bom: syncedMod.bom,
        geometryAnalysisReport: syncedMod.geometryAnalysisReport,
        costEstimate: syncedMod.costEstimate,
        photographs: newPhotos,
        blenderReport: currentVersion.blenderReport,
        description: syncedMod.description,
        annotations: modOutcome.updatedAnnotations,
        modificationHistory: nextHistory,
        engineeringModel: syncedMod.engineeringModel,
      };

      setVersions((prev) => [...prev, newVersion]);
      setActiveVersionIndex(versions.length);
      setSelectedFeatureId(autoHighlightFeatureId);
      setSelectedRecommendationId(null);
      setCostSelectedFeatureId(autoHighlightFeatureId);
      setSelectedCostOpportunityId(null);
      setInstructionInput('');
    } finally {
      setIsModifying(false);
    }
  };

  const handleRefreshSwedenWebScrapedRates = async () => {
    if (!currentVersion || isScrapingCostRates) return;
    setIsScrapingCostRates(true);
    try {
      const activeMatKey =
        costOverrides.materialGradeKey || currentVersion.costEstimate.materialKey || 'AL_6082';
      const resp = await fetch('/api/cad/cost-estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialGradeKey: activeMatKey,
          manufacturingProcess: currentVersion.costEstimate.alignedManufacturingProcess,
        }),
      });
      if (resp.ok) {
        const scraped = await resp.json();
        const nextOverrides: CostingCustomOverrides = {
          ...costOverrides,
          materialGradeKey: activeMatKey,
          electricitySekPerKwh: scraped.electricitySekPerKwh,
          laborSekPerHour: scraped.laborSekPerHour,
          sekPerEur: scraped.sekPerEur,
          rawMaterialPriceSekPerKg: scraped.rawMaterialPriceSekPerKg,
          scrapCreditSekPerKg: scraped.scrapCreditSekPerKg,
          dataSourceType: scraped.liveFxVerified
            ? 'live_fx_and_sweden_benchmarks'
            : 'sweden_industrial_benchmark',
          liveFxVerified: Boolean(scraped.liveFxVerified),
          fxDate: scraped.fxDate,
          sources: scraped.sources,
        };
        setCostOverrides(nextOverrides);
        setVersions((prev) =>
          prev.map((v) => {
            const synced = synchronizePartEngineeringData({
              versionNumber: v.versionNumber,
              versionLabel: v.versionLabel,
              metadata: v.metadata,
              components: v.components,
              features: v.features,
              dimensions: v.dimensions,
              baseBom: v.bom,
              geometryAnalysisReport: v.geometryAnalysisReport,
              costOverrides: nextOverrides,
              modificationHistory: v.modificationHistory,
            });
            return {
              ...v,
              bom: synced.bom,
              geometryAnalysisReport: synced.geometryAnalysisReport,
              costEstimate: synced.costEstimate,
              description: synced.description,
              engineeringModel: synced.engineeringModel,
            };
          })
        );
      }
    } catch {
      // Keep current benchmark on network error
    } finally {
      setIsScrapingCostRates(false);
    }
  };

  const handleAskPartChatbot = async (customQuestion?: string) => {
    const q = (customQuestion ?? chatInput).trim();
    if (!q || !currentVersion || isChatLoading) return;

    const userMsg: CadChatMessage = {
      id: `MSG-U-${Date.now()}`,
      role: 'user',
      content: q,
      timestamp: new Date().toISOString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    if (!customQuestion) setChatInput('');
    setIsChatLoading(true);

    try {
      const partContext = {
        versionLabel: currentVersion.versionLabel,
        metadata: currentVersion.metadata,
        engineeringModel: currentVersion.engineeringModel,
        description: currentVersion.description,
        geometryAnalysisReport: currentVersion.geometryAnalysisReport,
        dimensions: currentVersion.dimensions.map((d) => ({
          id: d.id,
          parameter: d.parameter,
          value: d.value,
          formattedValue: d.formattedValue,
          unit: d.unit,
          geometricReference: d.geometricReference,
        })),
        bomEntries: currentVersion.bom.entries,
        features: currentVersion.features.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          diameterMm: f.diameterMm,
          depthOrLengthMm: f.depthOrLengthMm,
          areaMm2: f.areaMm2,
          angularCoverageDeg: f.angularCoverageDeg,
        })),
        costEstimate: currentVersion.costEstimate,
        modifications: currentVersion.modificationHistory,
      };

      const resp = await fetch('/api/cad/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, partContext }),
      });
      const data = await resp.json();
      const assistantMsg: CadChatMessage = {
        id: `MSG-A-${Date.now()}`,
        role: 'assistant',
        content: data.answer || 'Processed your engineering question based on the 3D CAD geometry.',
        timestamp: new Date().toISOString(),
        referencedSections: data.referencedSections,
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `MSG-E-${Date.now()}`,
          role: 'assistant',
          content: `Based on the loaded 3D geometry of **${currentVersion.metadata.fileName}** (${currentVersion.versionLabel}), the part envelope is ${currentVersion.geometryAnalysisReport.boundingDimensionsMm.lengthX} × ${currentVersion.geometryAnalysisReport.boundingDimensionsMm.widthY} × ${currentVersion.geometryAnalysisReport.boundingDimensionsMm.heightZ} mm, the net solid volume is **${currentVersion.costEstimate.authoritativeVolumeCm3} cm³**, and the scenario-based manufacturing cost estimate per piece is **${currentVersion.costEstimate.costBreakdownPerUnit.totalUnitCostSek} SEK** (€${currentVersion.costEstimate.costBreakdownPerUnit.totalUnitCostEur} EUR).`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleDownloadModel = (format: 'stl_binary' | 'stl_ascii' | 'obj') => {
    if (!currentVersion) return;
    const { blob, extension } = exportCadModelBlob(currentVersion.components, format);
    const baseName = currentVersion.metadata.fileName.replace(/\.[^/.]+$/, '');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}_v${currentVersion.versionNumber}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Simple Top Bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-6 px-6 py-3.5 bg-slate-950/95 border-b border-slate-800">
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-slate-100 font-display whitespace-nowrap shrink-0"
        >
          CADSight
        </a>

        {currentVersion ? (
          <nav className="hidden lg:flex items-center gap-5 text-xs font-mono text-slate-400">
            <a href="#stage-1" className="hover:text-slate-100 whitespace-nowrap shrink-0">
              1. 2D Drawings
            </a>
            <a href="#stage-2" className="hover:text-slate-100 whitespace-nowrap shrink-0">
              2. Description
            </a>
            <a href="#stage-4" className="hover:text-slate-100 whitespace-nowrap shrink-0">
              Consolidated BOM
            </a>
            <a href="#stage-5" className="hover:text-slate-100 whitespace-nowrap shrink-0">
              Interactive 3D Modification
            </a>
            <a href="#stage-6" className="hover:text-amber-400 text-amber-300/90 whitespace-nowrap shrink-0">
              Per-Piece Manufacturing Cost
            </a>
            <a href="#stage-7" className="hover:text-sky-400 text-sky-300/90 whitespace-nowrap shrink-0">
              Part Engineering &amp; Cost Assistant
            </a>
          </nav>
        ) : (
          <div />
        )}

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 rounded-lg hover:bg-amber-400 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload CAD File</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".stp,.step,.p21,.catproduct,.catpart,.cgr,.3dxml,.model,.sldprt,.sldasm,.slddrw,.stl,.iges,.igs,.brep,.brp,.ipt,.iam,.prt,.asm,.x_t,.x_b,.xmt_txt,.xmt_bin,.sat,.sab,.jt,.3mf,.ply,.dae,.fbx,.wrl,.vrml,.obj,.gltf,.glb"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      </header>

      <main id="top" className="flex-1 max-w-[1280px] w-full mx-auto px-6 py-8 space-y-10">
        {/* Clean CAD Upload Box */}
        <section className="max-w-2xl mx-auto">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-700 hover:border-amber-500 bg-slate-900/70 rounded-xl p-8 text-center cursor-pointer transition-colors"
          >
            <Upload className="w-8 h-8 text-amber-400 mx-auto mb-3" />
            <div className="text-base font-semibold text-slate-100 font-display">
              {currentVersion
                ? `Uploaded: ${currentVersion.metadata.fileName}`
                : 'Upload CAD 3D Model (.STP, .STEP, .CATProduct, .CATPart, .SLDPRT, .STL, .IGES)'}
            </div>
            <div className="text-xs text-slate-400 mt-1 font-mono">
              Click or drag and drop your CAD file here
            </div>

            {versions.length > 1 && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-center gap-2"
              >
                <span className="text-xs font-mono text-slate-400">Version:</span>
                {versions.map((ver, idx) => (
                  <button
                    key={ver.versionNumber}
                    type="button"
                    onClick={() => setActiveVersionIndex(idx)}
                    className={`px-2.5 py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                      idx === activeVersionIndex
                        ? 'bg-amber-500 text-slate-950 font-semibold'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    v{ver.versionNumber}
                  </button>
                ))}
              </div>
            )}
          </div>

          {uploadError && (
            <div className="mt-3 p-3.5 bg-rose-950/60 border border-rose-800 rounded-lg text-xs font-mono text-rose-200">
              {uploadError}
            </div>
          )}

          {isProcessingUpload && (
            <div className="mt-3 p-3.5 bg-slate-900 border border-slate-800 rounded-lg flex items-center justify-center gap-2.5 text-xs font-mono text-slate-300">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              <span>{processingStage}</span>
            </div>
          )}
        </section>

        {/* Stage-by-Stage Sequential Outputs */}
        {currentVersion && (
          <div key={uploadSessionId} className="space-y-10">
            {/* STAGE 1: MANUFACTURING 2D ENGINEERING DRAWING & SEPARATE GEOMETRY ANALYSIS REPORT */}
            {revealedStageCount >= 1 && (() => {
              const topPhoto = currentVersion.photographs.find((p) => p.viewId === 'top');
              const sectionPhoto = currentVersion.photographs.find((p) => p.viewId === 'section');
              const frontPhoto = currentVersion.photographs.find((p) => p.viewId === 'front');
              const sidePhoto = currentVersion.photographs.find((p) => p.viewId === 'side');
              const isoPhoto = currentVersion.photographs.find((p) => p.viewId === 'isometric');
              const report = currentVersion.geometryAnalysisReport;

              return (
                <div id="stage-1" className="space-y-8">
                  {/* DELIVERABLE 1A: CLEAN THIRD-ANGLE MANUFACTURING 2D ENGINEERING DRAWING & 3D PART PHOTOGRAPHS */}
                  <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                      <div>
                        <h2 className="text-lg font-bold text-slate-100 font-display">
                          1A. 3D-to-2D Engineering Views &amp; 3D Part Photographs — {currentVersion.metadata.fileName}
                        </h2>
                        <p className="text-xs font-mono text-slate-400 mt-0.5">
                          Projected directly from the 3D CAD model · Top View (+Z), Section View (Plane A-A), Front View (-Y), Side View (+X) &amp; ISO View
                        </p>
                      </div>
                      <span className="text-xs font-mono text-amber-400 bg-amber-950/50 border border-amber-800/60 px-2.5 py-1 rounded">
                        {currentVersion.versionLabel}
                      </span>
                    </div>

                    <div className="p-3.5 rounded-lg bg-slate-950 border border-sky-800/60 text-xs text-slate-200 leading-relaxed">
                      <span className="font-mono font-bold text-sky-400 uppercase">
                        How Views &amp; Dimensions Are Extracted (3D vs. 2D):{' '}
                      </span>
                      We first read the <span className="font-semibold text-slate-100">3D CAD model geometry</span> in 3D space (millimeters) and project it onto standard 2D orthographic views (Top, Front, Side, and Section A-A). All dimensions are <span className="font-semibold text-emerald-300">measured directly from the 3D CAD model coordinates</span> — not estimated from 2D pixels — so every 2D view callout correlates 1:1 with the actual 3D solid.
                    </div>

                    {/* Primary Row: 3D Part Photograph (ISO View) + Master Third-Angle 2D Engineering Drawing Sheet */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {currentVersion.photographs
                        .filter((p) => p.viewId === '3d_photo' || p.viewId === 'cad_2d_diagram')
                        .map((photo) => (
                          <div
                            key={`${uploadSessionId}_${currentVersion.versionNumber}_${photo.viewId}`}
                            className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setPreviewSnippet({
                                  title: `${photo.title} — ${photo.projection}`,
                                  dataUrl: photo.dataUrl,
                                  detail: photo.orientationLabel,
                                })
                              }
                              className="relative group w-full cursor-pointer bg-slate-950 overflow-hidden"
                            >
                              <img
                                src={photo.dataUrl}
                                alt={photo.title}
                                referrerPolicy="no-referrer"
                                className="w-full aspect-4/3 object-contain group-hover:scale-[1.01] transition-transform"
                              />
                              <span className="absolute top-2.5 right-2.5 px-2 py-1 rounded bg-slate-900/90 border border-slate-700 text-[10px] font-mono text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                Click to Enlarge
                              </span>
                            </button>
                            <div className="px-3.5 py-2.5 border-t border-slate-800 flex items-center justify-between text-xs mt-auto">
                              <div>
                                <span className="font-semibold text-slate-100">{photo.title}</span>
                                <span className="ml-2 font-mono text-slate-400">({photo.projection})</span>
                              </div>
                              <a
                                href={photo.dataUrl}
                                download={`${currentVersion.metadata.fileName}_${photo.viewId}.png`}
                                className="font-mono text-amber-400 hover:underline shrink-0 ml-2"
                              >
                                Save PNG
                              </a>
                            </div>
                          </div>
                        ))}
                    </div>

                    {/* 3D Part Photographs Strip: Top View, Section View, Front View, Side View & ISO View */}
                    <div className="space-y-3 pt-2 border-t border-slate-800/80">
                      <div>
                        <h3 className="text-sm font-bold uppercase tracking-wider text-sky-400 font-mono">
                          3D Part Photographs — Top View, Section View, Front View, Side View &amp; ISO View
                        </h3>
                        <p className="text-xs text-slate-400">
                          Rendered directly from the 3D mesh with true camera orientation: Top View from the top (+Z), Front View from the front (-Y), Side View from the side (+X), Section View cut along Plane A-A, and ISO View.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                        {[topPhoto, sectionPhoto, frontPhoto, sidePhoto, isoPhoto]
                          .filter((p): p is NonNullable<typeof p> => Boolean(p))
                          .map((photo) => {
                            const photo3dUrl = photo.photo3dDataUrl || photo.dataUrl;
                            return (
                              <div
                                key={`3d-strip-${photo.viewId}`}
                                className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col"
                              >
                                <div className="px-3 py-1.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                                  <span className="text-xs font-mono font-bold text-slate-100">
                                    {photo.title}
                                  </span>
                                  <span className="text-[10px] font-mono text-sky-400">
                                    3D Photo
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPreviewSnippet({
                                      title: `${photo.title} — 3D Part Photograph`,
                                      dataUrl: photo3dUrl,
                                      detail: photo.orientationLabel,
                                    })
                                  }
                                  className="relative group w-full cursor-pointer bg-slate-950"
                                >
                                  <img
                                    src={photo3dUrl}
                                    alt={`${photo.title} 3D Photograph`}
                                    referrerPolicy="no-referrer"
                                    className="w-full aspect-4/3 object-contain"
                                  />
                                  <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-[9px] font-mono text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                    Enlarge
                                  </span>
                                </button>
                                <div className="px-3 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400">
                                  <span className="truncate">{photo.title}</span>
                                  <a
                                    href={photo3dUrl}
                                    download={`${currentVersion.metadata.fileName}_${photo.viewId}_3d_photo.png`}
                                    className="text-amber-400 hover:underline shrink-0 ml-2"
                                  >
                                    Save
                                  </a>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Aligned Views Grid: Top View, Section View, Front View, Side View (Each showing 2D CAD View + 3D Part Photograph side-by-side) */}
                    <div className="space-y-3 pt-2 border-t border-slate-800/80">
                      <div>
                        <h3 className="text-sm font-bold uppercase tracking-wider text-amber-400 font-mono">
                          Top View, Section View, Front View &amp; Side View (2D CAD View + 3D Part Photograph)
                        </h3>
                        <p className="text-xs text-slate-400">
                          Top View is aligned vertically above the Front View; Side View is aligned horizontally to the right of the Front View; Section View shows the internal cross-section cut along Plane A-A. Each view displays both the 2D CAD projection and the matched 3D part photograph.
                        </p>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {[topPhoto, sectionPhoto, frontPhoto, sidePhoto]
                          .filter((p): p is NonNullable<typeof p> => Boolean(p))
                          .map((photo) => {
                            const photo3dUrl = photo.photo3dDataUrl || photo.dataUrl;
                            return (
                              <div
                                key={photo.viewId}
                                className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col"
                              >
                                <div className="px-3.5 py-2 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between">
                                  <span className="text-xs font-mono font-bold text-slate-100">
                                    {photo.title}
                                  </span>
                                  <span className="text-[11px] font-mono text-amber-400">
                                    2D CAD + 3D Photograph
                                  </span>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-800">
                                  {/* Left: 2D CAD Engineering View */}
                                  <div className="flex flex-col">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPreviewSnippet({
                                          title: `${photo.title} — 2D CAD View`,
                                          dataUrl: photo.dataUrl,
                                          detail: photo.orientationLabel,
                                        })
                                      }
                                      className="relative group w-full cursor-pointer bg-slate-950"
                                    >
                                      <img
                                        src={photo.dataUrl}
                                        alt={`${photo.title} 2D CAD`}
                                        referrerPolicy="no-referrer"
                                        className="w-full aspect-4/3 object-contain"
                                      />
                                      <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-[10px] font-mono text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                        Enlarge 2D CAD
                                      </span>
                                    </button>
                                    <div className="px-3 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400">
                                      <span>{photo.title} (2D CAD)</span>
                                      <a
                                        href={photo.dataUrl}
                                        download={`${currentVersion.metadata.fileName}_${photo.viewId}_2d_cad.png`}
                                        className="text-amber-400 hover:underline"
                                      >
                                        Save 2D
                                      </a>
                                    </div>
                                  </div>

                                  {/* Right: Matched 3D Part Photograph */}
                                  <div className="flex flex-col">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPreviewSnippet({
                                          title: `${photo.title} — 3D Part Photograph`,
                                          dataUrl: photo3dUrl,
                                          detail: photo.orientationLabel,
                                        })
                                      }
                                      className="relative group w-full cursor-pointer bg-slate-950"
                                    >
                                      <img
                                        src={photo3dUrl}
                                        alt={`${photo.title} 3D Photograph`}
                                        referrerPolicy="no-referrer"
                                        className="w-full aspect-4/3 object-contain"
                                      />
                                      <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-[10px] font-mono text-sky-300 opacity-0 group-hover:opacity-100 transition-opacity">
                                        Enlarge 3D Photo
                                      </span>
                                    </button>
                                    <div className="px-3 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400">
                                      <span>{photo.title} (3D Photo)</span>
                                      <a
                                        href={photo3dUrl}
                                        download={`${currentVersion.metadata.fileName}_${photo.viewId}_3d_photo.png`}
                                        className="text-sky-400 hover:underline"
                                      >
                                        Save 3D
                                      </a>
                                    </div>
                                  </div>
                                </div>

                                <div className="px-3.5 py-1.5 border-t border-slate-800 bg-slate-900/50 text-[11px] text-slate-400 font-mono">
                                  {photo.orientationLabel}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* ISO View Card */}
                    {isoPhoto && (
                      <div className="pt-2 border-t border-slate-800/80">
                        <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col sm:flex-row items-center justify-between p-3 gap-4">
                          <div className="flex items-center gap-4">
                            <img
                              src={isoPhoto.photo3dDataUrl || isoPhoto.dataUrl}
                              alt={isoPhoto.title}
                              referrerPolicy="no-referrer"
                              onClick={() =>
                                setPreviewSnippet({
                                  title: `${isoPhoto.title} — 3D Part Photograph`,
                                  dataUrl: isoPhoto.photo3dDataUrl || isoPhoto.dataUrl,
                                  detail: isoPhoto.orientationLabel,
                                })
                              }
                              className="w-32 h-24 object-contain rounded border border-slate-800 cursor-pointer hover:border-amber-500 transition-colors"
                            />
                            <div>
                              <div className="text-xs font-mono font-bold text-slate-200">
                                {isoPhoto.title} — 3D Part Photograph ({isoPhoto.projection})
                              </div>
                              <div className="text-xs text-slate-400 mt-0.5">
                                {isoPhoto.orientationLabel}
                              </div>
                            </div>
                          </div>
                          <a
                            href={isoPhoto.photo3dDataUrl || isoPhoto.dataUrl}
                            download={`${currentVersion.metadata.fileName}_iso_view.png`}
                            className="px-3 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs font-mono text-amber-400 hover:bg-slate-800 shrink-0"
                          >
                            Save ISO View
                          </a>
                        </div>
                      </div>
                    )}
                  </section>

                  {/* DELIVERABLE 1B: CONCISE GEOMETRIC FEATURE EXTRACTION & ENGINEERING SUMMARY */}
                  {(() => {
                    const holeFeatures = currentVersion.features.filter(
                      (f) => f.type === 'hole' && f.diameterMm
                    );
                    const bossFeatures = currentVersion.features.filter(
                      (f) => f.type === 'boss' && f.diameterMm
                    );
                    const planarFeatures = currentVersion.features
                      .filter((f) => f.type === 'planar_face')
                      .sort((a, b) => b.areaMm2 - a.areaMm2);
                    const chamferFeatures = currentVersion.features.filter(
                      (f) => f.type === 'chamfer'
                    );
                    const filletFeatures = currentVersion.features.filter(
                      (f) => f.type === 'fillet'
                    );
                    const spacingDims = currentVersion.dimensions.filter(
                      (d) => d.category === 'Feature Position & Spacing'
                    );
                    const largeCavityBores = holeFeatures.filter(
                      (h) => (h.diameterMm || 0) >= 18.0
                    );

                    return (
                      <section
                        id="geometry-analysis-report"
                        className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                          <div>
                            <h2 className="text-lg font-bold text-slate-100 font-display">
                              1B. 3D-Extracted Dimensions &amp; Engineering Specifications Summary
                            </h2>
                            <p className="text-xs font-mono text-slate-400 mt-0.5">
                              Overall dimensions and features measured directly from the 3D CAD model vs. specifications predicted/assumed when not present in the 3D file
                            </p>
                          </div>
                          <span className="text-xs font-mono text-emerald-300 bg-emerald-950/50 border border-emerald-800/60 px-2.5 py-1 rounded">
                            Measured from 3D CAD Model
                          </span>
                        </div>

                        {/* Clear Explanation of 3D Measurement vs Predicted Specifications */}
                        <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300 leading-relaxed space-y-1">
                          <div>
                            <span className="font-mono font-bold text-emerald-400">
                              1. Measured Directly from the 3D CAD Model:{' '}
                            </span>
                            Overall bounding dimensions (ΔX × ΔY × ΔZ), enclosed 3D solid volume, total 3D surface area, and cylindrical bore/boss diameters are computed directly in 3D space from the uploaded CAD geometry and correlated to the 2D views above.
                          </div>
                          <div>
                            <span className="font-mono font-bold text-amber-300">
                              2. Predicted / Assumed When Not in the 3D CAD Model:{' '}
                            </span>
                            A 3D CAD geometry file defines 3D shape and volume, but often does not embed 2D drawing notes such as exact alloy temper, GD&amp;T fit tolerances (e.g., H7/g6), thread pitch callouts, or surface roughness (Ra). Any such specification is explicitly labeled as <span className="font-mono text-amber-300 font-semibold">Predicted / Assumed</span> below.
                          </div>
                        </div>

                        {/* 1. Overall Dimensions & Volume (Measured from 3D CAD Geometry) */}
                        <div className="space-y-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                              Overall Dimensions &amp; Physical Properties (Measured from 3D CAD Model)
                            </h3>
                            <span className="text-[11px] font-mono text-slate-400">
                              Correlated 1:1 with the 3D model and 2D orthographic projections
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
                            <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-slate-400">Overall Envelope (ΔX × ΔY × ΔZ)</span>
                                <span className="px-1.5 py-0.5 text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                                  3D MEASURED
                                </span>
                              </div>
                              <div className="text-sm font-bold text-slate-100 mt-1">
                                {report.boundingDimensionsMm.lengthX.toFixed(2)} × {report.boundingDimensionsMm.widthY.toFixed(2)} × {report.boundingDimensionsMm.heightZ.toFixed(2)} mm
                              </div>
                              <div className="text-[11px] text-slate-400 mt-1">
                                3D Diagonal: {report.boundingDimensionsMm.diagonal3D.toFixed(2)} mm
                              </div>
                            </div>

                            <div className="p-3.5 rounded-lg bg-slate-950 border border-emerald-800/70">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-slate-400">3D Solid Volume</span>
                                <span className="px-1.5 py-0.5 text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                                  3D MEASURED
                                </span>
                              </div>
                              <div className="text-sm font-bold text-emerald-400 mt-1">
                                {report.materialVolumeEstimates.netSolidVolumeCm3.toFixed(3)} cm³
                              </div>
                              <div className="text-[11px] text-slate-400 mt-1">
                                {report.materialVolumeEstimates.netSolidVolumeMm3.toLocaleString()} mm³ ({(report.materialVolumeEstimates.netSolidVolumeCm3 * 1e-6).toFixed(6)} m³)
                              </div>
                            </div>

                            <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-slate-400">3D Surface Area &amp; Solid Ratio</span>
                                <span className="px-1.5 py-0.5 text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                                  3D MEASURED
                                </span>
                              </div>
                              <div className="text-sm font-bold text-slate-100 mt-1">
                                {report.materialVolumeEstimates.totalSurfaceAreaCm2.toFixed(2)} cm²
                              </div>
                              <div className="text-[11px] text-slate-400 mt-1">
                                Bounding Box: {report.materialVolumeEstimates.boundingEnvelopeVolumeCm3.toFixed(2)} cm³ ({report.materialVolumeEstimates.volumetricFillRatioPct}% solid fill)
                              </div>
                            </div>

                            <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-slate-400">Primary Datum / Feature Pitch</span>
                                <span className="px-1.5 py-0.5 text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                                  3D MEASURED
                                </span>
                              </div>
                              <div className="text-sm font-bold text-slate-100 mt-1 truncate">
                                {spacingDims.length > 0
                                  ? `${spacingDims[0].formattedValue} ${spacingDims[0].unit}`
                                  : `${planarFeatures.length > 0 ? `${planarFeatures[0].areaMm2.toFixed(0)} mm² Datum Face` : 'Single 3D Solid Body'}`}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-1 truncate">
                                {spacingDims.length > 0
                                  ? spacingDims[0].parameter
                                  : 'Largest flat mounting/reference face on 3D model'}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* 2. Concise 3D Feature & Specification Summary */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                          {/* Card 1: Internal Bores & Holes */}
                          <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2 flex flex-col justify-between">
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-bold text-slate-100">
                                  Internal Bores &amp; Holes (3D)
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-950/90 text-sky-300 border border-sky-800">
                                  {holeFeatures.length} Measured in 3D
                                </span>
                              </div>
                              {holeFeatures.length > 0 ? (
                                <div className="space-y-1 font-mono text-[11px] text-slate-200 pt-1">
                                  {holeFeatures.slice(0, 4).map((h) => (
                                    <div
                                      key={h.id}
                                      className="flex items-center justify-between bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800/80"
                                    >
                                      <span className="text-amber-300 font-semibold">{h.id}</span>
                                      <span>
                                        Ø{(h.diameterMm || 0).toFixed(2)} mm × {(h.depthOrLengthMm || 0).toFixed(2)} mm
                                      </span>
                                    </div>
                                  ))}
                                  {holeFeatures.length > 4 && (
                                    <div className="text-[10px] text-slate-400">
                                      + {holeFeatures.length - 4} additional bore(s) on 3D model
                                    </div>
                                  )}
                                  {largeCavityBores.length > 0 && (
                                    <div className="text-[10px] text-emerald-300 pt-0.5">
                                      Includes {largeCavityBores.length} primary internal bore/cavity (Ø ≥ 18 mm)
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-slate-400 text-[11px]">
                                  No internal cylindrical holes detected in the 3D mesh.
                                </p>
                              )}
                            </div>
                            <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 font-mono">
                              <span className="text-amber-300 font-semibold">Predicted / Assumed: </span>
                              Diameter &amp; axial span are measured from the 3D mesh; internal threads or H7 reaming tolerances are not in the 3D geometry and are predicted when estimating finishing operations.
                            </div>
                          </div>

                          {/* Card 2: External Cylindrical Sections, Bosses & Planar Datums */}
                          <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2 flex flex-col justify-between">
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-bold text-slate-100">
                                  Outer Diameters, Bosses &amp; Faces
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-950/90 text-sky-300 border border-sky-800">
                                  {bossFeatures.length} Cylindrical · {planarFeatures.length} Planar
                                </span>
                              </div>
                              <div className="space-y-1 font-mono text-[11px] text-slate-200 pt-1">
                                {bossFeatures.slice(0, 2).map((b) => (
                                  <div
                                    key={b.id}
                                    className="flex items-center justify-between bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800/80"
                                  >
                                    <span className="text-emerald-300 font-semibold">{b.id}</span>
                                    <span>
                                      Outer Ø{(b.diameterMm || 0).toFixed(2)} mm × {(b.depthOrLengthMm || 0).toFixed(2)} mm
                                    </span>
                                  </div>
                                ))}
                                {planarFeatures.slice(0, 2).map((p) => (
                                  <div
                                    key={p.id}
                                    className="flex items-center justify-between bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800/80"
                                  >
                                    <span className="text-sky-300 font-semibold">{p.id}</span>
                                    <span>
                                      Planar Datum ({p.areaMm2.toFixed(0)} mm²)
                                    </span>
                                  </div>
                                ))}
                                {chamferFeatures.length + filletFeatures.length > 0 && (
                                  <div className="text-[10px] text-slate-400 pt-0.5">
                                    + {chamferFeatures.length} chamfer(s) and {filletFeatures.length} fillet(s) detected on 3D edges
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 font-mono">
                              <span className="text-amber-300 font-semibold">Predicted / Assumed: </span>
                              Outer diameters and planar areas are measured from the 3D model; datum priority (A/B/C) and bearing/mating surface finish (Ra) are engineering predictions.
                            </div>
                          </div>

                          {/* Card 3: Specifications Predicted / Assumed (Not in 3D CAD Geometry) */}
                          <div className="p-4 rounded-lg bg-slate-950 border border-amber-800/60 space-y-2 flex flex-col justify-between">
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-bold text-slate-100">
                                  Specifications Not in 3D CAD
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/80 text-amber-300 border border-amber-800">
                                  Predicted / Assumed
                                </span>
                              </div>
                              <div className="space-y-1 font-mono text-[11px] text-slate-300 pt-1">
                                {report.missingManufacturingSpecifications.map((spec) => (
                                  <div
                                    key={spec.attribute}
                                    className="flex items-center justify-between bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800/80"
                                  >
                                    <span className="truncate pr-2">{spec.attribute}</span>
                                    <span
                                      className={`text-[10px] font-bold shrink-0 ${
                                        spec.status === 'SPECIFIED IN CAD'
                                          ? 'text-emerald-300'
                                          : 'text-amber-300'
                                      }`}
                                    >
                                      {spec.status === 'SPECIFIED IN CAD'
                                        ? 'In CAD Metadata'
                                        : 'Predicted / Assumed'}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="pt-2 border-t border-slate-800/80 text-[11px] text-slate-400 font-mono">
                              <span className="text-amber-300 font-semibold">Engineering Transparency: </span>
                              Whenever material grade, tolerances, or surface finishes are not stored inside the 3D CAD file, we predict a standard industrial baseline and let you edit it in Stage 6.
                            </div>
                          </div>
                        </div>

                        {/* 3. 3D Spatial Relationships Between Features (Coaxiality, Bore Pitch, Datum Perpendicularity & Wall Thickness) */}
                        {report.spatialRelationships && report.spatialRelationships.length > 0 && (
                          <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2 text-xs">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-mono font-bold uppercase tracking-wider text-sky-400">
                                3D Spatial Relationships Between Features (Measured from 3D Geometry)
                              </span>
                              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
                                3D Spatial Topology
                              </span>
                            </div>
                            <ul className="space-y-1.5 text-slate-300 font-mono text-[11px]">
                              {report.spatialRelationships.map((rel, rIdx) => (
                                <li key={rIdx} className="leading-relaxed">
                                  • {rel}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </section>
                    );
                  })()}
                </div>
              );
            })()}

            {/* STAGE 2: PART DESCRIPTION */}
            {revealedStageCount >= 2 && (
              <section id="stage-2" className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
                <div className="border-b border-slate-800 pb-3">
                  <h2 className="text-lg font-bold text-slate-100 font-display">
                    2. Part Description
                  </h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs font-mono text-slate-400">Part Identification</div>
                      <div className="text-base font-semibold text-slate-100 mt-0.5">
                        {currentVersion.description.partIdentification}
                      </div>
                      <p className="text-slate-300 mt-1 leading-relaxed">
                        {currentVersion.description.functionalSummary}
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-slate-400">Material &amp; Engineering Specification</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold ${
                            currentVersion.description.materialSpecification.source === 'CAD Header Metadata'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-amber-950 text-amber-300 border border-amber-800'
                          }`}
                        >
                          {currentVersion.description.materialSpecification.source === 'CAD Header Metadata'
                            ? 'Extracted from CAD Metadata'
                            : 'Predicted / Assumed (Not in 3D CAD)'}
                        </span>
                      </div>
                      <div className="font-mono text-slate-100 font-medium mt-0.5">
                        {currentVersion.description.materialSpecification.value}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <div className="text-xs font-mono text-slate-400">Major Geometric Features</div>
                      <ul className="mt-1 space-y-1 text-slate-300">
                        {currentVersion.description.majorGeometricFeatures.map((feat, i) => (
                          <li key={i}>· {feat}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <div className="text-xs font-mono text-slate-400">Manufacturing Processes</div>
                      <ul className="mt-1 space-y-1 text-slate-300">
                        {currentVersion.description.manufacturingProcesses.map((proc, i) => (
                          <li key={i}>
                            <span className="font-semibold text-slate-100">{proc.processName}:</span>{' '}
                            {proc.geometricJustification}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* CONSOLIDATED BILL OF MATERIALS (BOM) */}
            {revealedStageCount >= 3 && (
              <section id="stage-4" className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-100 font-display">
                      Consolidated Bill of Materials (BOM)
                    </h2>
                    <p className="text-xs font-mono text-slate-400 mt-0.5">
                      Dissected directly from the 3D CAD geometry · Authoritative Total Solid Volume: {(currentVersion.costEstimate.authoritativeVolumeCm3 ?? currentVersion.geometryAnalysisReport.materialVolumeEstimates.netSolidVolumeCm3).toFixed(3)} cm³ ({((currentVersion.costEstimate.authoritativeVolumeCm3 ?? currentVersion.geometryAnalysisReport.materialVolumeEstimates.netSolidVolumeCm3) * 1e-6).toFixed(6)} m³)
                    </p>
                  </div>
                  <span className="text-xs font-mono text-amber-300 bg-slate-950 px-3 py-1 rounded-lg border border-slate-800">
                    {currentVersion.bom.assemblySummaryNote}
                  </span>
                </div>

                {/* TABLE 1: Consolidated Bill of Materials Summary (Part Name | Material | Remarks) */}
                <div className="space-y-2">
                  <div className="text-xs font-mono font-bold uppercase tracking-wider text-amber-400">
                    Bill of Materials — Part Summary
                  </div>
                  <div className="overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-950 border-b border-slate-800 font-mono text-slate-400">
                          <th className="py-2.5 px-4 w-1/4">Part Name</th>
                          <th className="py-2.5 px-4 w-1/4">Material</th>
                          <th className="py-2.5 px-4">Remarks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {currentVersion.bom.entries.map((entry) => (
                          <tr key={`summary-${entry.itemNumber}`} className="hover:bg-slate-800/40 align-top">
                            <td className="py-3 px-4 font-semibold text-slate-100">
                              <div>{entry.componentName}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                                    entry.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                      ? 'bg-sky-950/80 border-sky-700/70 text-sky-300'
                                      : 'bg-amber-950/70 border-amber-700/60 text-amber-300'
                                  }`}
                                >
                                  {entry.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                    ? 'PURCHASED CATALOG ITEM'
                                    : 'CUSTOM MANUFACTURED'}
                                </span>
                                {entry.quantity > 1 && (
                                  <span className="inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200">
                                    Qty: {entry.quantity} pcs
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 font-mono text-amber-300">
                              {entry.material}
                            </td>
                            <td className="py-3 px-4 text-slate-300 leading-relaxed">
                              {entry.remarks}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* TABLE 2: Component Engineering, Volumetric Conversion (m³) & Chip Removal Breakdown */}
                <div className="space-y-2">
                  <div className="text-xs font-mono font-bold uppercase tracking-wider text-sky-400">
                    Component Engineering &amp; Volumetric Conversion Breakdown
                  </div>
                  <div className="overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-950 border-b border-slate-800 font-mono text-slate-400">
                          <th className="py-2.5 px-3">Component</th>
                          <th className="py-2.5 px-3">Structural Role</th>
                          <th className="py-2.5 px-3 text-right">Quantity</th>
                          <th className="py-2.5 px-3">Material</th>
                          <th className="py-2.5 px-3 text-right">Density</th>
                          <th className="py-2.5 px-3">Primary Manufacturing Process</th>
                          <th className="py-2.5 px-3">Secondary Finishing Operations</th>
                          <th className="py-2.5 px-3">Unit Envelope</th>
                          <th className="py-2.5 px-3 min-w-[260px]">
                            Raw Material → Net Volume Conversion (m³ &amp; cm³)
                          </th>
                          <th className="py-2.5 px-3 min-w-[270px]">
                            Chip Removal &amp; Process / Raw Material Basis Explanation
                          </th>
                          <th className="py-2.5 px-3 text-right">Area</th>
                          <th className="py-2.5 px-3 text-right">Estimated Mass</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {currentVersion.bom.entries.map((entry) => (
                          <tr key={entry.itemNumber} className="hover:bg-slate-800/40 align-top">
                            <td className="py-3 px-3 font-semibold text-slate-100 min-w-[140px]">
                              <div>{entry.componentName}</div>
                              <div className="mt-1">
                                <span
                                  className={`inline-block text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                                    entry.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                      ? 'bg-sky-950/80 border-sky-700/70 text-sky-300'
                                      : 'bg-amber-950/70 border-amber-700/60 text-amber-300'
                                  }`}
                                >
                                  {entry.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                    ? 'PURCHASED CATALOG'
                                    : 'CUSTOM MACHINED'}
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-3 text-slate-300 min-w-[140px]">
                              {entry.structuralRole}
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-semibold text-slate-100 tabular-nums">
                              {entry.quantity}
                            </td>
                            <td className="py-3 px-3 font-mono text-slate-200 min-w-[150px]">
                              {entry.material}
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-slate-300 whitespace-nowrap tabular-nums">
                              <div>{entry.densityGPerCm3.toFixed(2)} g/cm³</div>
                              <div className="text-[10px] text-slate-400">
                                ({(entry.densityGPerCm3 * 1000).toFixed(0)} kg/m³)
                              </div>
                            </td>
                            <td className="py-3 px-3 text-amber-300 font-medium min-w-[160px]">
                              {entry.manufacturingProcess}
                            </td>
                            <td className="py-3 px-3 text-slate-300 min-w-[170px]">
                              {entry.secondaryOperations}
                            </td>
                            <td className="py-3 px-3 font-mono text-slate-200 whitespace-nowrap tabular-nums">
                              <div>{entry.boundingBoxMm}</div>
                              {entry.quantity > 1 && (
                                <div className="text-[10px] text-slate-400">
                                  (Per unit · {entry.quantity}× instances)
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-3 text-slate-200 leading-relaxed">
                              <div className="font-mono font-semibold text-emerald-300 whitespace-nowrap tabular-nums">
                                {entry.rawVolumeM3.toFixed(6)} m³ → {entry.netVolumeM3.toFixed(6)} m³ ({entry.volumeCm3.toFixed(3)} cm³)
                              </div>
                              {entry.quantity > 1 && entry.unitVolumeCm3 !== undefined && (
                                <div className="text-[10px] font-mono text-sky-300 mt-0.5">
                                  Unit Vol: {entry.unitVolumeCm3.toFixed(3)} cm³ × {entry.quantity} pcs = {entry.volumeCm3.toFixed(3)} cm³
                                </div>
                              )}
                              <div className="text-[11px] text-slate-400 mt-1">
                                {entry.volumeConversionExplanation}
                              </div>
                            </td>
                            <td className="py-3 px-3 text-slate-200 leading-relaxed">
                              <div className="font-mono font-bold text-amber-300 tabular-nums">
                                {entry.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                  ? '0.0% Chip Removal (Purchased OEM/ISO Item)'
                                  : `${entry.chipRemovalRatioPct.toFixed(1)}% Chip Removal`}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-1">
                                {entry.chipRemovalExplanation}
                              </div>
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-slate-300 whitespace-nowrap tabular-nums">
                              <div>{entry.surfaceAreaCm2.toFixed(1)} cm²</div>
                              <div className="text-[10px] text-slate-400">
                                ({(entry.surfaceAreaCm2 * 1e-4).toFixed(5)} m²)
                              </div>
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-semibold text-slate-100 whitespace-nowrap tabular-nums">
                              <div>{(entry.estimatedMassGrams / 1000).toFixed(3)} kg</div>
                              <div className="text-[10px] text-slate-400">
                                ({entry.estimatedMassGrams.toFixed(1)} g{entry.quantity > 1 && entry.unitEstimatedMassGrams ? ` · ${entry.unitEstimatedMassGrams.toFixed(1)} g/pc` : ''})
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}

            {/* INTERACTIVE 3D MODIFICATION */}
            {revealedStageCount >= 4 && (() => {
              const partRecommendations = generatePartAlignedModificationSuggestions(
                currentVersion.features,
                currentVersion.dimensions,
                selectedFeatureId
              );
              const activeRec =
                partRecommendations.find((r) => r.id === selectedRecommendationId) ||
                partRecommendations.find((r) => r.targetFeatureId === selectedFeatureId) ||
                null;
              const appliedHistory = currentVersion.modificationHistory.filter(
                (m) => m.status === 'applied'
              );
              const lastModRecord =
                appliedHistory.length > 0
                  ? appliedHistory[appliedHistory.length - 1]
                  : null;
              const lastModFeatureId = lastModRecord?.targetFeatureId
                ? lastModRecord.targetFeatureId.split('→').pop()!.split(',')[0].trim()
                : null;

              return (
                <section id="stage-5" className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                    <div>
                      <h2 className="text-lg font-bold text-slate-100 font-display">
                        Interactive 3D Modification &amp; Pre-Commit Geometry Validation
                      </h2>
                      <p className="text-xs font-mono text-slate-400 mt-0.5">
                        Click any recommendation card to preview it on the 3D part, then click &ldquo;Apply on 3D Model&rdquo; — Pre-commit mesh verification automatically rejects no-op or zero-delta changes without creating duplicate revisions
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {versions.length > 1 && (
                        <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1 mr-2">
                          {versions.map((ver, idx) => (
                            <button
                              key={ver.versionNumber}
                              type="button"
                              onClick={() => setActiveVersionIndex(idx)}
                              className={`px-2.5 py-1 text-xs font-mono rounded transition-colors cursor-pointer ${
                                idx === activeVersionIndex
                                  ? 'bg-amber-500 text-slate-950 font-bold'
                                  : 'text-slate-300 hover:bg-slate-800'
                              }`}
                            >
                              v{ver.versionNumber}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDownloadModel('stl_binary')}
                        className="px-3 py-1.5 text-xs font-mono font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg flex items-center gap-1.5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download .STL (v{currentVersion.versionNumber})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownloadModel('obj')}
                        className="px-3 py-1.5 text-xs font-mono text-slate-200 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg flex items-center gap-1.5 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download .OBJ</span>
                      </button>
                    </div>
                  </div>

                  {/* Pre-Commit No-Op / Validation Rejection Banner */}
                  {lastRejectedMod && (
                    <div className="p-3.5 rounded-lg bg-amber-950/50 border border-amber-600/80 flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div className="text-xs">
                          <div className="font-mono font-bold text-amber-300 uppercase">
                            PRE-COMMIT GEOMETRY VALIDATION — {lastRejectedMod.status.replace(/_/g, ' ')}: {lastRejectedMod.operationName}
                          </div>
                          <div className="text-slate-200 mt-0.5">{lastRejectedMod.summary}</div>
                          <div className="text-[11px] font-mono text-slate-400 mt-1">
                            {lastRejectedMod.technicalDetails}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLastRejectedMod(null)}
                        className="px-2 py-0.5 text-[11px] font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded cursor-pointer shrink-0"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {/* Active Modification Visual Confirmation Banner */}
                  {lastModRecord && (
                    <div className="p-3.5 rounded-lg bg-emerald-950/40 border border-emerald-700/70 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <div className="text-xs">
                          <div className="font-mono font-bold text-emerald-300">
                            VERIFIED 3D GEOMETRY REVISION v{currentVersion.versionNumber}:{' '}
                            {lastModRecord.operationName}
                          </div>
                          <div className="text-slate-200 mt-0.5">{lastModRecord.summary}</div>
                          <div className="text-[11px] font-mono text-emerald-300/90 mt-1">
                            Envelope: {currentVersion.geometryAnalysisReport.boundingDimensionsMm.lengthX.toFixed(2)} ×{' '}
                            {currentVersion.geometryAnalysisReport.boundingDimensionsMm.widthY.toFixed(2)} ×{' '}
                            {currentVersion.geometryAnalysisReport.boundingDimensionsMm.heightZ.toFixed(2)} mm · Net Solid Volume:{' '}
                            {(currentVersion.costEstimate.authoritativeVolumeCm3 ?? currentVersion.geometryAnalysisReport.materialVolumeEstimates.netSolidVolumeCm3).toFixed(3)} cm³
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveVersionIndex(0)}
                          className="px-2.5 py-1 text-xs font-mono bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-700 rounded cursor-pointer"
                        >
                          Switch to v1 (Original)
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    {/* Left: Connected 3D CAD Viewer with Live 3D Recommendation Preview */}
                    <div className="lg:col-span-7">
                      <CadInteractiveViewer
                        key={`${uploadSessionId}-v${currentVersion.versionNumber}`}
                        components={currentVersion.components}
                        features={currentVersion.features}
                        annotations={currentVersion.annotations}
                        selectedFeatureId={activeRec?.targetFeatureId || selectedFeatureId}
                        onSelectFeature={(fid) => {
                          setSelectedFeatureId(fid);
                          const matchingRec = partRecommendations.find(
                            (r) => r.targetFeatureId === fid
                          );
                          setSelectedRecommendationId(matchingRec ? matchingRec.id : null);
                        }}
                        isolatedComponentIndex={isolatedComponentIndex}
                        baselineComponents={versions[0]?.components}
                        versionNumber={currentVersion.versionNumber}
                        lastModifiedFeatureId={lastModFeatureId}
                        activePreviewOverlay={activeRec?.previewGeometry || null}
                        onApplyActivePreview={
                          activeRec && !isModifying
                            ? () =>
                                handleExecuteModification(
                                  activeRec.prompt,
                                  activeRec.targetFeatureId
                                )
                            : undefined
                        }
                      />
                    </div>

                    {/* Right: Part-Specific Engineering Recommendations, Custom Instruction & History */}
                    <div className="lg:col-span-5 space-y-4">
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono font-semibold uppercase tracking-wider text-amber-400">
                            Part-Specific Engineering Recommendations
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            Click to preview on 3D part
                          </span>
                        </div>

                        <div className="space-y-2.5 max-h-[430px] overflow-y-auto pr-1">
                          {partRecommendations.map((rec) => {
                            const isPreviewed =
                              activeRec?.id === rec.id ||
                              (selectedFeatureId !== null &&
                                rec.targetFeatureId === selectedFeatureId &&
                                !selectedRecommendationId);

                            return (
                              <div
                                key={rec.id}
                                onClick={() => {
                                  setSelectedRecommendationId(rec.id);
                                  setSelectedFeatureId(rec.targetFeatureId);
                                }}
                                className={`p-3.5 rounded-xl border transition-all cursor-pointer space-y-2 ${
                                  isPreviewed
                                    ? 'bg-amber-950/25 border-amber-500/80 shadow-sm'
                                    : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="text-xs font-bold text-slate-100 leading-snug">
                                    {rec.title}
                                  </div>
                                  <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded shrink-0">
                                    {rec.badge}
                                  </span>
                                </div>

                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono">
                                  <span className="text-sky-300">{rec.locationOnPart}</span>
                                  <span className="text-slate-500">·</span>
                                  <span className="text-slate-400">{rec.category}</span>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] font-mono bg-slate-900/90 border border-slate-800/80 rounded-lg p-2">
                                  <div>
                                    <span className="text-slate-400 block text-[10px] uppercase">
                                      Current Part Geometry
                                    </span>
                                    <span className="text-slate-200">{rec.currentGeometrySpec}</span>
                                  </div>
                                  <div>
                                    <span className="text-amber-300/90 block text-[10px] uppercase">
                                      Proposed 3D Change
                                    </span>
                                    <span className="text-emerald-300 font-semibold">
                                      {rec.proposedModificationSpec}
                                    </span>
                                  </div>
                                </div>

                                <div className="text-xs text-slate-300 leading-relaxed">
                                  {rec.engineeringRationale}
                                </div>

                                <div className="pt-1 flex items-center justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedRecommendationId(rec.id);
                                      setSelectedFeatureId(rec.targetFeatureId);
                                    }}
                                    className={`px-2.5 py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer ${
                                      isPreviewed
                                        ? 'bg-amber-500/20 text-amber-200 border-amber-500/50 font-semibold'
                                        : 'bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700'
                                    }`}
                                  >
                                    {isPreviewed ? 'Showing on 3D Part' : 'Preview on 3D Part'}
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isModifying}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedFeatureId(rec.targetFeatureId);
                                      handleExecuteModification(rec.prompt, rec.targetFeatureId);
                                    }}
                                    className="px-3 py-1 text-[11px] font-mono font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded cursor-pointer disabled:opacity-50"
                                  >
                                    Apply on 3D Model
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleExecuteModification();
                        }}
                        className="flex gap-2"
                      >
                        <input
                          type="text"
                          value={instructionInput}
                          onChange={(e) => setInstructionInput(e.target.value)}
                          placeholder='Or enter custom instruction, e.g. "Add a Ø10 mm hole at the middle of FACE-P01"'
                          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
                        />
                        <button
                          type="submit"
                          disabled={isModifying || !instructionInput.trim()}
                          className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                        >
                          {isModifying ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          <span>Apply</span>
                        </button>
                      </form>

                      {currentVersion.modificationHistory.length > 0 && (
                        <div className="space-y-2 max-h-56 overflow-y-auto">
                          {[...currentVersion.modificationHistory].reverse().map((rec) => (
                            <div
                              key={rec.id}
                              className={`p-3 rounded-lg border text-xs ${
                                rec.status === 'applied'
                                  ? 'bg-slate-950 border-slate-800 text-slate-200'
                                  : rec.status === 'no_op_rejected'
                                  ? 'bg-amber-950/35 border-amber-800/80 text-amber-200'
                                  : 'bg-rose-950/40 border-rose-800 text-rose-200'
                              }`}
                            >
                              <div className="font-semibold flex items-center justify-between gap-1.5">
                                <span className="flex items-center gap-1.5">
                                  {rec.status === 'applied' ? (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                  ) : (
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                  )}
                                  <span>{rec.operationName}</span>
                                </span>
                                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700">
                                  {rec.status.replace(/_/g, ' ')}
                                </span>
                              </div>
                              <div className="text-slate-300 mt-1">{rec.summary}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              );
            })()}

            {/* STAGE 6: MANUFACTURING COST ESTIMATION — PER PIECE (SWEDEN — SEK & EUR) + VALIDATION MATRIX + INTERACTIVE PARAMETER EDITOR */}
            {revealedStageCount >= 5 && (() => {
              const ce = currentVersion.costEstimate;
              const sekPerEur = ce.exchangeRateSekPerEur || 11.45;
              const v1Cost = versions[0]?.costEstimate?.costBreakdownPerUnit;
              const currentCost = ce.costBreakdownPerUnit;
              const achievedSavingSek =
                v1Cost && currentVersion.versionNumber > 1
                  ? Math.max(0, +(v1Cost.totalUnitCostSek - currentCost.totalUnitCostSek).toFixed(2))
                  : 0;
              const achievedSavingEur =
                v1Cost && currentVersion.versionNumber > 1
                  ? Math.max(0, +(v1Cost.totalUnitCostEur - currentCost.totalUnitCostEur).toFixed(2))
                  : 0;

              const appliedMods = currentVersion.modificationHistory.filter(
                (m) => m.status === 'applied'
              );
              const lastModRecord =
                appliedMods.length > 0 ? appliedMods[appliedMods.length - 1] : null;

              const vr = ce.validationReport;
              const ctb = ce.cycleTimeBreakdown;
              const selectedRouteKey = ce.selectedProcessRouteKey || 'BILLET_CNC';
              const selectedBatchSize = ce.batchSize || 10;
              const selectedRouteLabel =
                selectedRouteKey === 'BILLET_CNC'
                  ? 'Route A: Bar / Billet CNC Machining'
                  : selectedRouteKey === 'PRECISION_BLANK_CNC'
                  ? 'Route B: Precision Waterjet/Saw Blank + CNC'
                  : 'Route C: Near-Net Casting / Forging Preform + Finish CNC';
              const authVolumeCm3 =
                ce.authoritativeVolumeCm3 ??
                currentVersion.geometryAnalysisReport.materialVolumeEstimates.netSolidVolumeCm3;
              const materialOptions: Array<{
                gradeKey: 'AL_6082' | 'STEEL_42CRMO4' | 'SS_316L' | 'TI_6AL4V' | 'BRASS_CW614N';
                materialName: string;
                densityGPerCm3: number;
              }> = [
                { gradeKey: 'AL_6082', materialName: 'EN AW-6082-T6 Aluminum', densityGPerCm3: 2.7 },
                { gradeKey: 'STEEL_42CRMO4', materialName: 'EN 1.7225 (42CrMo4) Alloy Steel', densityGPerCm3: 7.85 },
                { gradeKey: 'SS_316L', materialName: 'EN 1.4404 (AISI 316L) Stainless Steel', densityGPerCm3: 8.0 },
                { gradeKey: 'TI_6AL4V', materialName: 'Ti-6Al-4V (Grade 5) Titanium', densityGPerCm3: 4.43 },
                { gradeKey: 'BRASS_CW614N', materialName: 'CW614N (CuZn39Pb3) Brass', densityGPerCm3: 8.47 },
              ];

              return (
                <section id="stage-6" className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
                  {/* Header with Authoritative Cost Result & Validation Badge */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-bold text-slate-100 font-display">
                          Manufacturing Cost Estimation — Per Piece (Sweden · SEK &amp; EUR)
                        </h2>
                        <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded">
                          BATCH: {selectedBatchSize} PCS · {selectedRouteLabel}
                        </span>
                        {vr && (
                          <span
                            className={`px-2 py-0.5 text-[11px] font-mono font-bold rounded border ${
                              vr.overallStatus === 'ENGINEERING_REVIEW_REQUIRED' ||
                              vr.overallStatus === 'DISCREPANCY_DETECTED'
                                ? 'bg-rose-950 text-rose-300 border-rose-700'
                                : 'bg-sky-950 text-sky-300 border-sky-700'
                            }`}
                          >
                            {vr.overallStatus === 'ENGINEERING_REVIEW_REQUIRED' ||
                            vr.overallStatus === 'DISCREPANCY_DETECTED'
                              ? 'Engineering Review Required'
                              : 'Arithmetic Reconciled · Preliminary Assumptions Disclosed'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-mono text-slate-400 mt-1">
                        Scenario-Based Manufacturing Cost Estimate for Revision v{currentVersion.versionNumber} · Net Solid Volume: {authVolumeCm3.toFixed(3)} cm³ · Explicit traceable equations (1 EUR = {sekPerEur.toFixed(2)} SEK)
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="px-4 py-2 rounded-lg bg-slate-950 border border-amber-500/50 text-right font-mono">
                        <div className="text-[10px] text-amber-300 uppercase">
                          Scenario-Based Manufacturing Cost Estimate (v{currentVersion.versionNumber} · {selectedBatchSize} pcs)
                        </div>
                        <div className="text-lg font-bold text-slate-100">
                          {ce.costBreakdownPerUnit.totalUnitCostSek.toFixed(2)} SEK{' '}
                          <span className="text-sm font-normal text-amber-400">
                            (€{ce.costBreakdownPerUnit.totalUnitCostEur.toFixed(2)} EUR)
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleRefreshSwedenWebScrapedRates}
                        disabled={isScrapingCostRates}
                        className="px-3.5 py-2.5 text-xs font-mono font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-2 cursor-pointer disabled:opacity-50"
                      >
                        {isScrapingCostRates ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        <span>Verify Live FX &amp; Sweden Benchmarks</span>
                      </button>
                    </div>
                  </div>

                  {/* 1. MEASURED 3D GEOMETRY vs. RECONCILED ARITHMETIC vs. PRELIMINARY ASSUMPTIONS */}
                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                          3D Measured Geometry vs. Reconciled Arithmetic vs. Preliminary Engineering Assumptions
                        </span>
                      </div>
                      {vr && (
                        <span className="text-[11px] font-mono text-slate-400">
                          3D Solid Volume Sync: Stage 1B ({vr.authoritativeVolumeCm3} cm³) = Stage 4 BOM ({vr.bomTotalVolumeCm3} cm³)
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs leading-relaxed">
                      <div className="p-3 rounded-lg bg-slate-900/90 border border-emerald-800/60">
                        <div className="font-mono font-bold text-emerald-300 uppercase text-[11px] mb-1">
                          1. Measured 3D Geometry &amp; Reconciled Arithmetic
                        </div>
                        <p className="text-slate-300">
                          • <span className="font-semibold text-slate-100">3D Solid Volume &amp; Envelope:</span> Net part volume ({authVolumeCm3.toFixed(3)} cm³) and overall bounding dimensions are measured directly from the 3D CAD mesh.<br />
                          • <span className="font-semibold text-slate-100">Aligned BOM &amp; Costing Raw Stock:</span> Both BOM and Costing use the exact same raw stock blank ({ce.stockValidation?.stockDimensionsFormatted || currentVersion.bom.entries[0]?.rawStockDimensionsMm}), and mass conservation (<span className="font-mono">m_raw − m_net = m_swarf</span>) is mathematically reconciled.<br />
                          • <span className="font-semibold text-slate-100">Equation Reconciliation:</span> Every operation cost equation reconciles to the component cost, and the sum of BOM components equals the final part cost.
                        </p>
                      </div>

                      <div className="p-3 rounded-lg bg-slate-900/90 border border-amber-800/60">
                        <div className="font-mono font-bold text-amber-300 uppercase text-[11px] mb-1">
                          2. Preliminary Engineering Assumptions Requiring Review (Editable Below)
                        </div>
                        <p className="text-slate-300">
                          • Internal arithmetic reconciliation does not replace a production CAM toolpath or 2D drawing review. <span className="font-semibold text-slate-100">Material alloy</span> (when not in CAD metadata), <span className="font-semibold text-slate-100">parametric cycle times</span> (MRR &amp; surface area rates), <span className="font-semibold text-slate-100">batch size ({selectedBatchSize} pcs)</span>, and <span className="font-semibold text-slate-100">Sweden shop rates</span> are preliminary engineering assumptions.<br />
                          • Adjust any parameter in the editor below to immediately recalculate all BOM and costing equations.
                        </p>
                      </div>
                    </div>

                    {vr && (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs font-mono pt-1">
                        {vr.validationMatrix
                          .filter((chk) => chk.checkId !== 'CHK-KERNEL' && chk.checkId !== 'CHK-DFM')
                          .map((chk) => {
                            const isPass = chk.status !== 'DISCREPANCY_DETECTED';
                            const badgeText =
                              chk.status === 'ARITHMETIC_PASSED'
                                ? 'ARITHMETIC RECONCILED'
                                : chk.status === 'VERIFIED'
                                  ? '3D / METADATA SYNCED'
                                  : chk.status === 'ASSUMED_BASELINE' || chk.status === 'MESH_APPROXIMATION'
                                    ? 'PRELIMINARY ASSUMPTION'
                                    : chk.status === 'USER_OVERRIDDEN'
                                      ? 'USER OVERRIDDEN'
                                      : 'REVIEW REQUIRED';
                            return (
                              <div
                                key={chk.checkId}
                                className={`p-2.5 rounded-lg border flex flex-col gap-1 ${
                                  isPass
                                    ? 'bg-slate-900/80 border-slate-800'
                                    : 'bg-rose-950/40 border-rose-800'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-semibold text-slate-200">{chk.label}</span>
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                                      chk.status === 'ARITHMETIC_PASSED' || chk.status === 'VERIFIED'
                                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                        : chk.status === 'ASSUMED_BASELINE' || chk.status === 'MESH_APPROXIMATION'
                                        ? 'bg-sky-950 text-sky-300 border border-sky-800'
                                        : chk.status === 'USER_OVERRIDDEN'
                                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                                        : 'bg-rose-950 text-rose-300 border border-rose-800'
                                    }`}
                                  >
                                    {badgeText}
                                  </span>
                                </div>
                                <div className="text-[10px] text-slate-400">
                                  {chk.domain} · Source: {chk.expectedOrExtracted}
                                </div>
                                <div className="text-[11px] text-emerald-300/90 font-semibold">
                                  Applied: {chk.actualOrApplied}
                                </div>
                                <div className="text-[10px] text-slate-400 leading-snug">
                                  {chk.verificationNote}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>

                  {/* 2. INTERACTIVE COSTING ASSUMPTIONS & PROCESS ROUTE EDITOR */}
                  <div className="p-4 rounded-xl bg-slate-950 border border-amber-500/40 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                      <div>
                        <span className="text-xs font-mono font-bold uppercase tracking-wider text-amber-400">
                          Interactive Costing Assumptions &amp; Process Route Editor
                        </span>
                        <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                          Modify any assumed parameter below to immediately recalculate the authoritative unit cost, cycle time, and process route equations
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUpdateCostOverrides({}, true)}
                        className="px-2.5 py-1 text-[11px] font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 rounded cursor-pointer"
                      >
                        Reset Assumptions to Defaults
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs font-mono">
                      {/* Process Route Selector */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Manufacturing Route
                        </label>
                        <select
                          value={selectedRouteKey}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              processRouteKey: e.target.value as ManufacturingProcessRouteKey,
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        >
                          <option value="BILLET_CNC">Route A: Bar / Billet CNC Machining</option>
                          <option value="PRECISION_BLANK_CNC">Route B: Precision Blank + CNC</option>
                          <option value="NEAR_NET_FORGING_CNC">Route C: Near-Net Casting/Forging + Finish CNC</option>
                        </select>
                      </div>

                      {/* Material Alloy Selector */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Assumed Material Grade
                        </label>
                        <select
                          value={costOverrides.materialGradeKey || ce.materialKey || 'AL_6082'}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              materialGradeKey: e.target.value as
                                | 'AL_6082'
                                | 'STEEL_42CRMO4'
                                | 'SS_316L'
                                | 'TI_6AL4V'
                                | 'BRASS_CW614N',
                              rawMaterialPriceSekPerKg: undefined,
                              scrapCreditSekPerKg: undefined,
                              roughingMrrCm3PerMin: undefined,
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        >
                          {materialOptions.map((m) => (
                            <option key={m.gradeKey} value={m.gradeKey}>
                              {m.materialName} ({m.densityGPerCm3} g/cm³)
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Batch Size Selector */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Production Batch Size (N)
                        </label>
                        <select
                          value={selectedBatchSize}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              batchSize: Number(e.target.value),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        >
                          <option value={1}>1 pc (Prototype Single)</option>
                          <option value={10}>10 pcs (Small Batch Benchmark)</option>
                          <option value={50}>50 pcs (Pilot Run)</option>
                          <option value={100}>100 pcs (Medium Series)</option>
                          <option value={500}>500 pcs (Production Batch)</option>
                        </select>
                      </div>

                      {/* Bilateral Stock Allowance (mm) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Stock Allowance / Axis (mm)
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min="0.5"
                          max="15"
                          value={
                            costOverrides.stockAllowanceMm ??
                            ce.stockAllowanceMm ??
                            (selectedRouteKey === 'BILLET_CNC'
                              ? 4.0
                              : selectedRouteKey === 'PRECISION_BLANK_CNC'
                              ? 2.0
                              : 1.5)
                          }
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              stockAllowanceMm: Math.max(0.5, Number(e.target.value) || 2.0),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      {/* Heat Treatment Inclusion */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Stress Relief / Heat Treat
                        </label>
                        <select
                          value={
                            costOverrides.includeHeatTreatment === undefined
                              ? 'auto'
                              : costOverrides.includeHeatTreatment
                              ? 'yes'
                              : 'no'
                          }
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              includeHeatTreatment:
                                e.target.value === 'auto'
                                  ? undefined
                                  : e.target.value === 'yes',
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        >
                          <option value="auto">Auto (Only Forging / High-Stress)</option>
                          <option value="no">Exclude (Pre-Tempered T6/Annealed)</option>
                          <option value="yes">Include Furnace Cycle</option>
                        </select>
                      </div>

                      {/* Roughing MRR (cm³/min) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Roughing MRR (cm³/min)
                        </label>
                        <input
                          type="number"
                          step="1"
                          min="2"
                          max="150"
                          value={costOverrides.roughingMrrCm3PerMin ?? ctb?.roughingMrrCm3PerMin ?? 32}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              roughingMrrCm3PerMin: Math.max(2, Number(e.target.value) || 20),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      {/* Direct Operator Rate (SEK/h) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Operator Labor (SEK/h)
                        </label>
                        <input
                          type="number"
                          step="10"
                          min="250"
                          max="1500"
                          value={costOverrides.laborSekPerHour ?? ce.marketRates.cncOperatorHourlyRateSek}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              laborSekPerHour: Math.max(250, Number(e.target.value) || 645),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      {/* CNC Machine Center Rate (SEK/h) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Machine Center (SEK/h)
                        </label>
                        <input
                          type="number"
                          step="10"
                          min="200"
                          max="2000"
                          value={costOverrides.machineRateSekPerHour ?? ce.marketRates.machineDepreciationHourlySek}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              machineRateSekPerHour: Math.max(200, Number(e.target.value) || 580),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      {/* Industrial Electricity (SEK/kWh) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          SE3 Electricity (SEK/kWh)
                        </label>
                        <input
                          type="number"
                          step="0.05"
                          min="0.1"
                          max="5.0"
                          value={costOverrides.electricitySekPerKwh ?? ce.marketRates.electricityPriceSekPerKwh}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              electricitySekPerKwh: Math.max(0.1, Number(e.target.value) || 0.91),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>

                      {/* Raw Material Price (SEK/kg) */}
                      <div>
                        <label className="block text-[10px] uppercase text-slate-400 mb-1">
                          Raw Stock Price (SEK/kg)
                        </label>
                        <input
                          type="number"
                          step="1"
                          min="10"
                          max="2000"
                          value={costOverrides.rawMaterialPriceSekPerKg ?? ce.marketRates.rawMaterialPriceSekPerKg}
                          onChange={(e) =>
                            handleUpdateCostOverrides({
                              rawMaterialPriceSekPerKg: Math.max(10, Number(e.target.value) || 78),
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 3. MANUFACTURING PROCESS ROUTE COMPARISON TABLE */}
                  {ce.processRouteComparisons && ce.processRouteComparisons.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-mono font-bold uppercase tracking-wider text-sky-400">
                          Manufacturing Process Route Comparison (Click Any Route to Activate)
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          Avoids stacking forging, heat treatment &amp; full-billet roughing simultaneously — compares distinct technical routes
                        </span>
                      </div>
                      <div className="overflow-x-auto border border-slate-800 rounded-lg">
                        <table className="w-full text-left border-collapse text-xs font-mono">
                          <thead>
                            <tr className="bg-slate-950 text-slate-400 border-b border-slate-800">
                              <th className="py-2.5 px-3">Process Route</th>
                              <th className="py-2.5 px-3">Included Operations</th>
                              <th className="py-2.5 px-3 text-right">Raw Stock (g)</th>
                              <th className="py-2.5 px-3 text-right">Chip Removal</th>
                              <th className="py-2.5 px-3 text-right">Cycle Time</th>
                              <th className="py-2.5 px-3 text-right">Unit Cost (SEK)</th>
                              <th className="py-2.5 px-3 text-right">Unit Cost (EUR)</th>
                              <th className="py-2.5 px-3">Batch Suitability</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/70">
                            {ce.processRouteComparisons.map((rt) => {
                              const isSelectedRoute = rt.isSelectedRoute || rt.routeKey === selectedRouteKey;
                              return (
                                <tr
                                  key={rt.routeKey}
                                  onClick={() => handleUpdateCostOverrides({ processRouteKey: rt.routeKey })}
                                  className={`cursor-pointer transition-colors ${
                                    isSelectedRoute
                                      ? 'bg-amber-500/15 border-l-2 border-l-amber-400'
                                      : 'bg-slate-950/60 hover:bg-slate-900'
                                  }`}
                                >
                                  <td className="py-2.5 px-3 font-semibold text-slate-100">
                                    <div className="flex items-center gap-2">
                                      <span>{rt.routeName}</span>
                                      {isSelectedRoute && (
                                        <span className="px-1.5 py-0.5 text-[9px] bg-emerald-950 text-emerald-300 border border-emerald-700 rounded">
                                          ACTIVE (N={selectedBatchSize})
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-2.5 px-3 text-slate-300 text-[11px]">{rt.includedOperationsSummary}</td>
                                  <td className="py-2.5 px-3 text-right text-slate-200 tabular-nums">{(rt.rawMassKg * 1000).toFixed(1)} g</td>
                                  <td className="py-2.5 px-3 text-right text-amber-300 tabular-nums">{rt.chipRemovalPct.toFixed(1)}%</td>
                                  <td className="py-2.5 px-3 text-right text-sky-300 tabular-nums">{rt.cycleTimeMin.toFixed(2)} min</td>
                                  <td className="py-2.5 px-3 text-right font-bold text-slate-100 tabular-nums">{rt.unitTotalCostSek.toFixed(2)} SEK</td>
                                  <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">€{rt.unitTotalCostEur.toFixed(2)}</td>
                                  <td className="py-2.5 px-3 text-slate-400 text-[11px]">{rt.recommendedForBatchRange}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* 4. PRELIMINARY PARAMETRIC CYCLE-TIME BREAKDOWN */}
                  {ctb && (
                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5 text-xs font-mono">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold uppercase tracking-wider text-sky-400">
                          Preliminary Parametric Cycle-Time Estimate — CAM Toolpath Verification Required ({ctb.totalMachiningCycleTimeMin.toFixed(2)} min/pc + {ctb.setupTimeAmortizedPerPieceMin.toFixed(2)} min amortized setup)
                        </span>
                        <span className="text-slate-400 text-[11px]">
                          v_c = {ctb.cuttingSpeedVcMPerMin} m/min · RPM = {ctb.effectiveSpindleRpm} · f_z = {ctb.feedPerToothFzMm} mm/tooth · Tool Changes = {ctb.toolChangeCount}
                        </span>
                      </div>
                      <div className="p-2.5 rounded bg-slate-900 border border-slate-800 text-amber-300 text-[11px] overflow-x-auto">
                        {ctb.explicitCycleTimeEquation} (Preliminary MRR &amp; surface-area estimate — verify with CAM toolpath simulation)
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-[11px]">
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">1. Roughing Time</span>
                          <span className="text-slate-100 font-bold">{ctb.roughingTimeMin.toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">{ctb.removedChipVolumeCm3} cm³ @ {ctb.roughingMrrCm3PerMin} cm³/min</span>
                        </div>
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">2. Finishing Time</span>
                          <span className="text-slate-100 font-bold">{ctb.finishingTimeMin.toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">{ctb.finishedSurfaceAreaCm2} cm² @ {ctb.finishingAreaRateCm2PerMin} cm²/min</span>
                        </div>
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">3. Drilling &amp; Bores</span>
                          <span className="text-slate-100 font-bold">{ctb.drillingAndBoringTimeMin.toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">Depth {ctb.totalBoreDrillingDepthMm} mm @ {ctb.drillingPenetrationMmPerMin} mm/min</span>
                        </div>
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">4. Tool Changes</span>
                          <span className="text-slate-100 font-bold">{ctb.toolChangeAndRapidTimeMin.toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">{ctb.toolChangeCount} tools + rapid index</span>
                        </div>
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">5. Load / Clamping</span>
                          <span className="text-slate-100 font-bold">{ctb.workholdingLoadUnloadTimeMin.toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">Fixture clamping &amp; blow-off</span>
                        </div>
                        <div className="p-2 rounded bg-slate-900/70 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">6. Setup + QA / Pc</span>
                          <span className="text-slate-100 font-bold">{(ctb.setupTimeAmortizedPerPieceMin + ctb.deburrAndCmmInspectionTimeMin).toFixed(2)} min</span>
                          <span className="text-slate-500 block text-[10px]">Setup {ctb.setupTimeTotalMin}m/{selectedBatchSize} + QA {ctb.deburrAndCmmInspectionTimeMin}m</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Verified 3D Cost Impact Banner when 3D DFM Modifications are Applied */}
                  {currentVersion.versionNumber > 1 && v1Cost && (
                    <div className="p-4 rounded-xl bg-emerald-950/35 border border-emerald-600/60 flex flex-wrap items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-xs font-mono font-bold text-emerald-300 uppercase flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <span>
                            3D Model Cost Comparison: Original (v1) vs. Current 3D Geometry (v{currentVersion.versionNumber})
                          </span>
                        </div>
                        <div className="text-xs text-slate-200">
                          Latest applied 3D modification:{' '}
                          <span className="font-mono font-semibold text-amber-300">
                            {lastModRecord?.operationName}
                          </span>{' '}
                          — {lastModRecord?.summary}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
                        <div className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800">
                          <span className="text-slate-400 block text-[10px]">ORIGINAL v1 / PIECE</span>
                          <span className="text-slate-200 font-semibold">
                            {v1Cost.totalUnitCostSek.toFixed(2)} SEK (€{v1Cost.totalUnitCostEur.toFixed(2)})
                          </span>
                        </div>
                        <div className="px-3 py-1.5 rounded-lg bg-slate-950 border border-emerald-500/50">
                          <span className="text-emerald-300 block text-[10px]">
                            CURRENT v{currentVersion.versionNumber} / PIECE
                          </span>
                          <span className="text-slate-100 font-bold">
                            {currentCost.totalUnitCostSek.toFixed(2)} SEK (€{currentCost.totalUnitCostEur.toFixed(2)})
                          </span>
                        </div>
                        {achievedSavingSek > 0 && (
                          <div className="px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/50 text-emerald-200 font-bold">
                            <span className="block text-[10px] uppercase">Realized 3D Saving</span>
                            <span>
                              -{achievedSavingSek.toFixed(2)} SEK (-€{achievedSavingEur.toFixed(2)} / piece)
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 5. PER-COMPONENT MANUFACTURING STEPS & EXPLICIT TRACEABLE EQUATIONS */}
                  <div className="space-y-6">
                    {ce.componentCostBreakdowns.map((comp) => (
                      <div
                        key={comp.itemNumber}
                        className="bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-mono text-amber-400 uppercase">
                                BOM Component #{comp.itemNumber} (Qty: {comp.quantity} · Assembly Contribution)
                              </span>
                              <span
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                                  comp.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                    ? 'bg-sky-950/80 border-sky-700/70 text-sky-300'
                                    : 'bg-amber-950/70 border-amber-700/60 text-amber-300'
                                }`}
                              >
                                {comp.componentSourceType === 'PURCHASED_STANDARD_CATALOG'
                                  ? 'PURCHASED CATALOG ALLOWANCE (ASSUMED — REQUIRES VENDOR QUOTE)'
                                  : 'CUSTOM MANUFACTURED COMPONENT'}
                              </span>
                            </div>
                            <h3 className="text-base font-bold text-slate-100 mt-0.5">
                              {comp.componentName}
                            </h3>
                            <div className="text-xs font-mono text-slate-400 mt-0.5">
                              Material: <span className="text-slate-200">{comp.material}</span> ·{' '}
                              {comp.componentSourceType === 'PURCHASED_STANDARD_CATALOG' ? (
                                <>
                                  Catalog Mass (Qty {comp.quantity}):{' '}
                                  <span className="text-emerald-300">{comp.netMassKg.toFixed(4)} kg</span> (No Billet Machining Swarf)
                                </>
                              ) : (
                                <>
                                  Raw Input (Qty {comp.quantity}):{' '}
                                  <span className="text-slate-200">{comp.rawMassKg.toFixed(4)} kg</span> → Net Mass:{' '}
                                  <span className="text-emerald-300">{comp.netMassKg.toFixed(4)} kg</span> (Scrap/Swarf:{' '}
                                  <span className="text-amber-300">{Math.max(0, comp.rawMassKg - comp.netMassKg).toFixed(4)} kg</span>)
                                </>
                              )}
                            </div>
                          </div>
                          <div className="text-right font-mono">
                            <div className="text-[11px] text-slate-400 uppercase">
                              {comp.quantity > 1
                                ? `Extended Component Total (${comp.quantity} pcs)`
                                : 'Scenario-Based Component Total / Piece'}
                            </div>
                            <div className="text-base font-bold text-amber-300">
                              {comp.totalComponentCostSek.toFixed(2)} SEK (€{comp.totalComponentCostEur.toFixed(2)})
                            </div>
                            {comp.quantity > 1 && (
                              <div className="text-[11px] text-sky-300">
                                {(comp.totalComponentCostSek / comp.quantity).toFixed(2)} SEK / pc × {comp.quantity} pcs
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Sequential Manufacturing Steps for this BOM Component */}
                        <div className="space-y-1.5">
                          <div className="text-xs font-mono font-semibold text-sky-400 uppercase">
                            Sequential Manufacturing Steps ({comp.primaryProcess})
                          </div>
                          <div className="grid grid-cols-1 gap-1.5 text-xs text-slate-300">
                            {comp.manufacturingSteps.map((stepText, sIdx) => (
                              <div
                                key={sIdx}
                                className="p-2.5 rounded-lg bg-slate-900/90 border border-slate-800/80 font-mono leading-relaxed"
                              >
                                {stepText}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Manufacturing Operations Cost Elements Table with Explicit Equations */}
                        <div className="space-y-1.5">
                          <div className="text-xs font-mono font-semibold text-amber-400 uppercase">
                            Traceable Cost Elements &amp; Explicit Equations by Operation (Per Piece)
                          </div>
                          <div className="overflow-x-auto border border-slate-800 rounded-lg">
                            <table className="w-full text-left border-collapse text-xs font-mono">
                              <thead>
                                <tr className="bg-slate-900 border-b border-slate-800 text-slate-400">
                                  <th className="py-2.5 px-3">Manufacturing Operation</th>
                                  <th className="py-2.5 px-3">Cost Element</th>
                                  <th className="py-2.5 px-3">Explicit Equation &amp; Traceable Inputs</th>
                                  <th className="py-2.5 px-3 text-right">Cost / Piece (SEK)</th>
                                  <th className="py-2.5 px-3 text-right">Cost / Piece (EUR)</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/70">
                                {comp.operationCosts.map((op, opIdx) => (
                                  <tr key={opIdx} className="hover:bg-slate-900/60 align-top">
                                    <td className="py-2.5 px-3 text-amber-300 font-semibold whitespace-nowrap">
                                      {op.operationStep}
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-100">
                                      <div>{op.costElement}</div>
                                      <div className="text-[10px] text-slate-400 mt-0.5">{op.rateAndCalculationBasis}</div>
                                    </td>
                                    <td className="py-2.5 px-3 text-emerald-300/95 text-[11px]">
                                      {op.explicitEquation}
                                    </td>
                                    <td className="py-2.5 px-3 text-right font-semibold text-slate-100 tabular-nums whitespace-nowrap">
                                      {op.costSek.toFixed(2)} SEK
                                    </td>
                                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums whitespace-nowrap">
                                      €{op.costEur.toFixed(2)}
                                    </td>
                                  </tr>
                                ))}
                                <tr className="bg-amber-500/10 border-t border-amber-500/40 font-bold text-slate-100">
                                  <td colSpan={3} className="py-2.5 px-3 text-right uppercase text-amber-300">
                                    Verified Sum of Operation Costs ({comp.componentName})
                                  </td>
                                  <td className="py-2.5 px-3 text-right text-amber-300 tabular-nums whitespace-nowrap">
                                    {comp.totalComponentCostSek.toFixed(2)} SEK
                                  </td>
                                  <td className="py-2.5 px-3 text-right text-slate-100 tabular-nums whitespace-nowrap">
                                    €{comp.totalComponentCostEur.toFixed(2)}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 6. FINAL PART COST ROLL-UP FROM BOM COMPONENTS */}
                  <div className="p-5 rounded-xl bg-slate-950 border border-amber-500/50 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                      <div>
                        <span className="text-xs font-mono font-bold uppercase tracking-wider text-amber-400">
                          Final Part Cost Summary (Calculated from BOM Components)
                        </span>
                        <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                          Each BOM component&apos;s manufacturing process cost is summed to establish the final per-piece part cost
                        </p>
                      </div>
                      <span className="px-2.5 py-1 text-xs font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800 rounded">
                        Verified Component-to-Part Rollup
                      </span>
                    </div>

                    <div className="overflow-x-auto border border-slate-800 rounded-lg">
                      <table className="w-full text-left border-collapse text-xs font-mono">
                        <thead>
                          <tr className="bg-slate-900 border-b border-slate-800 text-slate-400">
                            <th className="py-2 px-3">BOM Item</th>
                            <th className="py-2 px-3">Component Name</th>
                            <th className="py-2 px-3">Primary Manufacturing Process</th>
                            <th className="py-2 px-3 text-right">Qty</th>
                            <th className="py-2 px-3 text-right">Net Mass</th>
                            <th className="py-2 px-3 text-right">Component Cost (SEK)</th>
                            <th className="py-2 px-3 text-right">Component Cost (EUR)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {ce.componentCostBreakdowns.map((comp) => (
                            <tr key={`rollup-${comp.itemNumber}`} className="bg-slate-950/60">
                              <td className="py-2 px-3 text-amber-300 font-semibold">#{comp.itemNumber}</td>
                              <td className="py-2 px-3 text-slate-100 font-semibold">{comp.componentName}</td>
                              <td className="py-2 px-3 text-slate-300">{comp.primaryProcess}</td>
                              <td className="py-2 px-3 text-right text-slate-200 tabular-nums">{comp.quantity}</td>
                              <td className="py-2 px-3 text-right text-slate-300 tabular-nums">{comp.netMassKg.toFixed(4)} kg</td>
                              <td className="py-2 px-3 text-right font-semibold text-slate-100 tabular-nums">
                                {comp.totalComponentCostSek.toFixed(2)} SEK
                              </td>
                              <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                                €{comp.totalComponentCostEur.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-amber-500/15 border-t border-amber-500/50 font-bold text-slate-100">
                            <td colSpan={5} className="py-2.5 px-3 text-right uppercase text-amber-300">
                              Final Manufacturing Cost of Part ({currentVersion.metadata.fileName} · Per Piece)
                            </td>
                            <td className="py-2.5 px-3 text-right text-amber-300 text-sm tabular-nums">
                              {ce.costBreakdownPerUnit.totalUnitCostSek.toFixed(2)} SEK
                            </td>
                            <td className="py-2.5 px-3 text-right text-slate-100 text-sm tabular-nums">
                              €{ce.costBreakdownPerUnit.totalUnitCostEur.toFixed(2)} EUR
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              );
            })()}

            {/* PART ENGINEERING AND COST ASSISTANT */}
            {revealedStageCount >= 6 && (
              <section id="stage-7" className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-sky-400" />
                    <div>
                      <h2 className="text-lg font-bold text-slate-100 font-display">
                        Part Engineering and Cost Assistant
                      </h2>
                      <p className="text-xs font-mono text-slate-400">
                        Ask any question about the {currentVersion.metadata.fileName} part
                      </p>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 text-[11px] font-mono bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-lg flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Grounded in 3D Part Geometry</span>
                  </span>
                </div>

                {/* Quick Engineering Question Chips */}
                <div className="flex flex-wrap gap-1.5">
                  {[
                    `How are the dimensions and volume of ${currentVersion.metadata.fileName} measured from the 3D model?`,
                    `What specifications are extracted from the 3D CAD model vs. predicted/assumed?`,
                    `Explain the BOM components and the manufacturing process for each component`,
                    `How is the final per-piece cost calculated from the BOM components?`,
                  ].map((qChip) => (
                    <button
                      key={qChip}
                      type="button"
                      disabled={isChatLoading}
                      onClick={() => handleAskPartChatbot(qChip)}
                      className="px-2.5 py-1.5 text-xs bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 hover:border-sky-500/50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {qChip}
                    </button>
                  ))}
                </div>

                {/* Chat Message Transcript */}
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 max-h-96 overflow-y-auto">
                  {chatMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`p-3.5 rounded-lg text-xs leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-sky-950/50 border border-sky-800/70 text-slate-100 ml-8'
                          : 'bg-slate-900 border border-slate-800 text-slate-200 mr-4'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 mb-1">
                        <span className="font-bold uppercase text-sky-400">
                          {msg.role === 'user' ? 'Engineer Question' : 'Part Engineering and Cost Assistant'}
                        </span>
                        <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <div className="whitespace-pre-line">{msg.content}</div>
                      {msg.referencedSections && msg.referencedSections.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-slate-800/80 flex flex-wrap gap-1.5">
                          {msg.referencedSections.map((sec) => (
                            <span
                              key={sec}
                              className="px-2 py-0.5 text-[10px] font-mono bg-slate-950 text-amber-300 border border-slate-800 rounded"
                            >
                              {sec}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {isChatLoading && (
                    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 flex items-center gap-2 text-xs font-mono text-slate-400">
                      <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
                      <span>Analyzing {currentVersion.metadata.fileName} 3D model, BOM &amp; cost calculation...</span>
                    </div>
                  )}
                </div>

                {/* Chat Input Bar */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAskPartChatbot();
                  }}
                  className="flex gap-2"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={`Ask any question about the ${currentVersion.metadata.fileName} part...`}
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="submit"
                    disabled={isChatLoading || !chatInput.trim()}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Ask Assistant</span>
                  </button>
                </form>
              </section>
            )}

            {revealedStageCount > 0 && revealedStageCount < 6 && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setRevealedStageCount((c) => Math.min(6, c + 1))}
                  className="px-4 py-2 text-xs font-mono text-slate-200 bg-slate-900 border border-slate-800 rounded-lg flex items-center gap-2 hover:bg-slate-800"
                >
                  <span>Loading stage {revealedStageCount + 1} of 6</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {previewSnippet && (
        <div
          onClick={() => setPreviewSnippet(null)}
          className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full overflow-hidden shadow-2xl"
          >
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold text-slate-100">{previewSnippet.title}</div>
                <div className="text-xs font-mono text-amber-400 mt-0.5">
                  {previewSnippet.detail}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewSnippet(null)}
                className="px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-200 rounded cursor-pointer"
              >
                Close
              </button>
            </div>
            <div className="p-4 bg-slate-950 flex justify-center">
              <img
                src={previewSnippet.dataUrl}
                alt={previewSnippet.title}
                referrerPolicy="no-referrer"
                className="w-full max-h-[480px] object-contain rounded border border-slate-800"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
