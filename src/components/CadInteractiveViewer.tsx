import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  CadComponentMeshData,
  CadEngineeringAnnotation,
  CadFaceFeature,
  PreviewGeometryOverlay,
} from '../types/cad';
import {
  detectSoftwareWebGL,
  getFinishPbrParams,
} from '../lib/studioPhotographRenderer';

interface CadInteractiveViewerProps {
  components: CadComponentMeshData[];
  baselineComponents?: CadComponentMeshData[];
  features: CadFaceFeature[];
  annotations: CadEngineeringAnnotation[];
  selectedFeatureId: string | null;
  onSelectFeature: (featureId: string | null) => void;
  isolatedComponentIndex: number | null;
  activePreviewOverlay?: PreviewGeometryOverlay | null;
  onApplyActivePreview?: () => void;
  isApplyingModification?: boolean;
  versionNumber?: number;
  lastModifiedFeatureId?: string | null;
}

export const CadInteractiveViewer: React.FC<CadInteractiveViewerProps> = ({
  components,
  baselineComponents,
  features,
  selectedFeatureId,
  onSelectFeature,
  isolatedComponentIndex,
  activePreviewOverlay = null,
  onApplyActivePreview,
  isApplyingModification = false,
  versionNumber = 1,
  lastModifiedFeatureId = null,
}) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshGroupRef = useRef<THREE.Group | null>(null);
  const overlayGroupRef = useRef<THREE.Group | null>(null);
  const requestRenderRef = useRef<() => void>(() => {});
  const hasFramedInitialModelRef = useRef<boolean>(false);
  const modelBoundsRef = useRef<{ center: THREE.Vector3; radius: number }>({
    center: new THREE.Vector3(),
    radius: 60,
  });

  // Smooth camera transition targets
  const cameraTransitionRef = useRef<{
    active: boolean;
    targetPos: THREE.Vector3;
    targetLookAt: THREE.Vector3;
  }>({
    active: false,
    targetPos: new THREE.Vector3(),
    targetLookAt: new THREE.Vector3(),
  });

  const [showBaselineGhost, setShowBaselineGhost] = useState<boolean>(true);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(false);

  const featuresRef = useRef<CadFaceFeature[]>(features);
  featuresRef.current = features;
  const selectedFeatureIdRef = useRef<string | null>(selectedFeatureId);
  selectedFeatureIdRef.current = selectedFeatureId;
  const onSelectFeatureRef = useRef(onSelectFeature);
  onSelectFeatureRef.current = onSelectFeature;

  const focusCameraOnPointAndNormal = (
    focusCenter: [number, number, number],
    normalOrAxis: [number, number, number]
  ) => {
    const { center: modelCenter, radius: modelRadius } = modelBoundsRef.current;
    const targetPt = new THREE.Vector3(...focusCenter);
    const nVec = new THREE.Vector3(...normalOrAxis);
    if (nVec.lengthSq() < 1e-6) {
      nVec.set(1, -1, 0.8).normalize();
    } else {
      nVec.normalize();
    }

    // Ensure viewing vector points outward from model center toward the feature
    const fromCenter = new THREE.Vector3().subVectors(targetPt, modelCenter);
    if (fromCenter.lengthSq() > 1.0 && nVec.dot(fromCenter) < -0.1) {
      nVec.negate();
    }

    // Add a 28-degree isometric offset so the engineer sees both the feature and 3D part context clearly
    const upRef =
      Math.abs(nVec.z) < 0.85 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, -1, 0).normalize();
    const sideRef = new THREE.Vector3().crossVectors(nVec, upRef).normalize();
    const viewDir = new THREE.Vector3()
      .addScaledVector(nVec, 0.82)
      .addScaledVector(upRef, 0.38)
      .addScaledVector(sideRef, 0.32)
      .normalize();

    const dist = Math.max(modelRadius * 1.45, 32);
    const desiredCamPos = new THREE.Vector3().copy(targetPt).addScaledVector(viewDir, dist);

    cameraTransitionRef.current = {
      active: true,
      targetPos: desiredCamPos,
      targetLookAt: targetPt,
    };
    requestRenderRef.current();
  };

  const setPresetCameraView = (preset: 'iso' | 'top' | 'front' | 'side' | 'focus') => {
    const { center, radius } = modelBoundsRef.current;
    const dist = Math.max(radius * 1.75, 35);

    if (preset === 'focus') {
      if (activePreviewOverlay) {
        focusCameraOnPointAndNormal(
          activePreviewOverlay.center,
          activePreviewOverlay.normalOrAxis
        );
        return;
      }
      const selFeat = features.find((f) => f.id === selectedFeatureId);
      if (selFeat) {
        focusCameraOnPointAndNormal(selFeat.centroid, selFeat.normalOrAxis);
        return;
      }
    }

    const nextPos = new THREE.Vector3();
    if (preset === 'top') {
      nextPos.set(center.x, center.y - 0.01, center.z + dist * 1.15);
    } else if (preset === 'front') {
      nextPos.set(center.x, center.y - dist * 1.15, center.z);
    } else if (preset === 'side') {
      nextPos.set(center.x + dist * 1.15, center.y, center.z);
    } else {
      nextPos.set(center.x + dist * 0.85, center.y - dist * 0.85, center.z + dist * 0.68);
    }

    cameraTransitionRef.current = {
      active: true,
      targetPos: nextPos,
      targetLookAt: center.clone(),
    };
    requestRenderRef.current();
  };

  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1120);
    sceneRef.current = scene;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.5, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(110, -110, 90);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;

    // Cancel scripted camera transition immediately when user interacts with OrbitControls
    const onControlStart = () => {
      cameraTransitionRef.current.active = false;
    };
    controls.addEventListener('start', onControlStart);

    const hemiLight = new THREE.HemisphereLight(0xe2e8f0, 0x0f172a, 0.85);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.75);
    keyLight.position.set(140, -160, 220);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.85);
    fillLight.position.set(-160, 120, 100);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xf8fafc, 1.05);
    rimLight.position.set(30, 180, -120);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(240, 24, 0x334155, 0x1e293b);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.05;
    (grid.material as THREE.Material).polygonOffset = true;
    (grid.material as THREE.Material).polygonOffsetFactor = 1;
    (grid.material as THREE.Material).polygonOffsetUnits = 1;
    scene.add(grid);

    const meshGroup = new THREE.Group();
    scene.add(meshGroup);
    meshGroupRef.current = meshGroup;

    const overlayGroup = new THREE.Group();
    scene.add(overlayGroup);
    overlayGroupRef.current = overlayGroup;

    let frameId = 0;
    let renderBusy = false;
    let renderDirty = false;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (!sync) {
          frameId = window.setTimeout(cb, 80);
          return;
        }
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function requestRender() {
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame(() => {
        renderDirty = false;

        let transitionStillMoving = false;
        const trans = cameraTransitionRef.current;
        if (trans.active) {
          const alpha = isSoftwareGl ? 0.45 : 0.18;
          camera.position.lerp(trans.targetPos, alpha);
          controls.target.lerp(trans.targetLookAt, alpha);
          if (
            camera.position.distanceToSquared(trans.targetPos) < 0.25 &&
            controls.target.distanceToSquared(trans.targetLookAt) < 0.1
          ) {
            camera.position.copy(trans.targetPos);
            controls.target.copy(trans.targetLookAt);
            trans.active = false;
          } else {
            transitionStillMoving = true;
          }
        }

        const needsMoreFrames = controls.update() || transitionStillMoving;
        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (renderDirty || needsMoreFrames) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    requestRenderRef.current = requestRender;
    controls.addEventListener('change', requestRender);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moveDist > 5) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const selectableMeshes = meshGroup.children.filter(
        (c): c is THREE.Mesh => (c as THREE.Mesh).isMesh && c.userData.isCadSolid
      );
      const intersects = raycaster.intersectObjects(selectableMeshes, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const compData = hit.object.userData.compData as CadComponentMeshData | undefined;
        const triIndex = hit.faceIndex;
        if (compData && typeof triIndex === 'number' && triIndex >= 0) {
          const featIdx = compData.faceIdPerTriangle[triIndex];
          const feat = featIdx >= 0 ? featuresRef.current[featIdx] : null;
          if (feat) {
            onSelectFeatureRef.current(
              selectedFeatureIdRef.current === feat.id ? null : feat.id
            );
            return;
          }
        }
      } else {
        onSelectFeatureRef.current(null);
      }
    };

    const domElem = renderer.domElement;
    domElem.addEventListener('pointerdown', onPointerDown);
    domElem.addEventListener('pointerup', onPointerUp);

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 500;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRender();
    });
    resizeObserver.observe(container);

    requestRender();

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      domElem.removeEventListener('pointerdown', onPointerDown);
      domElem.removeEventListener('pointerup', onPointerUp);
      controls.removeEventListener('start', onControlStart);
      controls.dispose();
      envTexture.dispose();
      renderer.dispose();
    };
  }, []);

  // Build 3D CAD solid mesh + baseline ghost wireframe
  useEffect(() => {
    const meshGroup = meshGroupRef.current;
    if (!meshGroup) return;

    while (meshGroup.children.length > 0) {
      const child = meshGroup.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
      meshGroup.remove(child);
    }

    const overallBox = new THREE.Box3();
    const selectedColor = new THREE.Color(0x06b6d4); // Bright Cyan for selected/inspected feature
    const modifiedColor = new THREE.Color(0x10b981); // Emerald Green for newly modified geometry
    const machiningColor = new THREE.Color(0xf59e0b); // Amber for CNC machining highlights
    const tempColor = new THREE.Color();

    components.forEach((comp) => {
      if (isolatedComponentIndex !== null && isolatedComponentIndex !== comp.index) {
        return;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(comp.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(comp.normals, 3));

      const vertCount = comp.positions.length / 3;
      const colors = new Float32Array(vertCount * 3);
      const baseColor = new THREE.Color(comp.colorHex || 0x94a3b8);

      const selectedTriCoords: number[] = [];

      const triCount = Math.floor(comp.positions.length / 9);
      for (let t = 0; t < triCount; t++) {
        const featIdx = comp.faceIdPerTriangle[t];
        const feat = featIdx >= 0 ? features[featIdx] : undefined;
        const isSelected = Boolean(feat && feat.id === selectedFeatureId);
        const isLastModified = Boolean(feat && lastModifiedFeatureId && feat.id === lastModifiedFeatureId);
        const isMachining = Boolean(feat?.requiresMachiningHighlight);

        if (isSelected) {
          tempColor.copy(selectedColor);
        } else if (isLastModified) {
          tempColor.copy(modifiedColor);
        } else if (isMachining) {
          tempColor.copy(machiningColor);
        } else if (feat && feat.surfaceFinish !== 'default_metallic') {
          const pbr = getFinishPbrParams(feat.surfaceFinish, comp.colorHex);
          tempColor.setHex(pbr.color);
        } else {
          tempColor.copy(baseColor);
        }

        const vBase = t * 9;
        for (let k = 0; k < 9; k += 3) {
          colors[vBase + k] = tempColor.r;
          colors[vBase + k + 1] = tempColor.g;
          colors[vBase + k + 2] = tempColor.b;
        }

        if (isSelected || isLastModified) {
          for (let k = 0; k < 9; k++) {
            selectedTriCoords.push(comp.positions[vBase + k]);
          }
        }
      }

      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeBoundingBox();

      const pbrParams = getFinishPbrParams('default_metallic', comp.colorHex);
      const material = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        metalness: pbrParams.metalness,
        roughness: pbrParams.roughness,
        clearcoat: pbrParams.clearcoat,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = {
        isCadSolid: true,
        compData: comp,
      };
      meshGroup.add(mesh);
      overallBox.expandByObject(mesh);

      const edgesGeom = new THREE.EdgesGeometry(geometry, 20);
      const edgesMat = new THREE.LineBasicMaterial({
        color: 0xe2e8f0,
        transparent: true,
        opacity: 0.42,
      });
      const edgeLines = new THREE.LineSegments(edgesGeom, edgesMat);
      meshGroup.add(edgeLines);

      // Add high-contrast boundary highlight outline around selected/modified feature triangles
      if (selectedTriCoords.length >= 9) {
        const selGeom = new THREE.BufferGeometry();
        selGeom.setAttribute(
          'position',
          new THREE.BufferAttribute(new Float32Array(selectedTriCoords), 3)
        );
        const selEdgesGeom = new THREE.EdgesGeometry(selGeom, 12);
        const selEdgesMat = new THREE.LineBasicMaterial({
          color: selectedFeatureId ? 0x38bdf8 : 0x34d399,
          transparent: true,
          opacity: 0.95,
        });
        const selEdgeLines = new THREE.LineSegments(selEdgesGeom, selEdgesMat);
        meshGroup.add(selEdgeLines);
        selGeom.dispose();
      }
    });

    // If viewing v2+ and baselineComponents (v1) is provided, render subtle ghost wireframe of v1 original geometry
    if (
      baselineComponents &&
      baselineComponents.length > 0 &&
      versionNumber > 1 &&
      showBaselineGhost
    ) {
      baselineComponents.forEach((baseComp) => {
        if (isolatedComponentIndex !== null && isolatedComponentIndex !== baseComp.index) {
          return;
        }
        const ghostGeom = new THREE.BufferGeometry();
        ghostGeom.setAttribute('position', new THREE.BufferAttribute(baseComp.positions, 3));
        const ghostEdges = new THREE.EdgesGeometry(ghostGeom, 22);
        const ghostMat = new THREE.LineBasicMaterial({
          color: 0xf59e0b,
          transparent: true,
          opacity: 0.35,
        });
        const ghostLines = new THREE.LineSegments(ghostEdges, ghostMat);
        meshGroup.add(ghostLines);
        ghostGeom.dispose();
      });
    }

    if (!overallBox.isEmpty()) {
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      overallBox.getCenter(center);
      overallBox.getSize(size);
      const radius = Math.max(size.length() * 0.65, 25);
      modelBoundsRef.current = { center, radius };

      if (!hasFramedInitialModelRef.current) {
        hasFramedInitialModelRef.current = true;
        if (cameraRef.current && controlsRef.current) {
          controlsRef.current.target.copy(center);
          cameraRef.current.position.set(
            center.x + radius * 1.35,
            center.y - radius * 1.35,
            center.z + radius * 1.05
          );
          controlsRef.current.update();
        }
      }
    }

    requestRenderRef.current();
  }, [
    components,
    baselineComponents,
    features,
    selectedFeatureId,
    isolatedComponentIndex,
    versionNumber,
    lastModifiedFeatureId,
    showBaselineGhost,
  ]);

  // Build 3D Preview Overlay Gizmo & Smoothly Orbit Camera when a Recommendation or Feature is clicked
  useEffect(() => {
    const overlayGroup = overlayGroupRef.current;
    if (!overlayGroup) return;

    while (overlayGroup.children.length > 0) {
      const child = overlayGroup.children[0] as THREE.Object3D;
      child.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material.dispose();
        }
      });
      overlayGroup.remove(child);
    }

    const selFeat = features.find((f) => f.id === selectedFeatureId);

    if (activePreviewOverlay) {
      const center = new THREE.Vector3(...activePreviewOverlay.center);
      const axis = new THREE.Vector3(...activePreviewOverlay.normalOrAxis);
      if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
      else axis.normalize();

      const gizmoGroup = new THREE.Group();
      gizmoGroup.position.copy(center);

      // Align default Three.js Cylinder/Cone (+Y axis) with `axis`
      const defaultUp = new THREE.Vector3(0, 1, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(defaultUp, axis);
      gizmoGroup.quaternion.copy(quat);

      const targetR = Math.max(1.2, activePreviewOverlay.targetRadiusMm);
      const currentR = Math.max(0.5, activePreviewOverlay.currentRadiusMm);
      const depth = Math.max(2.0, Math.abs(activePreviewOverlay.depthOrOffsetMm) || 10);

      if (activePreviewOverlay.kind === 'hole_or_pocket') {
        // Render translucent cyan/emerald 3D cylindrical bore preview
        const cylGeom = new THREE.CylinderGeometry(targetR, targetR, depth, 32, 1, false);
        const cylMat = new THREE.MeshBasicMaterial({
          color: 0x06b6d4,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const cylMesh = new THREE.Mesh(cylGeom, cylMat);
        gizmoGroup.add(cylMesh);

        const cylEdges = new THREE.EdgesGeometry(cylGeom, 15);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x22d3ee });
        gizmoGroup.add(new THREE.LineSegments(cylEdges, lineMat));
      } else if (
        activePreviewOverlay.kind === 'bore_resize' ||
        activePreviewOverlay.kind === 'boss_modify'
      ) {
        // Current radius wireframe cylinder (amber)
        const curGeom = new THREE.CylinderGeometry(currentR, currentR, depth, 32, 1, true);
        const curEdges = new THREE.EdgesGeometry(curGeom, 15);
        gizmoGroup.add(
          new THREE.LineSegments(
            curEdges,
            new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.85 })
          )
        );
        curGeom.dispose();

        // Target radius translucent cylinder + wireframe (emerald/cyan)
        const tgtHeight =
          activePreviewOverlay.depthOrOffsetMm < 0
            ? Math.max(2.0, depth * 0.3)
            : depth * 1.04;
        const tgtGeom = new THREE.CylinderGeometry(targetR, targetR, tgtHeight, 32, 1, false);
        const tgtMat = new THREE.MeshBasicMaterial({
          color: 0x10b981,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        gizmoGroup.add(new THREE.Mesh(tgtGeom, tgtMat));
        const tgtEdges = new THREE.EdgesGeometry(tgtGeom, 15);
        gizmoGroup.add(
          new THREE.LineSegments(tgtEdges, new THREE.LineBasicMaterial({ color: 0x34d399 }))
        );
      } else if (activePreviewOverlay.kind === 'face_offset') {
        const signedOffset = activePreviewOverlay.depthOrOffsetMm;
        const discGeom = new THREE.CylinderGeometry(targetR, targetR, Math.abs(signedOffset), 32);
        discGeom.translate(0, signedOffset * 0.5, 0);
        const discMat = new THREE.MeshBasicMaterial({
          color: signedOffset < 0 ? 0x10b981 : 0x06b6d4,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        gizmoGroup.add(new THREE.Mesh(discGeom, discMat));
        const discEdges = new THREE.EdgesGeometry(discGeom, 15);
        gizmoGroup.add(
          new THREE.LineSegments(discEdges, new THREE.LineBasicMaterial({ color: 0x34d399 }))
        );
      } else if (activePreviewOverlay.kind === 'chamfer_edge') {
        const chamGeom = new THREE.CylinderGeometry(
          currentR,
          targetR,
          Math.max(1.5, depth),
          32,
          1,
          true
        );
        const chamMat = new THREE.MeshBasicMaterial({
          color: 0x10b981,
          transparent: true,
          opacity: 0.38,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        gizmoGroup.add(new THREE.Mesh(chamGeom, chamMat));
        const chamEdges = new THREE.EdgesGeometry(chamGeom, 15);
        gizmoGroup.add(
          new THREE.LineSegments(chamEdges, new THREE.LineBasicMaterial({ color: 0x34d399 }))
        );
      }

      // Add a crisp 3D axis indicator line along normalOrAxis
      const axisLen = Math.max(18, targetR * 1.6);
      const axisPts = [new THREE.Vector3(0, -axisLen * 0.6, 0), new THREE.Vector3(0, axisLen, 0)];
      const axisGeom = new THREE.BufferGeometry().setFromPoints(axisPts);
      const axisLine = new THREE.Line(
        axisGeom,
        new THREE.LineBasicMaterial({ color: 0x38bdf8 })
      );
      gizmoGroup.add(axisLine);

      overlayGroup.add(gizmoGroup);

      focusCameraOnPointAndNormal(
        activePreviewOverlay.center,
        activePreviewOverlay.normalOrAxis
      );
    } else if (selFeat) {
      // Highlight selected feature with a 3D target callout ring at its centroid
      const center = new THREE.Vector3(...selFeat.centroid);
      const axis = new THREE.Vector3(...selFeat.normalOrAxis);
      if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
      else axis.normalize();

      const featGroup = new THREE.Group();
      featGroup.position.copy(center);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      featGroup.quaternion.copy(quat);

      const ringR = selFeat.diameterMm
        ? selFeat.diameterMm * 0.55
        : Math.max(4, Math.min(22, Math.sqrt(selFeat.areaMm2) * 0.35));
      const ringGeom = new THREE.RingGeometry(ringR * 0.88, ringR * 1.04, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      featGroup.add(new THREE.Mesh(ringGeom, ringMat));
      overlayGroup.add(featGroup);

      focusCameraOnPointAndNormal(selFeat.centroid, selFeat.normalOrAxis);
    } else {
      requestRenderRef.current();
    }
  }, [activePreviewOverlay, selectedFeatureId, features]);

  const selectedFeatObj = features.find((f) => f.id === selectedFeatureId);

  return (
    <div className="relative w-full h-[520px] bg-slate-950 border border-slate-800 rounded-xl overflow-hidden select-none">
      {/* Isolated WebGL Canvas Container */}
      <div ref={canvasMountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Top-Left Semantic HUD Badge (Never uses backdrop-filter over WebGL) */}
      <div className="absolute top-3 left-3 right-3 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
        <div className="bg-slate-900/95 border border-slate-700/90 rounded-lg px-3 py-2 text-xs font-mono max-w-md pointer-events-auto shadow-lg">
          {activePreviewOverlay ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">
                  3D Engineering Preview Active
                </span>
                {selectedFeatureId && (
                  <span className="text-[10px] text-sky-300">· Target: {selectedFeatureId}</span>
                )}
              </div>
              <div className="font-bold text-slate-100">{activePreviewOverlay.label}</div>
              <div className="text-[11px] text-slate-300">
                3D Coordinates: ({activePreviewOverlay.center.map((v) => v.toFixed(1)).join(', ')}) mm
              </div>
              {onApplyActivePreview && (
                <div className="pt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isApplyingModification}
                    onClick={onApplyActivePreview}
                    className="px-2.5 py-1 text-[11px] font-mono font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded cursor-pointer disabled:opacity-50 whitespace-nowrap"
                  >
                    {isApplyingModification ? 'Applying to 3D Mesh...' : 'Apply Change on 3D Model'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectFeature(null)}
                    className="px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-slate-100 bg-slate-800 rounded cursor-pointer whitespace-nowrap"
                  >
                    Clear Preview
                  </button>
                </div>
              )}
            </div>
          ) : selectedFeatObj ? (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider font-bold text-sky-400">
                Selected 3D Feature · {selectedFeatObj.id}
              </div>
              <div className="font-bold text-slate-100">{selectedFeatObj.name}</div>
              <div className="text-[11px] text-slate-300">
                {selectedFeatObj.diameterMm
                  ? `Ø${selectedFeatObj.diameterMm.toFixed(2)} mm`
                  : `Area: ${selectedFeatObj.areaMm2.toFixed(1)} mm²`}{' '}
                · Centroid ({selectedFeatObj.centroid.map((v) => v.toFixed(1)).join(', ')}) mm
              </div>
            </div>
          ) : (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">
                Interactive 3D CAD Viewport · Revision v{versionNumber}
              </div>
              <div className="text-[11px] text-slate-300">
                Click any recommendation or click directly on a 3D surface/bore to inspect &amp; modify
              </div>
            </div>
          )}
        </div>

        {/* Top-Right Legend / Revision Indicator */}
        <div className="bg-slate-900/95 border border-slate-800 rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-slate-300 flex items-center gap-3 pointer-events-auto">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-block w-2.5 h-2.5 rounded-xs bg-cyan-400" />
            <span>Selected / Preview</span>
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="inline-block w-2.5 h-2.5 rounded-xs bg-amber-400" />
            <span>Modified / Machined</span>
          </span>
        </div>
      </div>

      {/* Collapsible Bottom Control Dock (Zero Mid-Screen Occlusion) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center pointer-events-auto max-w-[94%]">
        <button
          type="button"
          onClick={() => setControlsCollapsed((c) => !c)}
          className="px-2.5 py-0.5 text-[10px] font-mono text-slate-300 bg-slate-900/95 border border-b-0 border-slate-700 rounded-t-md hover:text-white cursor-pointer whitespace-nowrap"
        >
          {controlsCollapsed ? '▴ Show 3D Camera Controls' : '▾ Hide Controls'}
        </button>
        {!controlsCollapsed && (
          <div className="bg-slate-900/95 border border-slate-700 rounded-lg px-3 py-1.5 flex flex-wrap items-center justify-center gap-1.5 shadow-xl text-xs font-mono">
            <button
              type="button"
              onClick={() => setPresetCameraView('iso')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              ISO View
            </button>
            <button
              type="button"
              onClick={() => setPresetCameraView('top')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Top View (+Z)
            </button>
            <button
              type="button"
              onClick={() => setPresetCameraView('front')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Front View (-Y)
            </button>
            <button
              type="button"
              onClick={() => setPresetCameraView('side')}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap"
            >
              Side View (+X)
            </button>
            {(selectedFeatureId || activePreviewOverlay) && (
              <button
                type="button"
                onClick={() => setPresetCameraView('focus')}
                className="px-2.5 py-1 rounded bg-sky-500/20 border border-sky-500/50 hover:bg-sky-500/30 text-sky-300 cursor-pointer whitespace-nowrap"
              >
                Focus Target Zone
              </button>
            )}
            {versionNumber > 1 && baselineComponents && (
              <button
                type="button"
                onClick={() => setShowBaselineGhost((g) => !g)}
                className={`px-2.5 py-1 rounded border cursor-pointer whitespace-nowrap ${
                  showBaselineGhost
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400'
                }`}
              >
                {showBaselineGhost ? 'v1 Ghost Overlay: ON' : 'v1 Ghost Overlay: OFF'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
