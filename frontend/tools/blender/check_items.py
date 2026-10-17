"""Check every built GLB against its item contract (tools/blender/items/<id>.json).

Ported from the starter kit's build_item.py budget check, adapted to this
repo's pipeline: items are built procedurally by build_equipment.py, then this
script re-imports each GLB exactly as the browser receives it and checks
  * triangles and materials against the item's budget,
  * every part, socket and optional kit node (opt_*) the runtime drives exists as a named node,
  * every per-instance material prefix exists (livery, shell, tint, ...).
It writes tools/blender/reports/<id>.report.json and, with --render, a review
picture in tools/blender/reviews/. Exits non-zero when any item fails.

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup \
        --python tools/blender/check_items.py -- [--render] [item_id ...]
"""

import glob
import json
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.dirname(os.path.dirname(HERE))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
RENDER = "--render" in ARGS
ONLY = {arg for arg in ARGS if not arg.startswith("--")}
REPORTS = os.path.join(HERE, "reports")
REVIEWS = os.path.join(HERE, "reviews")


def check(contract_path):
    contract = json.load(open(contract_path, encoding="utf-8"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # check the raw build (Blender cannot read meshopt); public/models holds the optimised copy
    raw = os.path.join(HERE, "out", f"{contract['id']}.glb")
    glb = raw if os.path.exists(raw) else os.path.join(FRONTEND, contract["glb"])
    problems = []
    if not os.path.exists(glb):
        return {"id": contract["id"], "budgetPass": False, "problems": [f"missing {contract['glb']}: run the build"]}
    bpy.ops.import_scene.gltf(filepath=glb)
    objects = list(bpy.context.scene.objects)
    meshes = [obj for obj in objects if obj.type == "MESH"]
    triangles = sum(len(polygon.vertices) - 2 for obj in meshes for polygon in obj.data.polygons)
    materials = sorted({slot.material.name for obj in meshes for slot in obj.material_slots if slot.material})
    names = {obj.name.split(".")[0] for obj in objects}
    budget = contract["budget"]
    if triangles > budget["maxTriangles"]:
        problems.append(f"triangles {triangles} > {budget['maxTriangles']}")
    if len(materials) > budget["maxMaterials"]:
        problems.append(f"materials {len(materials)} > {budget['maxMaterials']}")
    for part in contract["parts"] + contract["sockets"] + contract.get("options", []):
        if part not in names:
            problems.append(f"missing node '{part}'")
    for prefix in contract["perInstanceMaterials"]:
        if not any(material.startswith(prefix) for material in materials):
            problems.append(f"no material starting with '{prefix}'")
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    low = [min(point[i] for point in points) for i in range(3)] if points else [0, 0, 0]
    high = [max(point[i] for point in points) for i in range(3)] if points else [0, 0, 0]
    report = {
        "id": contract["id"],
        "version": contract["version"],
        "glb": contract["glb"],
        "glbBytes": os.path.getsize(glb),
        "triangles": triangles,
        "maxTriangles": budget["maxTriangles"],
        "materials": materials,
        "nodes": sorted(names),
        # three.js axes: x forward, y up, z = -Blender y
        "sizeMetres": {"x": round(high[0] - low[0], 2), "y": round(high[2] - low[2], 2), "z": round(high[1] - low[1], 2)},
        "budgetPass": not problems,
        "problems": problems,
    }
    if RENDER and points:
        render(contract["id"], low, high)
        report["render"] = f"reviews/{contract['id']}.png"
    return report


def render(item_id, low, high):
    scene = bpy.context.scene
    centre = Vector([(a + b) / 2 for a, b in zip(low, high)])
    radius = max(1.0, (Vector(high) - Vector(low)).length / 2)
    target = bpy.data.objects.new("target", None)
    scene.collection.objects.link(target)
    target.location = centre
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(camera)
    camera.location = centre + Vector((1.25, -1.6, 0.9)).normalized() * radius * 3.3
    track = camera.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = camera
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 720, 460
    os.makedirs(REVIEWS, exist_ok=True)
    scene.render.filepath = os.path.join(REVIEWS, f"{item_id}.png")
    bpy.ops.render.render(write_still=True)


def main():
    os.makedirs(REPORTS, exist_ok=True)
    failures = 0
    for path in sorted(glob.glob(os.path.join(HERE, "items", "*.json"))):
        item_id = os.path.splitext(os.path.basename(path))[0]
        if ONLY and item_id not in ONLY:
            continue
        report = check(path)
        json.dump(report, open(os.path.join(REPORTS, f"{item_id}.report.json"), "w", encoding="utf-8"), indent=2)
        status = "PASS" if report["budgetPass"] else "FAIL"
        failures += 0 if report["budgetPass"] else 1
        print(f"ITEM {status} {item_id:13s} tris {report.get('triangles', '-'):>6} / {report.get('maxTriangles', '-'):<6} mats {len(report.get('materials', [])):>2}  {'; '.join(report['problems'])}")
    print(f"CHECK_COMPLETE failures={failures}")
    if failures:
        sys.exit(1)


main()
