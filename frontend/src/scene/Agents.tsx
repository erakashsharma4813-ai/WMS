import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

import { hash01, smooth } from "./geometry";
import { PalletBatch, makeRig, palletMatrix, pickOptions, useModel, usePalletParts, useRig, type Rig } from "./models";
import {
  FLOOR,
  KINGPIN_OFFSET,
  TRAILER_AXLE_FROM_KINGPIN,
  TRUCK_DIMS,
  cargoCount,
  latestEvent,
  samplePose,
  type Pose,
  type Track,
} from "./tracks";

export type Origin = { x: number; y: number };

type AgentProps = {
  track: Track;
  clock: MutableRefObject<number>;
  origin: Origin;
  selected: boolean;
  showLabels: boolean;
  onSelect: (id: string) => void;
  poses: Map<string, THREE.Vector3>;
  /** film mode: no status lamps or rings, only the equipment */
  plain?: boolean;
};

const SEVERITY_COLOURS = { normal: "#2bb3a3", warning: "#f0a52c", critical: "#e65a5a" } as const;

// equipment state, as in the legend strip: working, waiting (starved or idle), blocked (queued), down or late
export const STATE_COLOURS = { working: "#34d17a", waiting: "#f5a524", blocked: "#3b8cff", down: "#ff4d4f" } as const;
type StateCategory = keyof typeof STATE_COLOURS;

function stateOf(track: Track, state: string | undefined, severity: string, pose: Pose): StateCategory {
  if (state === "down" || severity === "critical") return "down";
  if (track.kind === "truck") {
    if (pose.moving) return "working";
    if (state === "gate_processing" || state === "docked" || state === "loading" || state === "loaded") return "working";
    if (state === "reported" || state === "yard_wait" || state === "called_to_dock") return "blocked";
    return "waiting";
  }
  return pose.moving || pose.activity !== "Waiting" ? "working" : "waiting";
}

function StatusLamp({ lampRef, height }: { lampRef: MutableRefObject<THREE.Mesh | null>; height: number }) {
  return (
    <mesh ref={lampRef} position={[0, height, 0]}>
      <sphereGeometry args={[0.24, 14, 10]} />
      <meshBasicMaterial color={STATE_COLOURS.waiting} toneMapped={false} />
    </mesh>
  );
}

function StatusRing({ ringRef, radius }: { ringRef: MutableRefObject<THREE.Mesh | null>; radius: number }) {
  return (
    <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} visible={false}>
      <ringGeometry args={[radius, radius + 0.35, 48]} />
      <meshBasicMaterial color="#2bb3a3" transparent opacity={0.85} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** Updates ring colour, label text and selection state without React renders. */
function useStatus(track: Track, selected: boolean, plain = false) {
  const ring = useRef<THREE.Mesh | null>(null);
  const lamp = useRef<THREE.Mesh | null>(null);
  const label = useRef<HTMLDivElement | null>(null);
  const last = useRef("");
  const update = (t: number, pose: Pose, elapsed: number) => {
    const event = latestEvent(track, t);
    const severity = event?.severity ?? "normal";
    if (lamp.current) lamp.current.visible = !plain;
    if (ring.current && plain) ring.current.visible = false;
    if (plain) return;
    if (lamp.current) {
      const category = stateOf(track, event?.state, severity, pose);
      (lamp.current.material as THREE.MeshBasicMaterial).color.set(STATE_COLOURS[category]);
      lamp.current.scale.setScalar(category === "down" ? 1 + Math.abs(Math.sin(elapsed * 5)) * 0.5 : 1);
    }
    if (ring.current) {
      const show = selected || severity !== "normal";
      ring.current.visible = show;
      const material = ring.current.material as THREE.MeshBasicMaterial;
      material.color.set(selected ? "#20c4b3" : SEVERITY_COLOURS[severity]);
      const pulse = 1 + Math.sin(elapsed * 4) * 0.06;
      ring.current.scale.setScalar(selected ? pulse : 1);
    }
    if (label.current) {
      label.current.style.display = "";
      const state = track.kind === "truck" ? (event?.state ?? "arriving").replaceAll("_", " ") : pose.activity;
      const key = `${severity}|${state}|${selected}`;
      if (key !== last.current) {
        last.current = key;
        label.current.className = `entity-label ${severity}${selected ? " selected" : ""}`;
        const small = label.current.querySelector("small");
        if (small) small.textContent = state;
      }
    }
  };
  const hide = () => {
    if (label.current) label.current.style.display = "none";
  };
  return { ring, lamp, label, update, hide };
}

function Label({ labelRef, track, height }: { labelRef: MutableRefObject<HTMLDivElement | null>; track: Track; height: number }) {
  return (
    <Html zIndexRange={[8, 0]} position={[0, height, 0]} center style={{ pointerEvents: "none" }}>
      <div ref={labelRef} className="entity-label" style={{ display: "none" }}>
        <b>{track.id}</b>
        <small />
      </div>
    </Html>
  );
}

function spinWheels(rig: Rig, odo: number) {
  rig.wheels.forEach(({ node, radius }) => {
    node.rotation.z = -odo / radius;
  });
}

function trackPoses(poses: Map<string, THREE.Vector3>, id: string, x: number, y: number, z: number) {
  const existing = poses.get(id);
  if (existing) existing.set(x, y, z);
  else poses.set(id, new THREE.Vector3(x, y, z));
}

// --------------------------------------------------------------------------- trucks

// Box bodies come in white, aluminium, grey and cream; the cab carries the fleet livery.
const BODY_SHELLS = ["#eef0ef", "#d9dee2", "#c4cbd0", "#efe8d8", "#e6e9e4"];

function TruckAgent({ track, clock, origin, selected, showLabels, onSelect, poses, plain }: AgentProps) {
  const variant = track.variant ?? "32FT";
  const dims = TRUCK_DIMS[variant];
  const body = useRig(variant === "20FT" || variant === "17FT" ? "truck_20" : variant === "32FT" ? "truck_32" : "tractor");
  const scale = dims.scale ?? 1;
  const trailerSource = useModel("trailer_40");
  const trailer = useMemo(() => (dims.articulated ? makeRig(trailerSource) : null), [dims.articulated, trailerSource]);
  const parts = usePalletParts("pallet_full");
  const cargo = useMemo(() => new PalletBatch(parts, Math.max(1, track.pallets ?? 1)), [parts, track.pallets]);
  const tractorGroup = useRef<THREE.Group>(null);
  const trailerGroup = useRef<THREE.Group>(null);
  const status = useStatus(track, selected, plain);
  const carrier = trailer ?? body;

  useLayoutEffect(() => {
    [body, trailer].forEach((rig) => rig?.materials("livery").forEach((material) => material.color.set(track.color)));
    const shell = BODY_SHELLS[Math.floor(hash01(`${track.id}:shell`) * BODY_SHELLS.length)];
    carrier.materials("shell").forEach((material) => material.color.set(shell));
    pickOptions(body, track.id);
    const rows = Math.max(1, Math.floor((dims.box - 0.4) / 1.22));
    const rear = dims.articulated ? -11.2 : -dims.length / 2 / scale;
    const deck = dims.articulated ? 1.25 : 1.2;
    for (let i = 0; i < (track.pallets ?? 0); i += 1) {
      const row = Math.floor(i / 2) % rows;
      const tier = Math.floor(i / (rows * 2));
      const depth = dims.box - 0.7 - row * 1.22;
      cargo.set(i, palletMatrix(rear + depth, deck + tier * 1.32, i % 2 ? -0.46 : 0.46), track.tint ?? "#d4553f");
    }
    carrier.root.add(cargo.group);
    return () => {
      carrier.root.remove(cargo.group);
    };
  }, [body, trailer, carrier, cargo, dims, track, scale]);
  useEffect(() => () => cargo.dispose(), [cargo]);

  const shells = useMemo(() => carrier.materials("shell"), [carrier]);
  const doorL = carrier.node("door_l");
  const doorR = carrier.node("door_r");
  const kingpin = new THREE.Vector2();

  useFrame((state) => {
    const t = clock.current;
    const pose = samplePose(track, t);
    const group = tractorGroup.current;
    if (!group) return;
    if (!pose) {
      group.visible = false;
      if (trailerGroup.current) trailerGroup.current.visible = false;
      poses.delete(track.id);
      status.hide();
      return;
    }
    group.visible = true;
    const wx = pose.x - origin.x;
    const wz = pose.y - origin.y;
    group.position.set(wx, 0, wz);
    group.rotation.y = -pose.angle;
    spinWheels(body, pose.odo / scale);
    trackPoses(poses, track.id, wx, 2, wz);

    let open = 0;
    if (track.dockWindow) {
      const [from, to] = track.dockWindow;
      open = Math.min(smooth((t - (from - 0.9)) / 0.5), 1 - smooth((t - to) / 0.4));
    }
    doorL && (doorL.rotation.y = -open * Math.PI * 1.47);
    doorR && (doorR.rotation.y = open * Math.PI * 1.47);
    const ghost = track.dockWindow && t >= track.dockWindow[0] - 0.2 ? open : 0;
    shells.forEach((material) => {
      material.transparent = ghost > 0.02;
      material.opacity = 1 - ghost * 0.74;
      material.depthWrite = ghost < 0.4;
    });
    cargo.commit(cargoCount(track, t));

    if (trailer && trailerGroup.current) {
      kingpin.set(pose.x - Math.cos(pose.angle) * KINGPIN_OFFSET, pose.y - Math.sin(pose.angle) * KINGPIN_OFFSET);
      const lookBack = KINGPIN_OFFSET + TRAILER_AXLE_FROM_KINGPIN;
      const axle = pose.ctx.path.at(pose.ctx.s + (pose.ctx.reverse ? lookBack : -lookBack));
      const angle = Math.atan2(kingpin.y - axle.y, kingpin.x - axle.x);
      trailerGroup.current.visible = true;
      trailerGroup.current.position.set(kingpin.x - origin.x, 0, kingpin.y - origin.y);
      trailerGroup.current.rotation.y = -angle;
      spinWheels(trailer, pose.odo);
    }
    status.update(t, pose, state.clock.elapsedTime);
  });

  const select = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.delta > 6) return; // a drag that pans the map is not a click
    onSelect(track.id);
  };
  return (
    <>
      <group ref={tractorGroup} onClick={select} visible={false}>
        <primitive object={body.root} scale={scale} />
        <StatusRing ringRef={status.ring} radius={dims.articulated ? 3.6 : dims.length / 2 + 0.4} />
        <StatusLamp lampRef={status.lamp} height={4.15} />
        {showLabels && <Label labelRef={status.label} track={track} height={4.6} />}
      </group>
      {trailer && (
        <group ref={trailerGroup} onClick={select} visible={false}>
          <primitive object={trailer.root} />
        </group>
      )}
    </>
  );
}

// --------------------------------------------------------------------------- material handling equipment

function MheAgent({ track, clock, origin, selected, showLabels, onSelect, poses, plain }: AgentProps) {
  const name = track.kind === "reach_truck" ? "reach_truck" : track.kind === "forklift" ? "forklift" : "pallet_truck";
  const rig = useRig(name);
  const full = useModel("pallet_full");
  const mixed = useModel("pallet_mixed");
  const loads = useMemo(() => {
    const first = makeRig(hash01(track.id) > 0.5 ? mixed : full);
    const second = makeRig(full);
    second.root.position.y = 1.17;
    first.root.add(second.root);
    return { first, second };
  }, [full, mixed, track.id]);
  const group = useRef<THREE.Group>(null);
  const spot = useRef<THREE.Mesh>(null);
  const status = useStatus(track, selected, plain);

  const socket = rig.node("load_socket");
  useLayoutEffect(() => {
    socket?.add(loads.first.root);
    rig.materials("livery").forEach((material) => material.color.set(track.color));
    pickOptions(rig, track.id);
    return () => {
      socket?.remove(loads.first.root);
    };
  }, [socket, loads, rig, track.color]);

  const carriage = rig.node("carriage");
  const inner = rig.node("mast_inner");
  const reach = rig.node("reach");
  const tilt = rig.node("tilt");
  const forks = rig.node("forks");
  const beacons = useMemo(() => rig.materials("beacon"), [rig]);
  const tints = useMemo(() => [...loads.first.materials("tint"), ...loads.second.materials("tint")], [loads]);
  const lastTint = useRef(-1);

  useFrame((state) => {
    const t = clock.current;
    const pose = samplePose(track, t);
    if (!group.current) return;
    if (!pose) {
      group.current.visible = false;
      poses.delete(track.id);
      status.hide();
      return;
    }
    group.current.visible = true;
    const forward = track.kind === "reach_truck" ? 0 : pose.reach * 0.45;
    const wx = pose.x + Math.cos(pose.angle) * forward - origin.x;
    const wz = pose.y + Math.sin(pose.angle) * forward - origin.y;
    group.current.position.set(wx, FLOOR, wz);
    group.current.rotation.y = -pose.angle;
    trackPoses(poses, track.id, wx, FLOOR + 1.5, wz);
    spinWheels(rig, pose.odo);

    if (carriage) carriage.position.y = rig.base("carriage").y + (track.kind === "pallet_truck" ? 0 : pose.lift);
    if (inner) {
      const freeLift = track.kind === "reach_truck" ? 1.6 : 1.1;
      const maxStage = track.kind === "reach_truck" ? 3.3 : 2.3;
      inner.position.y = rig.base("mast_inner").y + Math.min(maxStage, Math.max(0, pose.lift - freeLift));
    }
    if (reach) reach.position.x = rig.base("reach").x + pose.reach * 0.78;
    if (tilt) tilt.rotation.z = THREE.MathUtils.lerp(tilt.rotation.z, pose.carrying && pose.moving ? 0.06 : 0, 0.15);
    if (forks) forks.position.y = rig.base("forks").y + (pose.carrying ? 0.1 : 0);
    loads.first.root.visible = pose.carrying >= 1;
    loads.second.root.visible = pose.carrying >= 2;

    const tintIndex = Math.floor(t / 7);
    if (tintIndex !== lastTint.current && !pose.carrying) {
      lastTint.current = tintIndex;
      const colours = ["#d4553f", "#2f7ea6", "#e1a730", "#4f9a6a", "#8a62c9"];
      tints.forEach((material) => material.color.set(colours[Math.floor(hash01(`${track.id}${tintIndex}`) * colours.length)]));
    }
    const pulse = pose.moving ? 1.6 + Math.sin(state.clock.elapsedTime * 11) * 1.4 : 0.25;
    beacons.forEach((material) => (material.emissiveIntensity = pulse));
    if (spot.current) {
      const material = spot.current.material as THREE.MeshBasicMaterial;
      material.opacity = THREE.MathUtils.lerp(material.opacity, pose.moving ? 0.55 : 0, 0.2);
      spot.current.position.x = pose.reverse ? -2.6 : 2.6;
    }
    status.update(t, pose, state.clock.elapsedTime);
  });

  return (
    <group
      ref={group}
      visible={false}
      onClick={(event) => {
        event.stopPropagation();
        if (event.delta > 6) return;
        onSelect(track.id);
      }}
    >
      <primitive object={rig.root} />
      <mesh ref={spot} rotation={[-Math.PI / 2, 0, 0]} position={[2.6, 0.03, 0]}>
        <circleGeometry args={[0.32, 24]} />
        <meshBasicMaterial color="#3a8dff" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
      <StatusRing ringRef={status.ring} radius={1.5} />
      <StatusLamp lampRef={status.lamp} height={track.kind === "reach_truck" ? 2.75 : track.kind === "forklift" ? 2.6 : 1.6} />
      {showLabels && <Label labelRef={status.label} track={track} height={track.kind === "reach_truck" ? 3.4 : 2.9} />}
    </group>
  );
}

export function Agents({ tracks, ...rest }: Omit<AgentProps, "track" | "selected"> & { tracks: Track[]; selectedId: string | null }) {
  const { selectedId, ...props } = rest;
  return (
    <>
      {tracks.map((track) =>
        track.kind === "truck" ? (
          <TruckAgent key={track.id} track={track} selected={selectedId === track.id} {...props} />
        ) : (
          <MheAgent key={track.id} track={track} selected={selectedId === track.id} {...props} />
        ),
      )}
    </>
  );
}

