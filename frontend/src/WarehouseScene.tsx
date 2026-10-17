import { Environment, Html, Lightformer, OrbitControls, useProgress } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

import { Agents, type Origin } from "./scene/Agents";
import { Facility } from "./scene/Facility";
import { dipAt, directorPose, lowerThirdAt, showcaseSeconds, type Shot, type Stage } from "./scene/director";
import { VideoRecorder } from "./scene/recorder";
import { preloadModels } from "./scene/models";
import { PALETTES, PaletteContext, usePalette } from "./scene/palette";
import type { ActiveAlert } from "./scene/alerts";
import { FLOOR, buildSceneModel, type EquipmentSpec, type SceneModel } from "./scene/tracks";
import type { Layout, StressPoint, TraceEvent } from "./types";

preloadModels();

type Props = {
  layout: Layout;
  /** stop rendering while a full overlay covers the scene */
  paused?: boolean;
  trace: TraceEvent[];
  clock: MutableRefObject<number>;
  startHour: number;
  stressScore: number;
  focusRequest: { target: string; n: number };
  zoomRequest: { factor: number; n: number };
  alerts: ActiveAlert[];
  onAlertPick: (alert: ActiveAlert) => void;
  showEnvelope: boolean;
  showLabels: boolean;
  sourceMode: "recorded" | "simulated" | "draft";
  highlightTargets: string[];
  equipment: EquipmentSpec[];
  dockCount: number;
  selectedEntity: string | null;
  follow: boolean;
  onSelectLocation: (locationId: string) => void;
  onSelectEntity: (entityId: string | null) => void;
  onModel?: (model: SceneModel) => void;
  stressPoints?: StressPoint[];
  theme?: "industrial" | "light";
  /** a showcase owns the clock and the camera while it plays */
  showcase?: { shots: Shot[]; n: number; recorder?: VideoRecorder | null } | null;
  /** live showcase only: hold the film, or jump to a point in it (seconds) */
  showcasePaused?: boolean;
  showcaseSeek?: { to: number; n: number };
  /** the showcase frame's elements (bars, lower third, dip), driven every frame by the director */
  overlay?: MutableRefObject<ShowcaseOverlay | null>;
  onShowcase?: (state: { index: number; time: number; elapsed: number } | null) => void;
  /** export progress 0..1, then the finished video (or the error that stopped it) */
  onRecord?: (state: { progress: number } | { video: Blob } | { error: string }) => void;
  stressLevels?: Record<string, { level: "normal" | "amber" | "red"; since: number; value: number }>;
};

/** The numbered stress points, pinned over their zone and coloured by the live meter. */
function StressPins({ points, levels, locations, onSelect }: { points: StressPoint[]; levels: NonNullable<Props["stressLevels"]>; locations: Map<string, THREE.Vector3>; onSelect: (id: string) => void }) {
  const placed = new Map<string, number>();
  return (
    <>
      {points.map((point) => {
        const at = locations.get(point.location);
        if (!at) return null;
        const stack = placed.get(point.location) ?? 0;
        placed.set(point.location, stack + 1);
        const level = levels[point.id]?.level ?? "normal";
        return (
          <Html key={point.id} position={[at.x + stack * 4.5, at.y + 6.5, at.z]} center zIndexRange={[7, 0]}>
            <button className={`stress-pin ${level}`} title={`${point.number}. ${point.label}: ${level}`} onClick={() => onSelect(point.location)}>
              <b>{point.number}</b>
              <span>{point.label}</span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

const OUTDOOR = new Set(["GATE", "HOLDING-YARD", "DOCK-APRON"]);
// Overview looks from the truck yard towards the building so arrivals, docks
// and the interior share the frame.
const OVERVIEW_TARGET = new THREE.Vector3(6, 0.5, 27);
const OVERVIEW_OFFSET = new THREE.Vector3(50, 82, 78);

/** Sun path for the site day, plus interior floodlighting that keeps night shifts readable. */
function DayCycle({ clock, startHour }: { clock: MutableRefObject<number>; startHour: number }) {
  const palette = usePalette();
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const { scene } = useThree();
  const day = useMemo(() => ({ sky: new THREE.Color(palette.sky), dusk: new THREE.Color(palette.dusk), night: new THREE.Color(palette.night), sunDay: new THREE.Color("#fff6e8"), sunDusk: new THREE.Color("#ffb878"), moon: new THREE.Color("#b9cdf2") }), [palette]);
  const background = useMemo(() => new THREE.Color(), []);
  const lightColour = useMemo(() => new THREE.Color(), []);
  useFrame(() => {
    const hour = (startHour + clock.current / 60) % 24;
    const progress = (hour - 6.2) / 12.1;
    const elevation = Math.sin(Math.PI * progress);
    const daylight = Math.max(0, elevation);
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 3.5);
    const isDay = elevation > 0;
    background.copy(isDay ? day.sky : day.night).lerp(day.dusk, dusk * 0.7);
    if (!isDay) background.lerp(day.night, Math.min(1, -elevation * 3));
    scene.background = background;
    if (scene.fog) (scene.fog as THREE.Fog).color.copy(background);
    if (sun.current) {
      const azimuth = Math.PI * Math.min(1, Math.max(0, progress));
      sun.current.position.set(Math.cos(azimuth) * 90, isDay ? 25 + daylight * 75 : 85, isDay ? -55 : 25);
      sun.current.intensity = isDay ? 0.9 + daylight * 2.1 : 1.15;
      sun.current.color.copy(isDay ? lightColour.copy(day.sunDusk).lerp(day.sunDay, Math.min(1, daylight * 2.2)) : day.moon);
    }
    if (hemi.current) hemi.current.intensity = isDay ? 1.25 + daylight * 1.1 : 1.05;
  });
  return (
    <>
      <hemisphereLight ref={hemi} intensity={2} color="#ffffff" groundColor={palette.hemiGround} />
      <directionalLight
        ref={sun}
        position={[-40, 80, -50]}
        intensity={2.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.04}
        shadow-camera-left={-105}
        shadow-camera-right={105}
        shadow-camera-top={85}
        shadow-camera-bottom={-85}
        shadow-camera-near={10}
        shadow-camera-far={320}
      />
    </>
  );
}

const FOCUS_DISTANCE: Record<string, number> = { OVERVIEW: 1, GATE: 0.36, "HOLDING-YARD": 0.4, "DOCK-APRON": 0.45, MARSHALLING: 0.42 };
const focusDistance = (target: string) => FOCUS_DISTANCE[target] ?? (target.startsWith("ML-") || /^D\d+$/.test(target) ? 0.26 : target.startsWith("RACK") ? 0.38 : 0.4);

/**
 * Animates the camera only while a request (focus, zoom, follow) is in
 * progress, then hands control back to OrbitControls so manual orbit/zoom is
 * never pulled back.
 */
function CameraRig({ focusRequest, zoomRequest, locations, controls, follow, selected, poses, idle }: {
  idle: boolean;
  focusRequest: Props["focusRequest"];
  zoomRequest: Props["zoomRequest"];
  locations: Map<string, THREE.Vector3>;
  controls: MutableRefObject<any>;
  follow: boolean;
  selected: string | null;
  poses: Map<string, THREE.Vector3>;
}) {
  const { camera } = useThree();
  const desiredPosition = useRef(OVERVIEW_TARGET.clone().add(OVERVIEW_OFFSET));
  const desiredTarget = useRef(OVERVIEW_TARGET.clone());
  const animating = useRef(true);
  const handled = useRef({ focus: -1, zoom: zoomRequest.n });
  const following = useRef(false);

  useEffect(() => {
    const instance = controls.current;
    if (!instance) return;
    const release = () => {
      animating.current = false;
    };
    instance.addEventListener("start", release);
    return () => instance.removeEventListener("start", release);
  }, [controls]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    if (!orbit) return;
    if (idle) {
      animating.current = false;
      following.current = false;
      return;
    }
    const factor = Math.min(1, delta * 3.4);
    const target = orbit.target as THREE.Vector3;

    if (handled.current.focus !== focusRequest.n) {
      handled.current.focus = focusRequest.n;
      const location = focusRequest.target === "OVERVIEW" ? OVERVIEW_TARGET : locations.get(focusRequest.target);
      if (location) {
        const distance = focusDistance(focusRequest.target);
        desiredTarget.current.copy(location);
        desiredPosition.current.copy(location).addScaledVector(OVERVIEW_OFFSET, distance);
        animating.current = true;
        following.current = false;
      }
    }
    if (handled.current.zoom !== zoomRequest.n) {
      handled.current.zoom = zoomRequest.n;
      const base = animating.current ? desiredPosition.current : camera.position;
      const pivot = animating.current ? desiredTarget.current : target;
      const offset = base.clone().sub(pivot);
      const length = THREE.MathUtils.clamp(offset.length() * zoomRequest.factor, 8, 220);
      desiredTarget.current.copy(pivot);
      desiredPosition.current.copy(pivot).add(offset.setLength(length));
      animating.current = true;
    }

    const tracked = follow && selected ? poses.get(selected) : undefined;
    if (tracked) {
      if (!following.current) {
        following.current = true;
        desiredTarget.current.copy(tracked);
        desiredPosition.current.copy(tracked).add(new THREE.Vector3(26, 24, 30));
        animating.current = true;
      }
      const before = target.clone();
      target.lerp(tracked, factor);
      camera.position.add(target.clone().sub(before));
      desiredTarget.current.copy(tracked);
      if (animating.current) {
        desiredPosition.current.copy(tracked).add(desiredPosition.current.clone().sub(before).setLength(desiredPosition.current.distanceTo(before)));
        camera.position.lerp(desiredPosition.current, factor);
        if (camera.position.distanceTo(desiredPosition.current) < 0.2) animating.current = false;
      }
      orbit.update();
      return;
    }
    following.current = false;

    if (animating.current) {
      camera.position.lerp(desiredPosition.current, factor);
      target.lerp(desiredTarget.current, factor);
      if (camera.position.distanceTo(desiredPosition.current) < 0.15 && target.distanceTo(desiredTarget.current) < 0.15) animating.current = false;
      orbit.update();
    }
  });
  return null;
}

/**
 * Plays a showcase: advances the clock through each shot's slice of simulated
 * time and places the camera from the director. It runs before the agents in
 * the frame, so vehicles and camera are always sampled at the same instant.
 */
export type ShowcaseOverlay = { title: HTMLElement; fact: HTMLElement; third: HTMLElement; dip: HTMLElement };

/** Updates the live showcase frame: the lower third (fades and rises in when its title changes) and the dip to black. */
function paintOverlay(overlay: ShowcaseOverlay | null | undefined, shots: Shot[], elapsed: number) {
  if (!overlay) return;
  const third = lowerThirdAt(shots, elapsed);
  if ((third?.title ?? "") !== overlay.title.textContent) {
    overlay.title.textContent = third?.title ?? "";
    overlay.fact.textContent = third?.fact ?? "";
  }
  const k = third ? Math.min(1, third.age / 0.45) : 0;
  overlay.third.style.opacity = String(k);
  overlay.third.style.transform = `translateY(${(1 - k) * 10}px)`;
  overlay.dip.style.opacity = String(dipAt(shots, elapsed));
}

function CinemaRig({ showcase, stage, controls, clock, onShowcase, frameIndex, overlay, paused, seek }: {
  overlay?: Props["overlay"];
  paused?: boolean;
  seek?: Props["showcaseSeek"];
  showcase: NonNullable<Props["showcase"]>;
  /** while exporting, the frame being rendered; time then advances exactly one frame per frame */
  frameIndex: MutableRefObject<number>;
  stage: Stage;
  controls: MutableRefObject<any>;
  clock: MutableRefObject<number>;
  onShowcase?: Props["onShowcase"];
}) {
  const { camera } = useThree();
  const elapsed = useRef(0);
  const shown = useRef(-1);
  const look = useRef(new THREE.Vector3());
  const lastPublish = useRef(0);
  const report = useRef(onShowcase);
  report.current = onShowcase;

  useEffect(() => {
    elapsed.current = 0;
    shown.current = -1;
  }, [showcase.n]);

  // a jump lands on the new point with a cut, not a blend across the film
  const handledSeek = useRef(seek?.n ?? 0);
  useEffect(() => {
    if (!seek || seek.n === handledSeek.current) return;
    handledSeek.current = seek.n;
    elapsed.current = Math.max(0, seek.to);
    shown.current = -1;
  }, [seek]);

  useFrame((_, realDelta) => {
    const recorder = showcase.recorder;
    const delta = recorder ? 1 / recorder.spec.fps : Math.min(realDelta, 0.1);
    if (recorder) {
      // the exporter may hold a frame back while the encoder catches up
      const next = frameIndex.current / recorder.spec.fps;
      if (next === elapsed.current && shown.current >= 0) return;
      elapsed.current = next;
    } else if (!paused) elapsed.current += delta;
    const frame = directorPose(stage, showcase.shots, elapsed.current);
    const lens = camera as THREE.PerspectiveCamera;
    if (!frame) {
      if (!recorder) report.current?.(null);
      return;
    }
    clock.current = frame.time;
    paintOverlay(overlay?.current, showcase.shots, elapsed.current);
    const cut = frame.index !== shown.current && (shown.current < 0 || frame.shot.cut);
    // light damping on top of the director takes the edge off vehicle jitter; cuts snap
    const k = cut ? 1 : 1 - Math.exp(-delta * 9);
    camera.position.lerp(frame.pose.position, k);
    look.current.lerp(frame.pose.look, k);
    if (cut) look.current.copy(frame.pose.look);
    camera.lookAt(look.current);
    if (Math.abs(lens.fov - frame.pose.fov) > 0.01) {
      lens.fov = THREE.MathUtils.lerp(lens.fov, frame.pose.fov, k);
      lens.updateProjectionMatrix();
    }
    // keep the orbit pivot on the subject so manual control resumes from here
    controls.current?.target.copy(look.current);
    if (frame.index !== shown.current || elapsed.current - lastPublish.current > 0.1) {
      shown.current = frame.index;
      lastPublish.current = elapsed.current;
      report.current?.({ index: frame.index, time: frame.time, elapsed: elapsed.current });
    }
  }, -1);
  useEffect(() => () => {
    const lens = camera as THREE.PerspectiveCamera;
    lens.fov = 40;
    lens.updateProjectionMatrix();
  }, [camera]);
  return null;
}

/**
 * Exports the showcase: takes over rendering (positive priority), renders each
 * frame once the camera and vehicles are placed, and hands it to the encoder.
 * The canvas is drawn at the export size for the duration and restored after.
 */
function RecorderRig({ showcase, recorder, frameIndex, onRecord }: {
  showcase: NonNullable<Props["showcase"]>;
  recorder: VideoRecorder;
  frameIndex: MutableRefObject<number>;
  onRecord?: Props["onRecord"];
}) {
  const { gl, camera, size, viewport } = useThree();
  const total = useMemo(() => Math.ceil(showcaseSeconds(showcase.shots) * recorder.spec.fps), [showcase, recorder]);
  const done = useRef(false);
  const report = useRef(onRecord);
  report.current = onRecord;

  useEffect(() => {
    const lens = camera as THREE.PerspectiveCamera;
    frameIndex.current = 0;
    gl.setPixelRatio(1);
    gl.setSize(recorder.spec.width, recorder.spec.height, false);
    lens.aspect = recorder.spec.width / recorder.spec.height;
    lens.updateProjectionMatrix();
    return () => {
      gl.setPixelRatio(viewport.dpr);
      gl.setSize(size.width, size.height, false);
      lens.aspect = size.width / size.height;
      lens.updateProjectionMatrix();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  useFrame(({ scene }) => {
    gl.render(scene, camera);
    if (done.current) return;
    if (frameIndex.current >= total) {
      done.current = true;
      recorder.finish().then((video) => report.current?.({ video }), (error: Error) => report.current?.({ error: error.message }));
      return;
    }
    if (!recorder.ready) return;
    const seconds = frameIndex.current / recorder.spec.fps;
    try {
      recorder.addFrame(gl.domElement, lowerThirdAt(showcase.shots, seconds), dipAt(showcase.shots, seconds));
    } catch (error) {
      done.current = true;
      report.current?.({ error: (error as Error).message });
      return;
    }
    frameIndex.current += 1;
    if (frameIndex.current % 15 === 0) report.current?.({ progress: frameIndex.current / total });
  }, 1);
  return null;
}

const SEVERITY_ORDER = { critical: 0, warning: 1 } as const;

/** Floating delay popups, pinned above the vehicle or the area that has the issue. */
function AlertCallouts({ alerts, poses, locations, onPick }: { alerts: ActiveAlert[]; poses: Map<string, THREE.Vector3>; locations: Map<string, THREE.Vector3>; onPick: (alert: ActiveAlert) => void }) {
  const visible = useMemo(
    () => alerts.filter((alert) => alert.open).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.minutes - a.minutes).slice(0, 7),
    [alerts],
  );
  return (
    <>
      {visible.map((alert, index) => (
        <Callout key={alert.id} alert={alert} lift={(index % 3) * 2.6} poses={poses} locations={locations} onPick={onPick} />
      ))}
    </>
  );
}

function Callout({ alert, lift, poses, locations, onPick }: { alert: ActiveAlert; lift: number; poses: Map<string, THREE.Vector3>; locations: Map<string, THREE.Vector3>; onPick: (alert: ActiveAlert) => void }) {
  const group = useRef<THREE.Group>(null);
  const holder = useRef<HTMLDivElement>(null);
  useFrame(() => {
    if (!group.current) return;
    const pose = alert.entityId ? poses.get(alert.entityId) : undefined;
    const place = pose ?? (alert.locationId ? locations.get(alert.locationId) : undefined);
    if (holder.current) holder.current.style.display = place ? "" : "none";
    // staggered heights keep neighbouring popups from covering each other
    if (place) group.current.position.set(place.x, place.y + (pose ? 4.2 : 3.2) + lift, place.z);
  });
  return (
    <group ref={group}>
      <Html center zIndexRange={[9, 0]}>
        <div ref={holder} className={`alert-pop ${alert.severity}`} onClick={() => onPick(alert)} role="button" tabIndex={0}>
          <b>{alert.severity === "critical" ? "!" : "⏱"}</b>
          <span>
            <strong>{alert.title}</strong>
            <small>{alert.detail}</small>
          </span>
        </div>
      </Html>
    </group>
  );
}

function Loader() {
  const { progress } = useProgress();
  return (
    <Html center>
      <div className="scene-loader">
        <b>Loading equipment library</b>
        <span><i style={{ width: `${Math.round(progress)}%` }} /></span>
        <small>{Math.round(progress)}% · Blender glTF assets</small>
      </div>
    </Html>
  );
}

function Warehouse(props: Props) {
  const palette = PALETTES[props.theme ?? "industrial"];
  const { layout, trace, clock, equipment, dockCount, onModel } = props;
  const controls = useRef<any>(null);
  const poses = useMemo(() => new Map<string, THREE.Vector3>(), []);
  const origin: Origin = useMemo(() => ({ x: layout.plot.width_m / 2, y: layout.plot.height_m / 2 }), [layout]);
  const model = useMemo(() => buildSceneModel(layout, trace, equipment, dockCount), [layout, trace, equipment, dockCount]);
  useEffect(() => onModel?.(model), [model, onModel]);

  const locations = useMemo(() => {
    const map = new Map<string, THREE.Vector3>();
    const add = (id: string, x: number, y: number, outdoor: boolean) => map.set(id, new THREE.Vector3(x - origin.x, outdoor ? 0.5 : FLOOR + 0.5, y - origin.y));
    layout.zones.forEach((zone) => add(zone.zone_id, zone.x + zone.width / 2, zone.y + zone.height / 2, OUTDOOR.has(zone.zone_id)));
    layout.rack_blocks.forEach((rack) => add(rack.rack_id, rack.x + rack.width / 2, rack.y + rack.height / 2, false));
    model.docks.forEach((dock) => add(dock.id, dock.cx, 70, true));
    layout.marshalling_lanes.forEach((lane) => add(lane.lane_id, lane.x + lane.width / 2, lane.y + lane.height / 2, false));
    return map;
  }, [layout, model.docks, origin]);
  const stage: Stage = useMemo(() => ({ tracks: new Map(model.tracks.map((track) => [track.id, track])), locations, origin, site: OVERVIEW_TARGET }), [model.tracks, locations, origin]);
  const cinema = Boolean(props.showcase);
  const frameIndex = useRef(0);

  const heat = props.stressScore >= 75 ? "#e86363" : props.stressScore >= 50 ? "#e8a33c" : "#38a995";
  return (
    <PaletteContext.Provider value={palette}>
      <color attach="background" args={[palette.sky]} />
      <fog attach="fog" args={[palette.sky, palette.fogNear, palette.fogFar]} />
      <DayCycle clock={clock} startHour={props.startHour} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
        <Lightformer form="rect" intensity={1.2} position={[-12, 3, -8]} rotation-y={Math.PI / 2} scale={[16, 4, 1]} color="#dff3ef" />
        <Lightformer form="rect" intensity={0.9} position={[12, 2, 8]} rotation-y={-Math.PI / 2} scale={[16, 3, 1]} color="#fff1dc" />
      </Environment>
      <group>
        <Facility layout={layout} model={model} origin={origin} clock={clock} showEnvelope={props.showEnvelope} sourceMode={props.sourceMode} highlight={props.highlightTargets} heat={heat} onSelectLocation={props.onSelectLocation} />
        <Agents tracks={model.tracks} clock={clock} origin={origin} selectedId={props.selectedEntity} showLabels={props.showLabels} onSelect={(id) => props.onSelectEntity(id)} poses={poses} plain={cinema} />
      </group>
      {!cinema && <AlertCallouts alerts={props.alerts} poses={poses} locations={locations} onPick={props.onAlertPick} />}
      {!cinema && props.stressPoints && props.stressPoints.length > 0 && <StressPins points={props.stressPoints} levels={props.stressLevels ?? {}} locations={locations} onSelect={props.onSelectLocation} />}
      {props.showcase && <CinemaRig showcase={props.showcase} stage={stage} controls={controls} clock={clock} onShowcase={props.onShowcase} frameIndex={frameIndex} overlay={props.overlay} paused={props.showcasePaused} seek={props.showcaseSeek} />}
      {props.showcase?.recorder && <RecorderRig key={props.showcase.n} showcase={props.showcase} recorder={props.showcase.recorder} frameIndex={frameIndex} onRecord={props.onRecord} />}
      <CameraRig idle={cinema} focusRequest={props.focusRequest} zoomRequest={props.zoomRequest} locations={locations} controls={controls} follow={props.follow} selected={props.selectedEntity} poses={poses} />
      {/* map-style controls: drag pans across the ground, right-drag rotates, wheel zooms */}
      <OrbitControls ref={controls} makeDefault enabled={!cinema} target={[6, 0.5, 27]} minDistance={8} maxDistance={220} minPolarAngle={0.2} maxPolarAngle={Math.PI / 2.1} enableDamping dampingFactor={0.08} screenSpacePanning={false} mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }} touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }} />
    </PaletteContext.Provider>
  );
}

export function WarehouseScene(props: Props) {
  // a drag that pans the map must not deselect the vehicle being followed
  const down = useRef({ x: 0, y: 0 });
  const overlay = useRef<ShowcaseOverlay | null>(null);
  const els = useRef<Partial<ShowcaseOverlay>>({});
  const bind = (key: keyof ShowcaseOverlay) => (element: HTMLElement | null) => {
    if (element) els.current[key] = element;
    overlay.current = els.current.title && els.current.fact && els.current.third && els.current.dip ? (els.current as ShowcaseOverlay) : null;
  };
  const missed = (event: MouseEvent) => {
    if (Math.hypot(event.clientX - down.current.x, event.clientY - down.current.y) < 6) props.onSelectEntity(null);
  };
  return (
    <>
    <Canvas frameloop={props.paused ? "never" : "always"} shadows="soft" camera={{ position: [56, 82.5, 105], fov: 40, near: 0.3, far: 600 }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: "high-performance" }} onPointerDown={(event) => { down.current = { x: event.clientX, y: event.clientY }; }} onPointerMissed={missed}>
      <Suspense fallback={<Loader />}>
        <Warehouse {...props} overlay={overlay} />
      </Suspense>
    </Canvas>
    {props.showcase && (
      <div className="showcase-frame" aria-hidden>
        <div className="showcase-bar top"><span className="showcase-brand"><i>DT</i>DISPATCH TWIN</span><small>Esc to stop</small></div>
        <div className="showcase-bar bottom" />
        <div ref={bind("third")} className="showcase-third"><b ref={bind("title")} /><span ref={bind("fact")} /></div>
        <div ref={bind("dip")} className="showcase-dip" />
      </div>
    )}
    </>
  );
}
