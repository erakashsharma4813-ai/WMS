// Runtime side of the Blender asset pipeline (tools/blender/build_equipment.py).
// GLBs are loaded once, then cloned per vehicle. Geometry stays shared; only
// materials that are restyled per instance (livery, shell, tint, beacon,
// signal_*) are cloned. Pallets are flattened into instanced batches because a
// warehouse shows thousands of them.

import { useGLTF } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { hash01 } from "./geometry";

export const MODEL_NAMES = [
  "truck_20",
  "truck_32",
  "tractor",
  "trailer_40",
  "reach_truck",
  "forklift",
  "pallet_truck",
  "pallet_full",
  "pallet_mixed",
  "dock_station",
  "barrier",
  "gatehouse",
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

const url = (name: ModelName) => `${import.meta.env.BASE_URL}models/${name}.glb`;
export const preloadModels = () => MODEL_NAMES.forEach((name) => useGLTF.preload(url(name)));

const PER_INSTANCE = ["livery", "shell", "tint", "beacon", "signal_"];

function prepare(scene: THREE.Object3D) {
  if (scene.userData.prepared) return;
  scene.userData.prepared = true;
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.name.startsWith("wrap")) {
      material.transparent = true;
      material.opacity = 0.38;
      material.depthWrite = false;
    }
    if (material.name.startsWith("glass")) {
      material.transparent = true;
      material.opacity = 0.62;
      material.envMapIntensity = 1.6;
    }
  });
}

export function useModel(name: ModelName) {
  const gltf = useGLTF(url(name));
  prepare(gltf.scene);
  return gltf.scene;
}

export type Rig = {
  root: THREE.Object3D;
  node: (name: string) => THREE.Object3D | undefined;
  base: (name: string) => THREE.Vector3;
  wheels: Array<{ node: THREE.Object3D; radius: number }>;
  materials: (prefix: string) => THREE.MeshStandardMaterial[];
};

/** Clone a loaded model and index its animatable nodes. */
export function makeRig(source: THREE.Object3D): Rig {
  const root = source.clone(true);
  const cloned = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (PER_INSTANCE.some((prefix) => material.name.startsWith(prefix))) {
      if (!cloned.has(material)) cloned.set(material, material.clone());
      mesh.material = cloned.get(material)!;
    }
  });
  const bases = new Map<string, THREE.Vector3>();
  const nodes = new Map<string, THREE.Object3D>();
  root.traverse((object) => {
    if (object.name && !nodes.has(object.name)) {
      nodes.set(object.name, object);
      bases.set(object.name, object.position.clone());
    }
  });
  const wheels: Rig["wheels"] = [];
  nodes.forEach((object, name) => {
    if (!name.startsWith("wheel_") || (object as THREE.Mesh).isMesh) return;
    const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    wheels.push({ node: object, radius: Math.max(0.05, size.y / 2) });
  });
  return {
    root,
    node: (name) => nodes.get(name),
    base: (name) => bases.get(name) ?? new THREE.Vector3(),
    wheels,
    materials: (prefix) => [...cloned.values()].filter((material) => material.name.startsWith(prefix)),
  };
}

/**
 * Show or hide each optional part (empties named opt_*: roof deflector, sun
 * visor, LPG bottle, cold-store cabin...) from a stable per-unit seed, so a
 * fleet of one model is not a row of identical clones.
 */
export function pickOptions(rig: Rig, seed: string, share = 0.55) {
  rig.root.traverse((object) => {
    if (object.name.startsWith("opt_") && !(object as THREE.Mesh).isMesh) object.visible = hash01(`${seed}:${object.name}`) < share;
  });
}

export function useRig(name: ModelName) {
  const source = useModel(name);
  return useMemo(() => makeRig(source), [source]);
}

// --- instanced pallets -----------------------------------------------------

export type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; tinted: boolean };

function extractParts(scene: THREE.Object3D): Part[] {
  scene.updateMatrixWorld(true);
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    const material = mesh.material as THREE.Material;
    groups.set(material, [...(groups.get(material) ?? []), geometry]);
  });
  const parts: Part[] = [];
  groups.forEach((geometries, material) => {
    const merged = geometries.length > 1 ? mergeGeometries(geometries) ?? geometries[0] : geometries[0];
    const tinted = material.name.startsWith("tint");
    const finalMaterial = tinted ? material.clone() : material;
    if (tinted) (finalMaterial as THREE.MeshStandardMaterial).color.set("#ffffff");
    parts.push({ geometry: merged, material: finalMaterial, tinted });
  });
  return parts;
}

export function usePalletParts(name: "pallet_full" | "pallet_mixed") {
  const scene = useModel(name);
  return useMemo(() => extractParts(scene), [scene]);
}

/** A fixed-capacity instanced pallet group: write matrices, set a count, commit. */
export class PalletBatch {
  readonly group = new THREE.Group();
  private meshes: Array<{ mesh: THREE.InstancedMesh; tinted: boolean }>;
  private colour = new THREE.Color();

  constructor(parts: Part[], readonly capacity: number, shadows = true) {
    this.meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, capacity));
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { mesh, tinted: part.tinted };
    });
  }

  set(index: number, matrix: THREE.Matrix4, tint: string) {
    if (index >= this.capacity) return;
    this.meshes.forEach(({ mesh, tinted }) => {
      mesh.setMatrixAt(index, matrix);
      if (tinted) mesh.setColorAt(index, this.colour.set(tint));
    });
  }

  commit(count: number) {
    const visible = Math.min(this.capacity, Math.max(0, count));
    this.meshes.forEach(({ mesh }) => {
      mesh.count = visible;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }

  dispose() {
    this.meshes.forEach(({ mesh }) => mesh.dispose());
  }
}

const scratch = new THREE.Object3D();
export function palletMatrix(x: number, y: number, z: number, yaw = 0) {
  scratch.position.set(x, y, z);
  scratch.rotation.set(0, yaw, 0);
  scratch.updateMatrix();
  return scratch.matrix.clone();
}
