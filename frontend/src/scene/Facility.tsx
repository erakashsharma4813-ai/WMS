import { Html, Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { Layout } from "../types";
import { hash01, smooth } from "./geometry";
import { PalletBatch, palletMatrix, usePalletParts, useRig, type Rig } from "./models";
import {
  CORRIDOR_Y,
  CORRIDOR_HALF,
  EXIT_BARRIER_X,
  FLOOR,
  GATE_BARRIER_X,
  GATE_LANES,
  ROAD_IN_Y,
  ROAD_OUT_Y,
  LAYBY_Y,
  SHIPMENT_TINTS,
  WALL_Y,
  YARD_BAY_ANGLE,
  YARD_BAY_COUNT,
  barrierLift,
  dockOpen,
  laneTints,
  yardBay,
  type DockSite,
  type SceneModel,
} from "./tracks";
import type { Origin } from "./Agents";
import { usePalette } from "./palette";

const OUTDOOR = new Set(["GATE", "HOLDING-YARD", "DOCK-APRON"]);
const BUILDING = { x0: 2, x1: 108, y0: 2, y1: WALL_Y };

const zoneColours: Record<string, string> = {
  production_output: "#b9ddd5",
  buffer: "#f0d982",
  picking: "#c9c1e8",
  gate: "#a7d5df",
  yard: "#c9d7d3",
  staging: "#9ad8cc",
  dock_apron: "#d9d4cd",
};

type ClockProps = { clock: MutableRefObject<number> };

/** Flat strips merged into one mesh: road paint, aisle lines, bay markings. */
function Strips({ strips, colour, y, opacity = 1 }: { strips: Array<[number, number, number, number, number?]>; colour: string; y: number; opacity?: number }) {
  const geometry = useMemo(() => {
    const parts = strips.map(([x, z, width, depth, yaw = 0]) => {
      const plane = new THREE.PlaneGeometry(width, depth);
      plane.rotateX(-Math.PI / 2);
      plane.rotateY(yaw);
      plane.translate(x, 0, z);
      return plane;
    });
    return parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry();
  }, [strips]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} position={[0, y, 0]} receiveShadow>
      <meshStandardMaterial color={colour} roughness={0.8} transparent={opacity < 1} opacity={opacity} polygonOffset polygonOffsetFactor={-2} />
    </mesh>
  );
}

function Ground({ origin, plot }: { origin: Origin; plot: Layout["plot"] }) {
  const palette = usePalette();
  const wx = (x: number) => x - origin.x;
  const wz = (y: number) => y - origin.y;
  const asphalt = useMemo<Array<[number, number, number, number, number?]>>(
    () => [
      [wx(-15), wz((GATE_LANES[0] + GATE_LANES[1]) / 2), 130, 10.5],
      [wx(37), wz(70), 32, 12],
      [wx(30), wz((ROAD_IN_Y + ROAD_OUT_Y) / 2), 200, 11],
      [wx(86), wz(78), 70, 26],
      [wx(32), wz(80), 26, 14],
      // lay-by beyond the outbound lane, where tractor-trailers wait for a dock
      [wx(80), wz(LAYBY_Y), 90, 4.6],
    ],
    [origin.x, origin.y],
  );
  const whiteLines = useMemo(() => {
    const lines: Array<[number, number, number, number, number?]> = [];
    for (let x = -68; x < 128; x += 6) lines.push([wx(x), wz((ROAD_IN_Y + ROAD_OUT_Y) / 2), 3, 0.18]);
    for (let x = -68; x < 6; x += 6) lines.push([wx(x), wz((GATE_LANES[0] + GATE_LANES[1]) / 2), 3, 0.18]);
    for (let i = 0; i <= YARD_BAY_COUNT; i += 1) {
      const bay = yardBay(i - 0.5);
      lines.push([wx(bay.x + 0.6), wz(bay.y + 0.4), 0.14, 9, -YARD_BAY_ANGLE + Math.PI / 2]);
    }
    GATE_LANES.forEach((lane) => lines.push([wx(GATE_BARRIER_X - 0.6), wz(lane), 0.35, 3.6]));
    lines.push([wx(EXIT_BARRIER_X + 0.8), wz(ROAD_OUT_Y), 0.35, 3.6]);
    return lines;
  }, [origin.x, origin.y]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx(plot.width_m / 2 + 5), -0.02, wz(plot.height_m / 2 + 8)]} receiveShadow>
        <planeGeometry args={[plot.width_m + 230, plot.height_m + 150]} />
        <meshStandardMaterial color={palette.outerGround} roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[wx(plot.width_m / 2), -0.01, wz(plot.height_m / 2 + 8)]} receiveShadow>
        <planeGeometry args={[plot.width_m + 12, plot.height_m + 36]} />
        <meshStandardMaterial color={palette.plotGround} roughness={0.95} />
      </mesh>
      <Strips strips={asphalt} colour={palette.asphalt} y={0.005} />
      <Strips strips={whiteLines} colour={palette.roadPaint} y={0.02} />
    </group>
  );
}

function Building({ origin, showEnvelope, sourceMode, docks }: { origin: Origin; showEnvelope: boolean; sourceMode: string; docks: DockSite[] }) {
  const palette = usePalette();
  const wx = (x: number) => x - origin.x;
  const wz = (y: number) => y - origin.y;
  const width = BUILDING.x1 - BUILDING.x0;
  const depth = BUILDING.y1 - BUILDING.y0;
  const cx = wx((BUILDING.x0 + BUILDING.x1) / 2);
  const cz = wz((BUILDING.y0 + BUILDING.y1) / 2);
  const accent = sourceMode === "recorded" ? "#3d7fa8" : sourceMode === "draft" ? "#865cad" : "#078c83";
  const annex = docks.filter((dock) => dock.extra);
  const annexEnd = annex.length ? Math.max(...annex.map((dock) => dock.cx + dock.width / 2 + 1)) : 0;
  const lowWall = 1.05;
  const doorGaps = docks.map((dock) => [dock.cx - 1.6, dock.cx + 1.6] as const).sort((a, b) => a[0] - b[0]);
  const northSegments: Array<[number, number]> = [];
  let cursor = BUILDING.x0;
  doorGaps.forEach(([a, b]) => {
    if (a > cursor) northSegments.push([cursor, Math.min(a, BUILDING.x1)]);
    cursor = Math.max(cursor, b);
  });
  if (cursor < BUILDING.x1) northSegments.push([cursor, BUILDING.x1]);
  const trusses = Array.from({ length: Math.floor(width / 12) + 1 }, (_, index) => BUILDING.x0 + index * 12);
  const lights = useMemo(() => {
    const strips: Array<[number, number, number, number, number?]> = [];
    for (let x = 10; x < 104; x += 12) for (let y = 8; y < 62; y += 9) strips.push([wx(x), wz(y), 4, 0.35]);
    return strips;
  }, [origin.x, origin.y]);

  return (
    <group>
      <mesh position={[cx, FLOOR / 2, cz]} castShadow receiveShadow>
        <boxGeometry args={[width, FLOOR, depth]} />
        <meshStandardMaterial color={palette.slab} roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, FLOOR + 0.005, cz]} receiveShadow>
        <planeGeometry args={[width - 0.2, depth - 0.2]} />
        <meshStandardMaterial color={palette.floor} roughness={0.7} metalness={0.02} />
      </mesh>
      {annex.length > 0 && (
        <mesh position={[wx((BUILDING.x1 + annexEnd) / 2), FLOOR / 2, wz(WALL_Y - 5)]} castShadow receiveShadow>
          <boxGeometry args={[annexEnd - BUILDING.x1, FLOOR, 10]} />
          <meshStandardMaterial color={palette.annex} roughness={0.9} />
        </mesh>
      )}
      {northSegments.map(([a, b]) => (
        <mesh key={`n-${a}`} position={[wx((a + b) / 2), FLOOR + lowWall / 2, wz(BUILDING.y1 - 0.12)]} castShadow receiveShadow>
          <boxGeometry args={[b - a, lowWall, 0.25]} />
          <meshStandardMaterial color={palette.wall} roughness={0.6} />
        </mesh>
      ))}
      <mesh position={[wx(BUILDING.x1 - 0.12), FLOOR + lowWall / 2, cz]} castShadow receiveShadow>
        <boxGeometry args={[0.25, lowWall, depth]} />
        <meshStandardMaterial color={palette.wall} roughness={0.6} />
      </mesh>
      <mesh position={[cx, FLOOR + (showEnvelope ? 4.6 : lowWall / 2), wz(BUILDING.y0 + 0.12)]} castShadow receiveShadow>
        <boxGeometry args={[width, showEnvelope ? 9.2 : lowWall, 0.25]} />
        <meshStandardMaterial color={palette.farWall} roughness={0.65} />
      </mesh>
      <mesh position={[wx(BUILDING.x0 + 0.12), FLOOR + (showEnvelope ? 4.6 : lowWall / 2), cz]} castShadow receiveShadow>
        <boxGeometry args={[0.25, showEnvelope ? 9.2 : lowWall, depth]} />
        <meshStandardMaterial color={palette.farWallSide} roughness={0.65} />
      </mesh>
      {showEnvelope && (
        <group>
          {[2.4, 4.8, 7.2].map((height) => (
            <mesh key={height} position={[cx, FLOOR + height, wz(BUILDING.y0 + 0.27)]}>
              <boxGeometry args={[width, 0.06, 0.04]} />
              <meshStandardMaterial color={palette.wallRib} />
            </mesh>
          ))}
          <mesh position={[cx, FLOOR + 9.05, wz(BUILDING.y0 + 0.3)]}>
            <boxGeometry args={[width + 0.2, 0.6, 0.3]} />
            <meshStandardMaterial color={accent} roughness={0.45} />
          </mesh>
          <mesh position={[wx(BUILDING.x0 + 0.3), FLOOR + 9.05, cz]}>
            <boxGeometry args={[0.3, 0.6, depth + 0.2]} />
            <meshStandardMaterial color={accent} roughness={0.45} />
          </mesh>
          {trusses.map((x) => (
            <group key={x}>
              <mesh position={[wx(x), FLOOR + 9.7, wz(BUILDING.y0 + depth * 0.3)]}>
                <boxGeometry args={[0.12, 0.3, depth * 0.6]} />
                <meshStandardMaterial color={palette.truss} metalness={0.4} roughness={0.5} />
              </mesh>
              <mesh position={[wx(x), FLOOR + 4.8, wz(BUILDING.y0 + 0.4)]} castShadow>
                <boxGeometry args={[0.3, 9.6, 0.3]} />
                <meshStandardMaterial color={palette.column} metalness={0.5} roughness={0.45} />
              </mesh>
            </group>
          ))}
          <mesh position={[cx, FLOOR + 9.95, wz(BUILDING.y0 + depth * 0.22)]} rotation={[-0.05, 0, 0]}>
            <boxGeometry args={[width, 0.12, depth * 0.44]} />
            <meshStandardMaterial color={accent} transparent opacity={0.12} roughness={0.3} depthWrite={false} />
          </mesh>
          <Strips strips={lights} colour={palette.ceilingLight} y={FLOOR + 9.3} />
          <Html zIndexRange={[8, 0]} position={[wx(30), FLOOR + 6.6, wz(BUILDING.y0 + 0.35)]} center transform distanceFactor={26}>
            <div className="warehouse-sign">Dispatch Twin DC</div>
          </Html>
        </group>
      )}
    </group>
  );
}

function FloorMarkings({ origin }: { origin: Origin }) {
  const palette = usePalette();
  const wx = (x: number) => x - origin.x;
  const wz = (y: number) => y - origin.y;
  const yellow = useMemo(() => {
    const strips: Array<[number, number, number, number, number?]> = [];
    const horizontal = (y: number, x0: number, x1: number) => {
      strips.push([wx((x0 + x1) / 2), wz(y - 1.75), x1 - x0, 0.1]);
      strips.push([wx((x0 + x1) / 2), wz(y + 1.75), x1 - x0, 0.1]);
    };
    const vertical = (x: number, y0: number, y1: number) => {
      strips.push([wx(x - 1.75), wz((y0 + y1) / 2), 0.1, y1 - y0]);
      strips.push([wx(x + 1.75), wz((y0 + y1) / 2), 0.1, y1 - y0]);
    };
    [18.5, 31.5].forEach((y) => horizontal(y, 29, 101));
    horizontal(48, 24, 106);
    [27, 65, 103].forEach((x) => vertical(x, 6, 46));
    // the dock-side travel lane and the two lead-ins from the cross-aisle: edge lines and a dashed centre
    strips.push([wx(79), wz(CORRIDOR_Y - CORRIDOR_HALF), 52, 0.08], [wx(79), wz(CORRIDOR_Y + CORRIDOR_HALF), 52, 0.08]);
    for (let x = 54; x < 104; x += 1.6) strips.push([wx(x + 0.4), wz(CORRIDOR_Y), 0.8, 0.08]);
    [53, 105].forEach((x) => {
      strips.push([wx(x - CORRIDOR_HALF), wz((49.75 + CORRIDOR_Y - CORRIDOR_HALF) / 2), 0.08, CORRIDOR_Y - CORRIDOR_HALF - 49.75]);
      strips.push([wx(x + CORRIDOR_HALF), wz((49.75 + CORRIDOR_Y - CORRIDOR_HALF) / 2), 0.08, CORRIDOR_Y - CORRIDOR_HALF - 49.75]);
      for (let y = 50.5; y < CORRIDOR_Y - 1.5; y += 1.6) strips.push([wx(x), wz(y + 0.4), 0.08, 0.8]);
    });
    return strips;
  }, [origin.x, origin.y]);
  const walkway = useMemo<Array<[number, number, number, number, number?]>>(() => [[wx(28.8), wz(56), 1.1, 14], [wx(40), wz(60.6), 22, 1.1]], [origin.x, origin.y]);
  return (
    <group>
      <Strips strips={yellow} colour={palette.safetyYellow} y={FLOOR + 0.012} />
      <Strips strips={walkway} colour={palette.walkway} y={FLOOR + 0.012} opacity={0.8} />
    </group>
  );
}

function Zones({ layout, origin, highlight, heat, onSelect }: { layout: Layout; origin: Origin; highlight: string[]; heat: string; onSelect: (id: string) => void }) {
  const palette = usePalette();
  return (
    <>
      {layout.zones.map((zone) => {
        const outdoor = OUTDOOR.has(zone.zone_id);
        const isStress = zone.zone_id === "FG-BUFFER" || zone.zone_id === "MARSHALLING";
        const isImpact = highlight.includes(zone.zone_id);
        const colour = isImpact ? "#ffd45e" : isStress ? heat : zoneColours[zone.type] ?? "#d5dfdc";
        const y = (outdoor ? 0 : FLOOR) + 0.02;
        const hw = zone.width / 2;
        const hh = zone.height / 2;
        return (
          <group key={zone.zone_id} position={[zone.x + hw - origin.x, y, zone.y + hh - origin.y]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} onClick={(event) => { event.stopPropagation(); if (event.delta > 6) return; onSelect(zone.zone_id); }}>
              <planeGeometry args={[zone.width, zone.height]} />
              <meshStandardMaterial color={colour} emissive={isImpact ? "#ffb300" : "#000000"} emissiveIntensity={isImpact ? 0.35 : 0} transparent opacity={isImpact ? 0.6 : (isStress ? 0.32 : outdoor ? 0.22 : 0.35) * palette.zoneOpacity} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
            </mesh>
            <Line points={[[-hw, 0.01, -hh], [hw, 0.01, -hh], [hw, 0.01, hh], [-hw, 0.01, hh], [-hw, 0.01, -hh]]} color={isImpact ? "#f59e0b" : isStress ? heat : "#7f9a94"} lineWidth={isImpact ? 3 : 1.2} dashed={!isImpact && !isStress} dashSize={0.8} gapSize={0.5} />
            <Html zIndexRange={[8, 0]} position={[-hw + 0.4, 0.4, -hh + 0.4]} transform rotation={[-Math.PI / 2, 0, 0]} distanceFactor={26} style={{ pointerEvents: "none" }}>
              <div className="zone-label">{zone.name}</div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

// --- racks -----------------------------------------------------------------

const RACK_ROWS = [0.55, 1.75, 6.25, 7.45];
const BAY = 2.8;
const LEVELS = 5;

function Racks({ layout, origin, highlight, onSelect }: { layout: Layout; origin: Origin; highlight: string[]; onSelect: (id: string) => void }) {
  const built = useMemo(() => {
    const upright = new THREE.BoxGeometry(0.09, 7.0, 0.09);
    const beam = new THREE.BoxGeometry(BAY, 0.12, 0.06);
    const base = new THREE.BoxGeometry(0.8, 0.14, 1.2);
    const load = new THREE.BoxGeometry(0.76, 1.0, 1.16);
    const uprightMaterial = new THREE.MeshStandardMaterial({ color: "#1d6f8a", metalness: 0.45, roughness: 0.45 });
    const beamMaterial = new THREE.MeshStandardMaterial({ color: "#ee8b2b", metalness: 0.3, roughness: 0.5 });
    const highlightMaterial = new THREE.MeshStandardMaterial({ color: "#ffd45e", emissive: "#f59e0b", emissiveIntensity: 0.3 });
    const baseMaterial = new THREE.MeshStandardMaterial({ color: "#a8784a", roughness: 0.85 });
    const loadMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.7 });
    const counts = layout.rack_blocks.map((rack) => Math.round(rack.width / BAY));
    const uprightCount = counts.reduce((sum, bays) => sum + (bays + 1) * RACK_ROWS.length * 2, 0);
    const beamCount = counts.reduce((sum, bays) => sum + bays * RACK_ROWS.length * 2 * (LEVELS - 1), 0);
    const slotCount = counts.reduce((sum, bays) => sum + bays * RACK_ROWS.length * LEVELS * 3, 0);
    const uprights = new THREE.InstancedMesh(upright, uprightMaterial, uprightCount);
    const beams = new THREE.InstancedMesh(beam, beamMaterial, beamCount);
    const bases = new THREE.InstancedMesh(base, baseMaterial, slotCount);
    const loads = new THREE.InstancedMesh(load, loadMaterial, slotCount);
    uprights.castShadow = beams.castShadow = true;
    bases.receiveShadow = loads.receiveShadow = true;
    loads.castShadow = false;
    return { uprights, beams, bases, loads, highlightMaterial, uprightMaterial, beamMaterial };
  }, [layout]);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    let u = 0;
    let b = 0;
    let p = 0;
    const kraft = new THREE.Color("#c4925c");
    layout.rack_blocks.forEach((rack) => {
      const bays = Math.round(rack.width / BAY);
      RACK_ROWS.forEach((offset, rowIndex) => {
        const z = rack.y + offset - origin.y;
        for (let bay = 0; bay <= bays; bay += 1) {
          for (const side of [-0.5, 0.5]) {
            dummy.position.set(rack.x + bay * BAY - origin.x, FLOOR + 3.5, z + side);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            built.uprights.setMatrixAt(u++, dummy.matrix);
          }
        }
        for (let bay = 0; bay < bays; bay += 1) {
          for (let level = 1; level < LEVELS; level += 1) {
            for (const side of [-0.5, 0.5]) {
              dummy.position.set(rack.x + (bay + 0.5) * BAY - origin.x, FLOOR + level * 1.45, z + side);
              dummy.updateMatrix();
              built.beams.setMatrixAt(b++, dummy.matrix);
            }
          }
          for (let level = 0; level < LEVELS; level += 1) {
            for (let slot = 0; slot < 3; slot += 1) {
              const key = `${rack.rack_id}:${rowIndex}:${bay}:${level}:${slot}`;
              if (hash01(key) > 0.8) continue;
              const x = rack.x + bay * BAY + 0.47 + slot * 0.93 - origin.x;
              const y = FLOOR + level * 1.45 + (level ? 0.06 : 0);
              dummy.position.set(x, y + 0.07, z);
              dummy.updateMatrix();
              built.bases.setMatrixAt(p, dummy.matrix);
              const tall = 0.75 + hash01(`${key}:h`) * 0.4;
              dummy.position.set(x, y + 0.14 + tall / 2, z);
              dummy.scale.set(1, tall, 1);
              dummy.updateMatrix();
              built.loads.setMatrixAt(p, dummy.matrix);
              dummy.scale.set(1, 1, 1);
              const roll = hash01(`${key}:c`);
              built.loads.setColorAt(p, roll > 0.82 ? colour.set(SHIPMENT_TINTS[Math.floor(roll * 97) % SHIPMENT_TINTS.length]).lerp(kraft, 0.55) : colour.copy(kraft).offsetHSL(0, 0, (roll - 0.4) * 0.12));
              p += 1;
            }
          }
        }
      });
    });
    built.uprights.count = u;
    built.beams.count = b;
    built.bases.count = p;
    built.loads.count = p;
    [built.uprights, built.beams, built.bases, built.loads].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [built, layout, origin.x, origin.y]);

  useEffect(() => {
    const active = layout.rack_blocks.some((rack) => highlight.includes(rack.rack_id));
    built.beams.material = active ? built.highlightMaterial : built.beamMaterial;
  }, [built, highlight, layout]);

  return (
    <group>
      <primitive object={built.uprights} />
      <primitive object={built.beams} />
      <primitive object={built.bases} />
      <primitive object={built.loads} />
      {layout.rack_blocks.map((rack) => (
        <group key={rack.rack_id}>
          <mesh position={[rack.x + rack.width / 2 - origin.x, FLOOR + 3.5, rack.y + rack.height / 2 - origin.y]} onClick={(event) => { event.stopPropagation(); if (event.delta > 6) return; onSelect(rack.rack_id); }} visible={false}>
            <boxGeometry args={[rack.width, 7, rack.height]} />
          </mesh>
          <Html zIndexRange={[8, 0]} position={[rack.x + rack.width / 2 - origin.x, FLOOR + 7.6, rack.y + rack.height / 2 - origin.y]} center distanceFactor={26} style={{ pointerEvents: "none" }}>
            <div className="rack-label">{rack.rack_id}</div>
          </Html>
        </group>
      ))}
    </group>
  );
}

// --- dynamic stock ---------------------------------------------------------

function LaneStock({ model, origin, clock, onSelect }: { model: SceneModel; origin: Origin; onSelect: (id: string) => void } & ClockProps) {
  const parts = usePalletParts("pallet_full");
  const LANE_MAX = 44;
  const batches = useMemo(() => model.lanes.map(() => new PalletBatch(parts, LANE_MAX)), [model.lanes, parts]);
  const signatures = useRef<string[]>([]);
  useEffect(() => () => batches.forEach((batch) => batch.dispose()), [batches]);
  useFrame(() => {
    model.lanes.forEach((lane, laneIndex) => {
      const tints = laneTints(model.laneStock.get(lane.id), clock.current);
      const signature = tints.join(",");
      if (signature === signatures.current[laneIndex]) return;
      signatures.current[laneIndex] = signature;
      const batch = batches[laneIndex];
      // lanes are filled row by row from the aisle side, then stacked a second tier
      const columns = Math.max(1, Math.floor(lane.width / 1.0));
      const rows = Math.max(1, Math.floor((lane.y1 - lane.y0) / 1.3));
      const perTier = columns * rows;
      const pitch = lane.width / columns;
      tints.slice(0, LANE_MAX).forEach((tint, index) => {
        const tier = Math.floor(index / perTier);
        const slot = index % perTier;
        const column = slot % columns;
        const row = Math.floor(slot / columns);
        batch.set(index, palletMatrix(lane.cx - lane.width / 2 + pitch * (column + 0.5) - origin.x, FLOOR + tier * 1.17, lane.y0 + 0.7 + row * 1.3 - origin.y, Math.PI / 2), tint);
      });
      batch.commit(Math.min(LANE_MAX, tints.length));
    });
  });
  return (
    <group>
      {batches.map((batch, index) => (
        <primitive key={model.lanes[index].id} object={batch.group} />
      ))}
      {model.lanes.map((lane) => (
        <group key={lane.id}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[lane.cx - origin.x, FLOOR + 0.03, (lane.y0 + lane.y1) / 2 - origin.y]} onClick={(event) => { event.stopPropagation(); if (event.delta > 6) return; onSelect(lane.id); }}>
            <planeGeometry args={[lane.width, lane.y1 - lane.y0]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          <Line points={[[lane.cx - lane.width / 2 - origin.x, FLOOR + 0.02, lane.y0 - origin.y], [lane.cx + lane.width / 2 - origin.x, FLOOR + 0.02, lane.y0 - origin.y], [lane.cx + lane.width / 2 - origin.x, FLOOR + 0.02, lane.y1 - origin.y], [lane.cx - lane.width / 2 - origin.x, FLOOR + 0.02, lane.y1 - origin.y], [lane.cx - lane.width / 2 - origin.x, FLOOR + 0.02, lane.y0 - origin.y]]} color="#0f8f86" lineWidth={1.6} />
          <Html zIndexRange={[8, 0]} position={[lane.cx - origin.x, FLOOR + 0.05, lane.y0 - 0.6 - origin.y]} center transform rotation={[-Math.PI / 2, 0, 0]} distanceFactor={22} style={{ pointerEvents: "none" }}>
            <div className="lane-label">{lane.id}</div>
          </Html>
        </group>
      ))}
    </group>
  );
}

/** Pre-picked pallets waiting for their evening trucks (pre-pick policy). */
function PrestageStock({ layout, model, origin, clock }: { layout: Layout; model: SceneModel; origin: Origin } & ClockProps) {
  const zone = layout.zones.find((item) => item.zone_id === "PRESTAGE");
  const parts = usePalletParts("pallet_mixed");
  const capacity = 160;
  const batch = useMemo(() => new PalletBatch(parts, capacity), [parts]);
  const lastCount = useRef(-1);
  useEffect(() => () => batch.dispose(), [batch]);
  useLayoutEffect(() => {
    if (!zone) return;
    const columns = Math.floor(zone.width / 1.0);
    const rows = Math.floor(zone.height / 1.3);
    for (let index = 0; index < capacity; index += 1) {
      const tier = Math.floor(index / (columns * rows));
      const slot = index % (columns * rows);
      batch.set(index, palletMatrix(zone.x + 0.6 + (slot % columns) * 1.0 - origin.x, FLOOR + tier * 1.17, zone.y + 0.8 + Math.floor(slot / columns) * 1.3 - origin.y, Math.PI / 2), SHIPMENT_TINTS[index % SHIPMENT_TINTS.length]);
    }
  }, [batch, zone, origin.x, origin.y]);
  useFrame(() => {
    let count = 0;
    for (const sample of model.prestage) {
      if (sample.t > clock.current) break;
      count = sample.count;
    }
    if (count !== lastCount.current) {
      lastCount.current = count;
      batch.commit(Math.min(capacity, count));
    }
  });
  return zone ? <primitive object={batch.group} /> : null;
}

function BufferStock({ layout, model, origin, clock }: { layout: Layout; model: SceneModel; origin: Origin } & ClockProps) {
  const zone = layout.zones.find((item) => item.zone_id === "FG-BUFFER");
  const parts = usePalletParts("pallet_full");
  const capacity = zone?.capacity_pallets ?? 120;
  const batch = useMemo(() => new PalletBatch(parts, capacity), [parts, capacity]);
  const lastCount = useRef(-1);
  useEffect(() => () => batch.dispose(), [batch]);
  useLayoutEffect(() => {
    if (!zone) return;
    const rows = [2.2, 3.1, 7.2, 8.1, 12.2, 13.1];
    const columns = 10;
    let index = 0;
    for (let tier = 0; tier < 2; tier += 1)
      for (let row = 0; row < rows.length; row += 1)
        for (let column = 0; column < columns; column += 1) {
          const key = `buffer:${index}`;
          batch.set(index, palletMatrix(zone.x + 1.3 + column * 1.42 - origin.x, FLOOR + tier * 1.17, zone.y + rows[row] - origin.y), SHIPMENT_TINTS[Math.floor(hash01(key) * SHIPMENT_TINTS.length)]);
          index += 1;
        }
  }, [batch, zone, origin.x, origin.y]);
  useFrame(() => {
    const t = clock.current;
    let occupancy = 0.8;
    for (const sample of model.buffer) {
      if (sample.t > t) break;
      occupancy = sample.occupancy;
    }
    const count = Math.round(capacity * Math.min(1, occupancy));
    if (count !== lastCount.current) {
      lastCount.current = count;
      batch.commit(count);
    }
  });
  return <primitive object={batch.group} />;
}

function ProductionLine({ layout, model, origin, clock }: { layout: Layout; model: SceneModel; origin: Origin } & ClockProps) {
  const zone = layout.zones.find((item) => item.zone_id === "PRODUCTION-OUT");
  const parts = usePalletParts("pallet_full");
  const moving = useMemo(() => new PalletBatch(parts, 8), [parts]);
  const staged = useMemo(() => new PalletBatch(parts, 12), [parts]);
  const ring = useRef<THREE.Group>(null);
  const rollers = useMemo(() => {
    const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 10), new THREE.MeshStandardMaterial({ color: "#9aa7ab", metalness: 0.8, roughness: 0.3 }), 70);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 70; i += 1) {
      dummy.position.set(0, 0, 0);
      dummy.rotation.set(Math.PI / 2, 0, 0);
      dummy.position.x = i * 0.24;
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.castShadow = true;
    return mesh;
  }, []);
  useEffect(() => () => {
    moving.dispose();
    staged.dispose();
  }, [moving, staged]);
  const y = zone ? zone.y + zone.height / 2 : 11.5;
  const x0 = zone ? zone.x + 2 : 6;
  const length = 16.5;
  useFrame((_, delta) => {
    const t = clock.current;
    let active = 0;
    let wrapping = false;
    let recent = 0;
    for (const release of model.production) {
      if (release.t > t) break;
      const age = t - release.t;
      if (age < 3 && active < 8) {
        const progress = smooth(age / 3);
        const x = x0 + progress * length;
        if (Math.abs(x - (x0 + 3.5)) < 0.8) wrapping = true;
        moving.set(active, palletMatrix(x - origin.x, FLOOR + 0.55, y - origin.y), release.tint);
        active += 1;
      }
      if (age < 45) recent += 1;
    }
    moving.commit(active);
    const stagedCount = model.production.length ? Math.min(12, recent) : 4;
    for (let i = 0; i < stagedCount; i += 1) staged.set(i, palletMatrix(x0 + length + 1.6 - origin.x, FLOOR + Math.floor(i / 6) * 1.17, y - 4.2 + (i % 6) * 1.25 - origin.y, Math.PI / 2), SHIPMENT_TINTS[i % SHIPMENT_TINTS.length]);
    staged.commit(stagedCount);
    if (ring.current) ring.current.rotation.y += delta * (wrapping ? 3.2 : 0.15);
  });
  return (
    <group>
      <primitive object={moving.group} />
      <primitive object={staged.group} />
      <group position={[x0 - origin.x, FLOOR + 0.5, y - origin.y]}>
        <primitive object={rollers} />
        {[-0.6, 0.6].map((side) => (
          <mesh key={side} position={[length / 2, 0.02, side]} castShadow>
            <boxGeometry args={[length + 0.4, 0.14, 0.08]} />
            <meshStandardMaterial color="#2c7d8c" metalness={0.4} roughness={0.4} />
          </mesh>
        ))}
        {[0, length / 3, (2 * length) / 3, length].map((x) =>
          [-0.55, 0.55].map((side) => (
            <mesh key={`${x}-${side}`} position={[x, -0.25, side]}>
              <boxGeometry args={[0.08, 0.5, 0.08]} />
              <meshStandardMaterial color="#556b70" />
            </mesh>
          )),
        )}
      </group>
      <group position={[x0 + 3.5 - origin.x, FLOOR, y - origin.y]}>
        {[-1.2, 1.2].map((side) => (
          <mesh key={side} position={[0, 1.6, side]} castShadow>
            <boxGeometry args={[0.2, 3.2, 0.2]} />
            <meshStandardMaterial color="#2e3d42" metalness={0.4} />
          </mesh>
        ))}
        <mesh position={[0, 3.25, 0]} castShadow>
          <boxGeometry args={[0.4, 0.2, 2.6]} />
          <meshStandardMaterial color="#2e3d42" metalness={0.4} />
        </mesh>
        <group ref={ring} position={[0, 2.95, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.05, 0.05, 8, 40]} />
            <meshStandardMaterial color="#e1a730" metalness={0.5} roughness={0.3} />
          </mesh>
          <mesh position={[1.05, -0.5, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.8, 12]} />
            <meshStandardMaterial color="#e9f2f4" transparent opacity={0.8} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function MixedPickShelving({ layout, origin }: { layout: Layout; origin: Origin }) {
  const zone = layout.zones.find((item) => item.zone_id === "MIXED-PICK");
  const built = useMemo(() => {
    if (!zone) return null;
    const frame = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 2.2, 0.06), new THREE.MeshStandardMaterial({ color: "#1d6f8a", metalness: 0.4 }), 200);
    const shelf = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.04, 0.9), new THREE.MeshStandardMaterial({ color: "#c7d3d6", metalness: 0.3 }), 200);
    const totes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.32, 0.38), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.6 }), 900);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    let f = 0;
    let s = 0;
    let t = 0;
    const toteColours = ["#2f7ea6", "#e1a730", "#4f9a6a", "#d4553f", "#3aa6a0"];
    for (let row = 0; row < 3; row += 1) {
      const y = zone.y + 2.2 + row * 3.6;
      for (let bay = 0; bay < 6; bay += 1) {
        const x = zone.x + 2.6 + bay * 2.45;
        [-0.42, 0.42].forEach((dz) => [-1.2, 1.2].forEach((dx) => {
          dummy.position.set(x + dx - origin.x, FLOOR + 1.1, y + dz - origin.y);
          dummy.updateMatrix();
          frame.setMatrixAt(f++, dummy.matrix);
        }));
        for (let level = 0; level < 4; level += 1) {
          dummy.position.set(x - origin.x, FLOOR + 0.3 + level * 0.55, y - origin.y);
          dummy.updateMatrix();
          shelf.setMatrixAt(s++, dummy.matrix);
          for (let k = 0; k < 4; k += 1) {
            if (hash01(`${row}${bay}${level}${k}`) > 0.85) continue;
            dummy.position.set(x - 0.9 + k * 0.6 - origin.x, FLOOR + 0.48 + level * 0.55, y - origin.y);
            dummy.updateMatrix();
            totes.setMatrixAt(t, dummy.matrix);
            totes.setColorAt(t, colour.set(toteColours[(row + bay + level + k) % toteColours.length]));
            t += 1;
          }
        }
      }
    }
    frame.count = f;
    shelf.count = s;
    totes.count = t;
    [frame, shelf, totes].forEach((mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
    });
    return [frame, shelf, totes];
  }, [zone, origin.x, origin.y]);
  if (!built) return null;
  return <group>{built.map((mesh, index) => <primitive key={index} object={mesh} />)}</group>;
}

// --- fixtures --------------------------------------------------------------

function DockStation({ dock, model, origin, clock, highlight, onSelect }: { dock: DockSite; model: SceneModel; origin: Origin; highlight: boolean; onSelect: (id: string) => void } & ClockProps) {
  const rig = useRig("dock_station");
  const door = rig.node("door");
  const red = useMemo(() => rig.materials("signal_red"), [rig]);
  const green = useMemo(() => rig.materials("signal_green"), [rig]);
  const glow = useRef<THREE.Mesh>(null);
  const outTag = useRef<HTMLDivElement>(null);
  useFrame((state) => {
    const t = clock.current;
    const windows = model.dockWindows.get(dock.id);
    const outOfService = Boolean(model.dockDown.get(dock.id)?.some(([from, to]) => t >= from && t < to));
    const open = outOfService ? 0 : dockOpen(windows, t);
    if (door) {
      door.position.y = rig.base("door").y + open * 3.1 * 0.9;
      door.scale.y = 1 - open * 0.9;
    }
    const occupied = Boolean(windows?.some(([from, to]) => t >= from - 1.2 && t <= to + 0.4));
    const flash = outOfService ? (Math.sin(state.clock.elapsedTime * 6) > 0 ? 3.5 : 0.2) : occupied ? 3 : 0.05;
    red.forEach((material) => (material.emissiveIntensity = flash));
    green.forEach((material) => (material.emissiveIntensity = occupied || outOfService ? 0.05 : 3));
    if (glow.current) {
      const material = glow.current.material as THREE.MeshBasicMaterial;
      material.opacity = highlight ? 0.45 : outOfService ? 0.32 : occupied ? 0.16 : 0;
      material.color.set(highlight ? "#ffc53d" : "#e65a5a");
    }
    if (outTag.current) outTag.current.style.display = outOfService ? "" : "none";
  });
  return (
    <group position={[dock.cx - origin.x, 0, WALL_Y - origin.y]} onClick={(event) => { event.stopPropagation(); if (event.delta > 6) return; onSelect(dock.id); }}>
      <primitive object={rig.root} />
      <mesh ref={glow} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 7]}>
        <planeGeometry args={[3.6, 13]} />
        <meshBasicMaterial color={highlight ? "#ffc53d" : "#e65a5a"} transparent opacity={0} depthWrite={false} />
      </mesh>
      {[-1.7, 1.7].map((side) => (
        <mesh key={side} rotation={[-Math.PI / 2, 0, 0]} position={[side, 0.025, 7]}>
          <planeGeometry args={[0.14, 13]} />
          <meshStandardMaterial color="#f1c232" />
        </mesh>
      ))}
      <Html zIndexRange={[8, 0]} position={[0, FLOOR + 4.7, 0.2]} center distanceFactor={22} style={{ pointerEvents: "none" }}>
        <div className={`dock-label${dock.extra ? " temporary" : ""}`}>{dock.id}{dock.extra ? " · temp" : ""}</div>
        <div ref={outTag} className="dock-out" style={{ display: "none" }}>OUT OF SERVICE</div>
      </Html>
    </group>
  );
}

function Barrier({ position, yaw, passes, clock }: { position: [number, number, number]; yaw: number; passes: number[] } & ClockProps) {
  const rig = useRig("barrier");
  const arm = rig.node("arm");
  useFrame(() => {
    if (arm) arm.rotation.z = barrierLift(passes, clock.current) * 1.42;
  });
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <primitive object={rig.root} />
    </group>
  );
}

function Gate({ model, origin, clock }: { model: SceneModel; origin: Origin } & ClockProps) {
  const house: Rig = useRig("gatehouse");
  const laneCentre = (GATE_LANES[0] + GATE_LANES[1]) / 2;
  const passes = useMemo(() => GATE_LANES.map((_, lane) => model.gatePasses.filter((pass) => pass.lane === lane).map((pass) => pass.t)), [model.gatePasses]);
  return (
    <group>
      <group position={[8 - origin.x, 0, laneCentre - origin.y]}>
        <primitive object={house.root} />
      </group>
      <Barrier position={[GATE_BARRIER_X - origin.x, 0, GATE_LANES[0] - 2.1 - origin.y]} yaw={-Math.PI / 2} passes={passes[0]} clock={clock} />
      <Barrier position={[GATE_BARRIER_X - origin.x, 0, GATE_LANES[1] + 2.1 - origin.y]} yaw={Math.PI / 2} passes={passes[1]} clock={clock} />
      <Barrier position={[EXIT_BARRIER_X - origin.x, 0, ROAD_OUT_Y + 2.2 - origin.y]} yaw={Math.PI / 2} passes={model.exitPasses} clock={clock} />
    </group>
  );
}

function Perimeter({ origin, plot }: { origin: Origin; plot: Layout["plot"] }) {
  const built = useMemo(() => {
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 2.2, 0.08), new THREE.MeshStandardMaterial({ color: "#5d7177", metalness: 0.5 }), 400);
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.22, 2.2, 8), new THREE.MeshStandardMaterial({ color: "#7a5b3c", roughness: 0.9 }), 60);
    const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.8, 1), new THREE.MeshStandardMaterial({ color: "#7fae84", roughness: 0.85, flatShading: true }), 60);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();
    let p = 0;
    const x0 = -1;
    const x1 = plot.width_m + 9;
    const y0 = -1;
    const y1 = ROAD_OUT_Y + 8;
    const fence = (ax: number, ay: number, bx: number, by: number) => {
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
      for (let i = 0; i <= steps && p < 400; i += 1) {
        dummy.position.set(ax + (bx - ax) * i / steps - origin.x, 1.1, ay + (by - ay) * i / steps - origin.y);
        dummy.updateMatrix();
        posts.setMatrixAt(p++, dummy.matrix);
      }
    };
    fence(x0, y0, x1, y0);
    fence(x0, y0, x0, GATE_LANES[0] - 3);
    fence(x1, y0, x1, ROAD_IN_Y - 7);
    fence(x0, y1, x1, y1);
    posts.count = p;
    let t = 0;
    for (let i = 0; i < 26; i += 1) {
      const along = i / 25;
      const x = x0 - 6 + along * (x1 - x0 + 12);
      const y = i % 2 ? y0 - 6 : y1 + 6;
      const scale = 0.8 + hash01(`tree${i}`) * 0.6;
      dummy.position.set(x - origin.x, 1.1 * scale, y - origin.y);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(t, dummy.matrix);
      dummy.position.y = 3.2 * scale;
      dummy.updateMatrix();
      crowns.setMatrixAt(t, dummy.matrix);
      crowns.setColorAt(t, colour.set(hash01(`c${i}`) > 0.5 ? "#7fae84" : "#93bb8b"));
      dummy.scale.setScalar(1);
      t += 1;
    }
    trunks.count = crowns.count = t;
    [posts, trunks, crowns].forEach((mesh) => {
      mesh.castShadow = true;
      mesh.computeBoundingSphere();
    });
    return [posts, trunks, crowns];
  }, [origin.x, origin.y, plot.width_m]);
  return <group>{built.map((mesh, index) => <primitive key={index} object={mesh} />)}</group>;
}

/** Plant signage on the far wall, as on a real dispatch hall. */
function Signage({ origin }: { origin: Origin }) {
  return (
    <group>
      <mesh position={[60 - origin.x, FLOOR + 7.6, BUILDING.y0 + 0.36 - origin.y]}>
        <boxGeometry args={[34, 1.1, 0.06]} />
        <meshStandardMaterial color="#1f8f4e" roughness={0.5} />
      </mesh>
      <Html zIndexRange={[6, 0]} position={[60 - origin.x, FLOOR + 7.6, BUILDING.y0 + 0.42 - origin.y]} center transform distanceFactor={26} style={{ pointerEvents: "none" }}>
        <div className="safety-banner">SAFETY FIRST · 412 DAYS WITHOUT A LOST-TIME INCIDENT</div>
      </Html>
      <mesh position={[22 - origin.x, FLOOR + 7.6, BUILDING.y0 + 0.36 - origin.y]}>
        <boxGeometry args={[18, 1.1, 0.06]} />
        <meshStandardMaterial color="#14191e" roughness={0.6} />
      </mesh>
      <Html zIndexRange={[6, 0]} position={[22 - origin.x, FLOOR + 7.6, BUILDING.y0 + 0.42 - origin.y]} center transform distanceFactor={26} style={{ pointerEvents: "none" }}>
        <div className="hall-sign">DISPATCH HALL · WAREHOUSE A</div>
      </Html>
    </group>
  );
}

export function Facility(props: {
  layout: Layout;
  model: SceneModel;
  origin: Origin;
  clock: MutableRefObject<number>;
  showEnvelope: boolean;
  sourceMode: string;
  highlight: string[];
  heat: string;
  onSelectLocation: (id: string) => void;
}) {
  const { layout, model, origin, clock, highlight, onSelectLocation } = props;
  return (
    <group>
      <Ground origin={origin} plot={layout.plot} />
      <Perimeter origin={origin} plot={layout.plot} />
      <Building origin={origin} showEnvelope={props.showEnvelope} sourceMode={props.sourceMode} docks={model.docks} />
      <FloorMarkings origin={origin} />
      <Zones layout={layout} origin={origin} highlight={highlight} heat={props.heat} onSelect={onSelectLocation} />
      <Racks layout={layout} origin={origin} highlight={highlight} onSelect={onSelectLocation} />
      <MixedPickShelving layout={layout} origin={origin} />
      <ProductionLine layout={layout} model={model} origin={origin} clock={clock} />
      <BufferStock layout={layout} model={model} origin={origin} clock={clock} />
      <PrestageStock layout={layout} model={model} origin={origin} clock={clock} />
      <LaneStock model={model} origin={origin} clock={clock} onSelect={onSelectLocation} />
      {model.docks.map((dock) => (
        <DockStation key={dock.id} dock={dock} model={model} origin={origin} clock={clock} highlight={highlight.includes(dock.id) || highlight.includes("DOCK-APRON")} onSelect={onSelectLocation} />
      ))}
      <Gate model={model} origin={origin} clock={clock} />
      {props.showEnvelope && <Signage origin={origin} />}
    </group>
  );
}
