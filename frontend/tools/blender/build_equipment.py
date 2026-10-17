"""Builds the Dispatch Twin equipment library as glTF binaries.

Run headless from the frontend folder:

    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --factory-startup \
        --python tools/blender/build_equipment.py -- tools/blender/out [preview_dir]

or simply: npm run models   (build, check against the item contracts, optimise into public/models)

Conventions shared with the three.js runtime (src/scene/models.tsx):
  * Units are metres. Blender +X is the vehicle's forward direction, +Z is up.
    The glTF exporter converts to Y-up, so three.js sees forward = +X, up = +Y.
  * Origins sit on the ground under the reference point the runtime animates
    (vehicle centre, trailer kingpin, dock door centre, barrier post).
  * Moving parts are empties with stable names (wheel_*, mast_inner, carriage,
    reach, door, arm, ...). The runtime only moves those nodes.
  * Empties named opt_* hold optional kit (roof deflector, sun visor, LPG
    bottle, cold-store cabin...). The runtime shows or hides each one per unit,
    so a fleet does not look like a row of clones.
  * Materials whose name starts with "livery", "shell", "tint", "glass",
    "beacon" or "signal_" are cloned or restyled per instance at runtime.

Sizes come from datasheets (see tools/blender/items/<id>.json "reference"):
Tata Signa / Ashok Leyland cab-over rigids, a 6x4 tractor with 40 ft box
trailer, Toyota 8-series 1.5-2.5 t counterbalance, Linde R14-class reach truck,
Linde T20 SP-class rider pallet truck, Hormann-style dock leveller and shelter.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_DIR = os.path.abspath(ARGS[0] if ARGS else "tools/blender/out")
PREVIEW_DIR = os.path.abspath(ARGS[1]) if len(ARGS) > 1 else None

PALETTE = {
    "livery": ((0.12, 0.43, 0.55), 0.35, 0.38),
    "shell": ((0.93, 0.94, 0.93), 0.05, 0.55),
    "chassis": ((0.10, 0.11, 0.12), 0.45, 0.55),
    "tyre": ((0.05, 0.05, 0.055), 0.0, 0.92),
    "rim": ((0.70, 0.72, 0.74), 0.85, 0.3),
    "glass": ((0.16, 0.24, 0.28), 0.2, 0.08),
    "chrome": ((0.85, 0.86, 0.88), 1.0, 0.16),
    "lamp_white": ((1.0, 0.97, 0.88), 0.0, 0.2),
    "lamp_red": ((0.85, 0.06, 0.04), 0.0, 0.3),
    "lamp_amber": ((1.0, 0.55, 0.05), 0.0, 0.3),
    "amber_body": ((0.94, 0.62, 0.12), 0.15, 0.42),
    "blue_body": ((0.16, 0.39, 0.58), 0.2, 0.4),
    "teal_body": ((0.13, 0.58, 0.55), 0.2, 0.4),
    "graphite": ((0.17, 0.19, 0.21), 0.3, 0.5),
    "steel": ((0.45, 0.48, 0.5), 0.8, 0.35),
    "mast": ((0.23, 0.25, 0.27), 0.6, 0.4),
    "fork": ((0.12, 0.12, 0.13), 0.7, 0.45),
    "seat": ((0.08, 0.08, 0.09), 0.0, 0.8),
    "wood": ((0.64, 0.45, 0.27), 0.0, 0.85),
    "kraft": ((0.73, 0.56, 0.37), 0.0, 0.78),
    "wrap": ((0.86, 0.9, 0.92), 0.0, 0.18),
    "label": ((0.96, 0.96, 0.94), 0.0, 0.6),
    "tint": ((0.83, 0.33, 0.25), 0.0, 0.55),
    "foam": ((0.11, 0.12, 0.13), 0.0, 0.9),
    "rubber": ((0.04, 0.04, 0.04), 0.0, 0.9),
    "door": ((0.78, 0.82, 0.84), 0.55, 0.35),
    "hazard_yellow": ((0.98, 0.78, 0.08), 0.0, 0.45),
    "hazard_black": ((0.06, 0.06, 0.06), 0.0, 0.6),
    "concrete": ((0.72, 0.73, 0.72), 0.0, 0.9),
    "wall_panel": ((0.86, 0.9, 0.89), 0.3, 0.5),
    "red_white_r": ((0.82, 0.12, 0.1), 0.0, 0.45),
    "red_white_w": ((0.96, 0.96, 0.96), 0.0, 0.45),
    "beacon": ((1.0, 0.6, 0.05), 0.0, 0.25),
    "signal_red": ((0.9, 0.08, 0.06), 0.0, 0.25),
    "signal_green": ((0.1, 0.85, 0.35), 0.0, 0.25),
    "canopy": ((0.07, 0.42, 0.40), 0.4, 0.45),
    "hivis": ((1.0, 0.42, 0.06), 0.0, 0.6),
    "reflect": ((0.86, 0.88, 0.9), 0.3, 0.25),
    "navy": ((0.12, 0.16, 0.26), 0.0, 0.8),
    "skin": ((0.78, 0.56, 0.42), 0.0, 0.7),
    "tint_hat": ((0.98, 0.82, 0.12), 0.0, 0.4),
}
EMISSIVE = {"lamp_white": 2.0, "lamp_red": 1.5, "lamp_amber": 1.5, "beacon": 3.0, "signal_red": 2.5, "signal_green": 2.5}

# Edges sharper than this render flat; softer ones (cylinder sides) render smooth.
SHARP_ANGLE = math.radians(38)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name):
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    color, metallic, roughness = PALETTE[name]
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.diffuse_color = (*color, 1.0)
    mat.metallic = metallic
    mat.roughness = roughness
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Metallic"].default_value = metallic
        bsdf.inputs["Roughness"].default_value = roughness
        if name in EMISSIVE:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            bsdf.inputs["Emission Strength"].default_value = EMISSIVE[name]
    return mat


# Near-identical materials merge per model so each item stays inside its
# material budget (one draw call per material). Runtime-styled materials
# (livery, shell, tint, wrap, glass, beacon, signal_*) are never aliased.
MHE_ALIASES = {
    "rim": "steel", "chrome": "steel", "mast": "graphite", "fork": "graphite", "seat": "graphite",
    "hazard_black": "graphite", "foam": "graphite", "rubber": "tyre", "chassis": "graphite",
}
TRUCK_ALIASES = {
    "rim": "chrome", "steel": "chrome", "graphite": "chassis", "hazard_black": "chassis",
    "foam": "chassis", "rubber": "tyre", "seat": "chassis",
}
DOCK_ALIASES = {"rubber": "foam", "hazard_black": "foam", "graphite": "foam", "chrome": "steel"}


def arc(cx, cz, radius, a0, a1, n):
    """Points on a circular arc in a 2D profile, angles in degrees, both ends included."""
    return [(cx + radius * math.cos(math.radians(a0 + (a1 - a0) * k / n)), cz + radius * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]


def rounded_rect(x0, x1, y0, y1, radii, n=3):
    """Counter-clockwise outline with corner radii (x1y1, x0y1, x0y0, x1y0)."""
    r_a, r_b, r_c, r_d = radii if isinstance(radii, (tuple, list)) else (radii,) * 4
    points = []
    for (cx, cy, r, a0) in ((x1 - r_a, y1 - r_a, r_a, 0), (x0 + r_b, y1 - r_b, r_b, 90), (x0 + r_c, y0 + r_c, r_c, 180), (x1 - r_d, y0 + r_d, r_d, 270)):
        points += [(cx, cy)] if r <= 0 else arc(cx, cy, r, a0, a0 + 90, n)
    return points


class Model:
    def __init__(self, name, aliases=None, bevel_segments=2):
        reset()
        self.name = name
        self.aliases = aliases or {}
        self.bevel_segments = bevel_segments
        self.nodes = {}
        self.buckets = {}
        root = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(root)
        self.nodes["root"] = (root, Vector((0, 0, 0)))

    def node(self, name, parent="root", at=(0, 0, 0)):
        parent_obj, parent_pos = self.nodes[parent]
        empty = bpy.data.objects.new(name, None)
        empty.empty_display_size = 0.2
        bpy.context.scene.collection.objects.link(empty)
        empty.parent = parent_obj
        world = Vector(at)
        empty.location = world - parent_pos
        self.nodes[name] = (empty, world)
        return name

    def _bucket(self, node, mat, bevel, segs=None):
        mat = self.aliases.get(mat, mat)
        key = (node, mat, round(bevel, 4), segs or self.bevel_segments)
        if key not in self.buckets:
            self.buckets[key] = bmesh.new()
        return self.buckets[key]

    def _local(self, node, matrix):
        return Matrix.Translation(-self.nodes[node][1]) @ matrix

    def box(self, node, mat, size, centre, bevel=0.015, rotation=None, segs=None):
        bm = self._bucket(node, mat, bevel, segs)
        m = Matrix.Translation(Vector(centre))
        if rotation:
            m = m @ rotation
        m = m @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=self._local(node, m))

    def cylinder(self, node, mat, radius, depth, centre, axis="Y", segments=24, radius2=None, bevel=0.0, segs=None):
        bm = self._bucket(node, mat, bevel, segs)
        rotation = {"X": Matrix.Rotation(math.pi / 2, 4, "Y"), "Y": Matrix.Rotation(math.pi / 2, 4, "X"), "Z": Matrix.Identity(4)}[axis]
        m = Matrix.Translation(Vector(centre)) @ rotation
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius if radius2 is None else radius2, depth=depth, matrix=self._local(node, m))

    def rod(self, node, mat, p0, p1, radius, segments=10, radius2=None, bevel=0.0, segs=None):
        """Cylinder (or cone, radius at p0 to radius2 at p1) between two points."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        up = "X" if abs(d.normalized().x) < 0.9 else "Y"
        rotation = d.to_track_quat("Z", up).to_matrix().to_4x4()
        bm = self._bucket(node, mat, bevel, segs)
        m = Matrix.Translation((p0 + p1) / 2) @ rotation
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius if radius2 is None else radius2, depth=d.length, matrix=self._local(node, m))

    def beam(self, node, mat, p0, p1, thick, bevel=0.0, segs=None):
        """Square bar between two points (inclined posts, struts)."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        up = "Z" if abs(d.normalized().z) < 0.9 else "Y"
        rotation = d.to_track_quat("X", up).to_matrix().to_4x4()
        size = thick if isinstance(thick, (tuple, list)) else (thick, thick)
        self.box(node, mat, (d.length, size[0], size[1]), (p0 + p1) / 2, bevel, rotation=rotation, segs=segs)

    def prism(self, node, mat, profile, depth, at=0.0, axis="Y", bevel=0.0, segs=None):
        """Extrude a 2D outline: axis Y takes (x, z) centred on y = at (side profiles),
        axis Z takes (x, y) from z = at upwards (plan shapes), axis X takes (y, z) centred on x = at."""
        bm = self._bucket(node, mat, bevel, segs)
        offset = self.nodes[node][1]

        def point(u, v, w):
            if axis == "Y":
                return Vector((u, w, v)) - offset
            if axis == "Z":
                return Vector((u, v, w)) - offset
            return Vector((w, u, v)) - offset

        w0, w1 = (at, at + depth) if axis == "Z" else (at - depth / 2, at + depth / 2)
        a = [bm.verts.new(point(u, v, w0)) for u, v in profile]
        b = [bm.verts.new(point(u, v, w1)) for u, v in profile]
        faces = [bm.faces.new(a), bm.faces.new(list(reversed(b)))]
        for i in range(len(profile)):
            j = (i + 1) % len(profile)
            faces.append(bm.faces.new((a[i], a[j], b[j], b[i])))
        bmesh.ops.recalc_face_normals(bm, faces=faces)

    def wheel(self, name, parent, centre, radius, width, rim="rim", dual=False, hub="graphite", tread_bevel=None):
        """Tyre with rim, hub and hand holes (the holes make rotation readable).
        dual=True draws twin tyres (truck drive and trailer axles)."""
        node = self.node(name, parent, centre)
        x, y, z = centre
        side = 1 if y >= 0 else -1
        bevel = tread_bevel if tread_bevel is not None else radius * 0.09
        tyres = [y] if not dual else [y - side * width / 4, y + side * width / 4]
        tyre_w = width if not dual else width / 2 - 0.015
        for ty in tyres:
            self.cylinder(node, "tyre", radius, tyre_w, (x, ty, z), segments=20, bevel=bevel, segs=1)
        face = y + side * (width / 2 if dual else tyre_w / 2)
        self.cylinder(node, rim, radius * 0.6, 0.03, (x, face - side * 0.01, z), segments=16)
        self.rod(node, hub, (x, face, z), (x, face + side * 0.07, z), radius * 0.24, segments=10, radius2=radius * 0.15)
        for k in range(5):
            a = k * 2 * math.pi / 5
            self.box(node, "chassis", (radius * 0.13, 0.012, radius * 0.13), (x + math.cos(a) * radius * 0.42, face + side * 0.006, z + math.sin(a) * radius * 0.42), bevel=0.0)
        return node

    def finish(self):
        for (node, mat_name, bevel, segs), bm in self.buckets.items():
            for edge in bm.edges:
                if edge.is_manifold and edge.calc_face_angle(0.0) > SHARP_ANGLE:
                    edge.smooth = False
            mesh = bpy.data.meshes.new(f"{node}_{mat_name}")
            bm.to_mesh(mesh)
            bm.free()
            for polygon in mesh.polygons:
                polygon.use_smooth = True
            mesh.materials.append(material(mat_name))
            obj = bpy.data.objects.new(f"{node}__{mat_name}", mesh)
            bpy.context.scene.collection.objects.link(obj)
            obj.parent = self.nodes[node][0]
            if bevel > 0:
                mod = obj.modifiers.new("bevel", "BEVEL")
                mod.width = bevel
                mod.segments = segs
                mod.limit_method = "ANGLE"
                mod.angle_limit = math.radians(50)
                mod.harden_normals = True
        self.buckets = {}

    def export(self):
        self.finish()
        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, f"{self.name}.glb")
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True)
        print(f"EXPORTED {path}")
        if PREVIEW_DIR:
            preview(self.name)


def preview(name):
    scene = bpy.context.scene
    objects = [obj for obj in scene.objects if obj.type == "MESH"]
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    centre = (low + high) / 2
    radius = (high - low).length / 2
    target = bpy.data.objects.new("target", None)
    scene.collection.objects.link(target)
    target.location = centre
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    scene.collection.objects.link(camera)
    camera.location = centre + Vector((1.25, -1.6, 0.9)).normalized() * radius * 3.3
    constraint = camera.constraints.new("TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    scene.camera = camera
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.resolution_x = 720
    scene.render.resolution_y = 420
    scene.render.film_transparent = False
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scene.render.filepath = os.path.join(PREVIEW_DIR, f"{name}.png")
    bpy.ops.render.render(write_still=True)


# --------------------------------------------------------------------------- trucks

def cab(m, front, width, length, roof, floor=0.95, sleeper=False, step_x=None, wheel_x=None, wheel_r=0.5, options=True):
    """Cab-over (forward control) cab: raked windscreen, grille, bumper with lamps,
    doors, mirrors and steps. Optional roof kit lives under opt_* nodes."""
    f, b, w = front, front - length, width
    belt = 1.8 if roof < 3.0 else 1.88
    rake = 0.2
    m.prism("root", "livery", [(b, floor), (f - 0.05, floor), (f, floor + 0.1), (f, belt), (f - 0.04, belt + 0.07), (f - rake, roof - 0.16), (f - rake - 0.14, roof), (b + 0.06, roof), (b, roof - 0.06)], w, bevel=0.05)
    # windscreen on the raked face, with a black gasket
    p0, p1 = Vector((f - 0.04, 0, belt + 0.07)), Vector((f - rake, 0, roof - 0.16))
    d = p1 - p0
    normal = Vector((d.z, 0, -d.x)).normalized()
    tilt = Matrix.Rotation(math.atan2(d.x, d.z), 4, "Y")
    mid = (p0 + p1) / 2
    m.box("root", "chassis", (0.02, w * 0.9, d.length), mid + normal * 0.004, bevel=0.0, rotation=tilt)
    m.box("root", "glass", (0.02, w * 0.85, d.length * 0.9), mid + normal * 0.012, bevel=0.0, rotation=tilt)
    for s in (-1, 1):  # wipers parked at the bottom of the glass
        m.box("root", "chassis", (0.02, w * 0.3, 0.025), p0 + d * 0.08 + normal * 0.028 + Vector((0, s * w * 0.2, 0)), bevel=0.0, rotation=tilt)
    # front: grille with chrome bars, badge, bumper with lamps, yellow plate
    m.box("root", "chassis", (0.03, w * 0.62, belt - floor - 0.3), (f + 0.004, 0, floor + 0.12 + (belt - floor - 0.3) / 2), bevel=0.0)
    for k in range(4):
        m.box("root", "chrome", (0.035, w * 0.58, 0.035), (f + 0.012, 0, floor + 0.22 + k * (belt - floor - 0.45) / 3), bevel=0.0)
    m.box("root", "chrome", (0.04, 0.32, 0.07), (f + 0.01, 0, belt - 0.1), bevel=0.0)
    m.box("root", "chassis", (0.3, w + 0.02, 0.48), (f - 0.1, 0, floor - 0.22), bevel=0.04)
    for s in (-1, 1):
        m.box("root", "lamp_white", (0.04, 0.4, 0.14), (f + 0.06, s * (w / 2 - 0.33), floor - 0.1), bevel=0.0)
        m.box("root", "lamp_amber", (0.04, 0.12, 0.14), (f + 0.06, s * (w / 2 - 0.07), floor - 0.1), bevel=0.0)
        m.cylinder("root", "lamp_white", 0.05, 0.03, (f + 0.055, s * (w / 2 - 0.42), floor - 0.34), axis="X", segments=10)
    m.box("root", "hazard_yellow", (0.02, 0.5, 0.12), (f + 0.055, 0, floor - 0.32), bevel=0.0)
    for s in (-1, 1):
        y = s * w / 2
        df, dr = f - 0.16, f - (1.05 if sleeper else 0.98)
        # door glass (front edge follows the windscreen rake), seams, handle
        m.prism("root", "glass", [(dr + 0.06, belt + 0.03), (df - 0.02, belt + 0.03), (df - rake * 0.8, roof - 0.24), (dr + 0.06, roof - 0.24)], 0.02, at=y + s * 0.004)
        for x in (df, dr):
            m.box("root", "chassis", (0.014, 0.008, roof - floor - 0.3), (x, y + s * 0.002, floor + (roof - floor - 0.3) / 2 + 0.05), bevel=0.0)
        m.box("root", "chrome", (0.16, 0.03, 0.035), (dr + 0.14, y + s * 0.015, belt - 0.12), bevel=0.0)
        m.rod("root", "chrome", (dr - 0.05, y + s * 0.04, floor + 0.2), (dr - 0.05, y + s * 0.04, belt + 0.25), 0.016, segments=6)
        if sleeper:
            m.box("root", "glass", (0.38, 0.02, 0.22), (b + 0.42, y + s * 0.003, belt + 0.12), bevel=0.0)
            m.box("root", "chassis", (0.4, 0.01, 0.28), (b + 0.42, y + s * 0.001, floor + 0.32), bevel=0.0)  # bunk vent
        # mirrors: main head, wide-angle head and two arms
        mx, my = df + 0.12, y + s * 0.3
        m.rod("root", "chassis", (df - 0.04, y, belt + 0.5), (mx, my, belt + 0.5), 0.018, segments=6)
        m.rod("root", "chassis", (df - 0.04, y, belt - 0.02), (mx, my, belt - 0.02), 0.018, segments=6)
        m.box("root", "chassis", (0.1, 0.22, 0.48), (mx, my, belt + 0.28), bevel=0.02, segs=1)
        m.box("root", "glass", (0.01, 0.18, 0.42), (mx - 0.052, my, belt + 0.28), bevel=0.0)
        m.box("root", "chassis", (0.09, 0.2, 0.2), (mx, my, belt - 0.1), bevel=0.02, segs=1)
        # steps behind the front wheel
        if step_x is not None:
            for k, z in enumerate((floor - 0.3, floor - 0.62)):
                m.box("root", "chassis", (0.42, 0.26, 0.035), (step_x, y - s * (0.11 + 0.02 * k), z), bevel=0.0)
            m.box("root", "chassis", (0.44, 0.03, 0.72), (step_x, y - s * 0.25, floor - 0.44), bevel=0.0)
        # wheel arch liner showing under the cab
        if wheel_x is not None:
            ring = arc(wheel_x, wheel_r, wheel_r + 0.1, 5, 175, 10) + list(reversed(arc(wheel_x, wheel_r, wheel_r + 0.04, 5, 175, 10)))
            m.prism("root", "chassis", ring, 0.36, at=s * (w / 2 - 0.2))
    if options:
        visor = m.node("opt_visor", "root", (f - rake, 0, roof))
        m.box(visor, "livery", (0.42, w * 0.94, 0.05), (f - rake - 0.02, 0, roof + 0.02), bevel=0.015, rotation=Matrix.Rotation(0.16, 4, "Y"), segs=1)
        lamps = m.node("opt_lamps", "root", (f - rake, 0, roof))
        for k in range(5):
            m.box(lamps, "lamp_amber", (0.06, 0.1, 0.05), (f - rake - 0.12, (k - 2) * w * 0.18, roof + 0.07), bevel=0.0)
        horns = m.node("opt_horns", "root", (b + 0.6, 0, roof))
        for s in (-1, 1):
            m.cylinder(horns, "chrome", 0.035, 0.42, (b + 0.75, s * 0.25, roof + 0.05), axis="X", segments=8, radius2=0.06)
        deflector = m.node("opt_deflector", "root", (b, 0, roof))
        m.prism(deflector, "livery", [(f - rake - 0.3, roof), (b + 0.08, roof), (b + 0.08, roof + 0.62), (b + 0.5, roof + 0.6)], w * 0.86, bevel=0.03, segs=1)
    return belt


def frame(m, x0, x1, top=1.02, gauge=0.86, step=1.3):
    """Ladder chassis: two rails and cross members."""
    for s in (-1, 1):
        m.box("root", "chassis", (x1 - x0, 0.08, 0.26), ((x0 + x1) / 2, s * gauge / 2, top - 0.13), bevel=0.0)
    n = max(2, int((x1 - x0) / step))
    for k in range(n + 1):
        m.box("root", "chassis", (0.08, gauge, 0.16), (x0 + 0.1 + k * (x1 - x0 - 0.2) / n, 0, top - 0.13), bevel=0.0)


def cargo_box(m, rear_x, front_x, width=2.5, deck=1.2, height=2.6):
    """Closed container body: ribbed walls (ghosted at the dock), aluminium rails
    and corner posts, livery band, side marker lamps and yellow conspicuity tape."""
    length = front_x - rear_x
    centre = (front_x + rear_x) / 2
    top = deck + height
    # floor, walls and roof as separate slabs so the shell can be ghosted at runtime
    m.box("root", "graphite", (length, width, 0.1), (centre, 0, deck - 0.05), bevel=0.0)
    m.box("shell_node", "shell", (length, 0.04, height), (centre, width / 2 - 0.02, deck + height / 2), bevel=0.0)
    m.box("shell_node", "shell", (length, 0.04, height), (centre, -width / 2 + 0.02, deck + height / 2), bevel=0.0)
    m.box("shell_node", "shell", (length, width, 0.06), (centre, 0, top - 0.03), bevel=0.0)
    m.box("shell_node", "shell", (0.06, width, height), (front_x - 0.03, 0, deck + height / 2), bevel=0.0)
    ribs = int(length / 0.34)
    for k in range(1, ribs):
        x = rear_x + k * length / ribs
        for s in (-1, 1):
            m.box("shell_node", "shell", (0.05, 0.03, height - 0.26), (x, s * (width / 2 + 0.012), deck + height / 2), bevel=0.0)
    for k in range(1, 6):  # front wall ribs
        m.box("shell_node", "shell", (0.03, 0.05, height - 0.26), (front_x + 0.012, -width / 2 + k * width / 6, deck + height / 2), bevel=0.0)
    for s in (-1, 1):
        y = s * width / 2
        m.box("root", "chrome", (length, 0.07, 0.12), (centre, y + s * 0.012, top - 0.06), bevel=0.0)  # top rail
        m.box("root", "chrome", (length, 0.08, 0.18), (centre, y + s * 0.015, deck + 0.09), bevel=0.0)  # bottom rail
        m.box("root", "chrome", (0.09, 0.09, height), (front_x - 0.03, y, deck + height / 2), bevel=0.0)  # front corner post
        m.box("shell_node", "livery", (length * 0.95, 0.02, 0.34), (centre, y + s * 0.035, top - 0.42), bevel=0.0)
        m.box("shell_node", "livery", (length * 0.95, 0.02, 0.06), (centre, y + s * 0.035, top - 0.66), bevel=0.0)
        dashes = int(length / 1.0)
        for k in range(dashes):
            m.box("root", "hazard_yellow", (0.5, 0.01, 0.05), (rear_x + 0.5 + k * (length - 1.0) / max(1, dashes - 1), y + s * 0.06, deck + 0.13), bevel=0.0)
        for k in range(int(length / 3.0) + 1):
            m.box("root", "lamp_amber", (0.08, 0.02, 0.05), (rear_x + 0.4 + k * (length - 0.8) / max(1, int(length / 3.0)), y + s * 0.06, deck + 0.04), bevel=0.0)
        m.box("root", "lamp_white", (0.02, 0.1, 0.06), (front_x + 0.01, s * (width / 2 - 0.12), top - 0.1), bevel=0.0)


def rear_doors(m, rear_x, width, bottom, height, shell="shell"):
    """Twin barn doors with lock rods, cam keepers and hinges; rear frame,
    light clusters, yellow plate and a striped underrun bar."""
    m.box("root", "chrome", (0.1, width, 0.14), (rear_x + 0.05, 0, bottom + height + 0.05), bevel=0.0)  # header
    m.box("root", "chrome", (0.12, width, 0.1), (rear_x + 0.06, 0, bottom - 0.03), bevel=0.0)  # sill
    for side in (-1, 1):
        m.box("root", "chrome", (0.1, 0.09, height + 0.12), (rear_x + 0.05, side * (width / 2 - 0.045), bottom + height / 2), bevel=0.0)
        m.box("root", "lamp_red", (0.03, 0.1, 0.06), (rear_x - 0.005, side * (width / 2 - 0.15), bottom + height + 0.06), bevel=0.0)
    for side, name in ((1, "door_l"), (-1, "door_r")):
        hinge = (rear_x - 0.02, side * (width / 2 + 0.01), bottom)
        node = m.node(name, "root", hinge)
        leaf = width / 2 - 0.03
        m.box(node, shell, (0.05, leaf, height), (rear_x - 0.03, side * width / 4, bottom + height / 2), bevel=0.01, segs=1)
        for z in (0.22, 0.5, 0.78):
            m.box(node, shell, (0.025, leaf - 0.1, 0.06), (rear_x - 0.06, side * width / 4, bottom + height * z), bevel=0.0)
        for frac in (0.18, 0.62):
            y = side * width / 2 * frac + side * 0.04
            m.cylinder(node, "steel", 0.02, height * 0.97, (rear_x - 0.08, y, bottom + height / 2), axis="Z", segments=6)
            for z in (0.03, height - 0.03):
                m.box(node, "chassis", (0.06, 0.07, 0.07), (rear_x - 0.08, y, bottom + z), bevel=0.0)
            m.box(node, "chassis", (0.04, 0.05, 0.22), (rear_x - 0.1, y + side * 0.06, bottom + height * 0.42), bevel=0.0)
        for z in (0.12, 0.38, 0.62, 0.88):
            m.box(node, "steel", (0.06, 0.14, 0.08), (rear_x - 0.06, side * (width / 2 - 0.07), bottom + height * z), bevel=0.0)
    # lights under the body, plate and underrun bar
    for side in (-1, 1):
        m.box("root", "chassis", (0.08, 0.6, 0.2), (rear_x + 0.06, side * (width / 2 - 0.36), bottom - 0.27), bevel=0.0)
        m.box("root", "lamp_red", (0.03, 0.24, 0.12), (rear_x + 0.01, side * (width / 2 - 0.3), bottom - 0.27), bevel=0.0)
        m.box("root", "lamp_amber", (0.03, 0.1, 0.12), (rear_x + 0.01, side * (width / 2 - 0.12), bottom - 0.27), bevel=0.0)
        m.box("root", "lamp_white", (0.03, 0.09, 0.1), (rear_x + 0.01, side * (width / 2 - 0.53), bottom - 0.27), bevel=0.0)
        m.box("root", "chassis", (0.08, 0.08, bottom - 0.6), (rear_x + 0.3, side * 0.65, 0.55 + (bottom - 0.6) / 2), bevel=0.0)
    m.box("root", "hazard_yellow", (0.02, 0.5, 0.13), (rear_x + 0.02, 0, bottom - 0.3), bevel=0.0)
    m.box("root", "chassis", (0.12, width * 0.88, 0.15), (rear_x + 0.25, 0, 0.5), bevel=0.0)
    for k in range(7):
        m.box("root", "hazard_yellow", (0.125, 0.15, 0.155), (rear_x + 0.25, -width * 0.39 + k * width * 0.13, 0.5), bevel=0.0)


def mudguard(m, x0, x1, y, z, width=0.64, flap=True):
    m.box("root", "chassis", (x1 - x0, width, 0.035), ((x0 + x1) / 2, y, z), bevel=0.0)
    m.box("root", "chassis", (0.03, width, 0.18), (x0, y, z - 0.09), bevel=0.0)
    if flap:
        m.box("root", "tyre", (0.02, width * 0.9, 0.55), (x0 - 0.03, y, z - 0.35), bevel=0.0)


def side_guard(m, x0, x1, y, zs=(0.5, 0.8)):
    for z in zs:
        m.box("root", "chrome", (x1 - x0, 0.03, 0.09), ((x0 + x1) / 2, y, z), bevel=0.0)
    for x in (x0 + 0.1, (x0 + x1) / 2, x1 - 0.1):
        m.box("root", "chassis", (0.06, abs(y) - 0.42, 0.06), (x, (abs(y) + 0.42) / 2 * (1 if y > 0 else -1), zs[-1]), bevel=0.0)


def fuel_tank(m, x, y, radius=0.28, length=1.0):
    m.cylinder("root", "chrome", radius, length, (x, y, 0.72), axis="X", segments=16)
    for dx in (-length * 0.3, length * 0.3):
        m.cylinder("root", "chassis", radius + 0.012, 0.05, (x + dx, y, 0.72), axis="X", segments=16)
    m.cylinder("root", "chassis", 0.05, 0.05, (x + length * 0.38, y, 0.72 + radius + 0.02), axis="Z", segments=8)


def build_rigid(name, length, box_length, axles, cab_length, cab_width, roof, sleeper, front_overhang, wheel_r):
    m = Model(name, TRUCK_ALIASES)
    rear = -length / 2
    front = length / 2
    front_axle = front - front_overhang
    m.node("shell_node", "root", (0, 0, 0))
    frame(m, rear + 0.25, front - 0.4)
    cab(m, front, cab_width, cab_length, roof, sleeper=sleeper, step_x=front_axle - wheel_r - 0.28, wheel_x=front_axle, wheel_r=wheel_r)
    body_front = rear + box_length
    cargo_box(m, rear, body_front)
    rear_doors(m, rear, 2.5, 1.2, 2.55)
    # subframe and crossbearers carry the body on the chassis
    for s in (-1, 1):
        m.box("root", "chassis", (box_length - 0.2, 0.1, 0.1), (rear + box_length / 2, s * 0.43, 1.07), bevel=0.0)
    for k in range(int(box_length / 0.6) + 1):
        m.box("root", "chassis", (0.07, 2.42, 0.07), (rear + 0.15 + k * (box_length - 0.3) / int(box_length / 0.6), 0, 1.1), bevel=0.0)
    # tanks, battery box, air tanks
    tank_x = front_axle - wheel_r - 1.25
    fuel_tank(m, tank_x, 0.95, length=1.0 if box_length < 7 else 1.3)
    m.box("root", "chassis", (0.65, 0.55, 0.48), (tank_x, -0.95, 0.75), bevel=0.02, segs=1)
    m.box("root", "chassis", (0.67, 0.57, 0.04), (tank_x, -0.95, 1.0), bevel=0.0)
    for s in (-1, 1):
        m.cylinder("root", "chassis", 0.12, 0.85, (rear + axles[0] + 1.5, s * 0.25, 0.72), axis="X", segments=10)
    # rear wheels with flat mudguards and flaps
    first, last = rear + max(axles), rear + min(axles)
    guard_x0 = tank_x + (0.65 if box_length < 7 else 0.8)
    for s in (-1, 1):
        mudguard(m, last - wheel_r - 0.12, first + wheel_r + 0.12, s * 0.94, 2 * wheel_r + 0.1)
        side_guard(m, guard_x0, first - wheel_r - 0.2, s * 1.22)
    m.wheel("wheel_f_l", "root", (front_axle, 1.02, wheel_r), wheel_r, 0.3)
    m.wheel("wheel_f_r", "root", (front_axle, -1.02, wheel_r), wheel_r, 0.3)
    for i, x in enumerate(axles):
        m.wheel(f"wheel_r{i}_l", "root", (rear + x, 0.94, wheel_r), wheel_r, 0.54, dual=True)
        m.wheel(f"wheel_r{i}_r", "root", (rear + x, -0.94, wheel_r), wheel_r, 0.54, dual=True)
        m.box("root", "chassis", (0.22, 1.6, 0.2), (rear + x, 0, wheel_r), bevel=0.0)
        m.cylinder("root", "chassis", 0.22, 0.32, (rear + x, 0, wheel_r), axis="Y", segments=12)  # differential
    m.export()


def build_tractor():
    m = Model("tractor", TRUCK_ALIASES)
    front, width, roof, wheel_r = 3.0, 2.44, 3.08, 0.52
    front_axle = 1.85
    frame(m, -3.3, front - 0.4)
    cab(m, front, width, 2.3, roof, sleeper=True, step_x=front_axle - wheel_r - 0.28, wheel_x=front_axle, wheel_r=wheel_r, options=False)
    back = front - 2.3
    # fixed roof deflector and side extenders: a tractor always runs with them
    m.prism("root", "livery", [(front - 0.55, roof), (back + 0.06, roof), (back + 0.06, roof + 0.78), (back + 0.5, roof + 0.76)], width * 0.9, bevel=0.03, segs=1)
    for s in (-1, 1):
        m.box("root", "livery", (0.35, 0.03, roof - 1.3), (back - 0.12, s * (width / 2 - 0.03), 1.3 + (roof - 1.3) / 2), bevel=0.0)
    visor = m.node("opt_visor", "root", (front - 0.2, 0, roof))
    m.box(visor, "livery", (0.42, width * 0.94, 0.05), (front - 0.22, 0, roof + 0.02), bevel=0.015, rotation=Matrix.Rotation(0.16, 4, "Y"), segs=1)
    lamps = m.node("opt_lamps", "root", (front - 0.2, 0, roof))
    for k in range(5):
        m.box(lamps, "lamp_amber", (0.06, 0.1, 0.05), (front - 0.32, (k - 2) * width * 0.18, roof + 0.07), bevel=0.0)
    # exhaust stack and air intake behind the cab
    m.rod("root", "chrome", (back - 0.2, -1.0, 1.2), (back - 0.2, -1.0, roof + 0.6), 0.065, segments=12)
    m.box("root", "chrome", (0.04, 0.2, 1.0), (back - 0.12, -1.0, 2.2), bevel=0.0)
    m.rod("root", "chassis", (back - 0.2, 1.0, 1.1), (back - 0.2, 1.0, roof - 0.1), 0.11, segments=12)
    m.rod("root", "chassis", (back - 0.2, 1.0, roof - 0.1), (back - 0.05, 1.0, roof + 0.05), 0.13, segments=12, radius2=0.15)
    # catwalk and coiled air/electric lines to the trailer
    m.box("root", "chrome", (0.75, 0.9, 0.04), (back - 0.6, 0, 1.12), bevel=0.0)
    for y, mat in ((-0.12, "hazard_yellow"), (0.0, "lamp_red"), (0.12, "chassis")):
        m.rod("root", mat, (back - 0.08, y, 2.1), (back - 0.6, y, 1.7), 0.025, segments=6)
        m.rod("root", mat, (back - 0.6, y, 1.7), (back - 1.1, y, 1.45), 0.025, segments=6)
    # fifth wheel: horseshoe plate with the V slot facing back
    centre = -1.6
    plate = arc(centre, 0, 0.55, -160, 160, 18) + [(centre - 0.15, 0.05), (centre - 0.15, -0.05)]
    m.prism("root", "chassis", plate, 0.07, at=1.15, axis="Z", bevel=0.01, segs=1)
    for s in (-1, 1):
        m.box("root", "chassis", (1.0, 0.12, 0.14), (centre, s * 0.38, 1.08), bevel=0.0)
        m.box("root", "chrome", (0.2, 0.08, 0.2), (centre, s * 0.52, 1.12), bevel=0.0)
    # tanks, battery box, fenders, light bar
    fuel_tank(m, -0.15, 1.0, radius=0.3, length=1.1)
    m.box("root", "chassis", (0.65, 0.55, 0.5), (-0.15, -0.98, 0.75), bevel=0.02, segs=1)
    m.box("root", "chassis", (0.67, 0.57, 0.04), (-0.15, -0.98, 1.01), bevel=0.0)
    for s in (-1, 1):
        mudguard(m, -2.45 - wheel_r - 0.12, -1.1 + wheel_r + 0.12, s * 0.94, 2 * wheel_r + 0.1)
    m.box("root", "chassis", (0.1, 2.0, 0.14), (-3.32, 0, 0.92), bevel=0.0)
    for s in (-1, 1):
        m.box("root", "lamp_red", (0.03, 0.22, 0.1), (-3.38, s * 0.78, 0.92), bevel=0.0)
        m.box("root", "lamp_amber", (0.03, 0.1, 0.1), (-3.38, s * 0.95, 0.92), bevel=0.0)
    m.box("root", "hazard_yellow", (0.02, 0.45, 0.12), (-3.38, 0, 0.92), bevel=0.0)
    m.wheel("wheel_f_l", "root", (front_axle, 1.02, wheel_r), wheel_r, 0.32)
    m.wheel("wheel_f_r", "root", (front_axle, -1.02, wheel_r), wheel_r, 0.32)
    for i, x in enumerate((-1.1, -2.45)):
        m.wheel(f"wheel_r{i}_l", "root", (x, 0.94, wheel_r), wheel_r, 0.54, dual=True)
        m.wheel(f"wheel_r{i}_r", "root", (x, -0.94, wheel_r), wheel_r, 0.54, dual=True)
        m.box("root", "chassis", (0.22, 1.6, 0.2), (x, 0, wheel_r), bevel=0.0)
        m.cylinder("root", "chassis", 0.24, 0.34, (x, 0, wheel_r), axis="Y", segments=12)
    m.export()


def build_trailer():
    m = Model("trailer_40", TRUCK_ALIASES)
    m.node("shell_node", "root", (0, 0, 0))
    front, rear, deck = 1.0, -11.2, 1.25
    axles = (-7.6, -8.8, -10.0)
    cargo_box(m, rear, front, deck=deck, height=2.7)
    rear_doors(m, rear, 2.5, deck, 2.65)
    # main beams, outriggers, kingpin plate
    for s in (-1, 1):
        m.box("root", "chassis", (11.6, 0.1, 0.38), (-5.0, s * 0.5, deck - 0.29), bevel=0.0)
    for k in range(20):
        m.box("root", "chassis", (0.06, 2.4, 0.08), (rear + 0.3 + k * (front - rear - 0.6) / 19, 0, deck - 0.14), bevel=0.0)
    m.box("root", "chassis", (1.6, 1.4, 0.04), (0.1, 0, deck - 0.12), bevel=0.0)
    m.cylinder("root", "chrome", 0.045, 0.1, (0, 0, deck - 0.19), axis="Z", segments=10)
    # glad hands and electrical socket on the front wall
    m.box("root", "hazard_yellow", (0.05, 0.08, 0.08), (front + 0.03, 0.25, 1.45), bevel=0.0)
    m.box("root", "lamp_red", (0.05, 0.08, 0.08), (front + 0.03, -0.25, 1.45), bevel=0.0)
    m.cylinder("root", "chassis", 0.05, 0.08, (front + 0.03, 0, 1.45), axis="X", segments=8)
    # landing gear with sand shoes, cross brace and crank
    leg_x = -2.4
    for s in (-1, 1):
        m.box("root", "chassis", (0.14, 0.14, 0.62), (leg_x, s * 0.55, deck - 0.45), bevel=0.0)
        m.box("root", "chrome", (0.1, 0.1, 0.55), (leg_x, s * 0.55, 0.32), bevel=0.0)
        m.box("root", "chrome", (0.32, 0.26, 0.05), (leg_x, s * 0.55, 0.03), bevel=0.0)
    m.beam("root", "chassis", (leg_x, -0.55, 0.6), (leg_x, 0.55, 0.95), 0.05)
    m.beam("root", "chassis", (leg_x, 0.55, 0.6), (leg_x, -0.55, 0.95), 0.05)
    m.box("root", "chassis", (0.18, 0.12, 0.18), (leg_x, -0.68, 0.85), bevel=0.0)
    m.rod("root", "chrome", (leg_x, -0.74, 0.85), (leg_x, -0.95, 0.85), 0.02, segments=6)
    m.rod("root", "chrome", (leg_x, -0.95, 0.85), (leg_x, -0.95, 0.6), 0.02, segments=6)
    # toolbox, spare wheel, side guards, suspension, fenders
    m.box("root", "chassis", (0.7, 0.45, 0.45), (-4.2, 0.95, 0.85), bevel=0.02, segs=1)
    m.box("root", "chrome", (0.08, 0.03, 0.04), (-4.2, 1.18, 0.95), bevel=0.0)
    m.cylinder("root", "tyre", 0.5, 0.28, (-5.6, 0, 0.62), axis="Z", segments=16)
    m.cylinder("root", "chrome", 0.3, 0.3, (-5.6, 0, 0.62), axis="Z", segments=12)
    for s in (-1, 1):
        side_guard(m, leg_x - 0.5, axles[0] + 0.7, s * 1.22, zs=(0.6, 0.92))
        mudguard(m, axles[-1] - 0.62, axles[0] + 0.62, s * 0.94, 1.1)
    for x in axles:
        m.box("root", "chassis", (0.14, 1.9, 0.14), (x, 0, 0.5), bevel=0.0)
        for s in (-1, 1):
            m.box("root", "chassis", (1.0, 0.08, 0.07), (x, s * 0.5, 0.68), bevel=0.0)
            m.box("root", "chassis", (0.12, 0.1, 0.42), (x + 0.45, s * 0.5, 0.86), bevel=0.0)
    for i, x in enumerate(axles):
        m.wheel(f"wheel_{i}_l", "root", (x, 0.94, 0.5), 0.5, 0.54, dual=True)
        m.wheel(f"wheel_{i}_r", "root", (x, -0.94, 0.5), 0.5, 0.54, dual=True)
    m.export()


# --------------------------------------------------------------------------- warehouse equipment

def forks(m, node, x0, length, z, spacing=0.3, shank=0.62, width=0.11):
    """L-shaped forged forks with a tapered tip and a top hook."""
    for side in (-1, 1):
        profile = [(x0 - 0.03, z), (x0 + length - 0.12, z), (x0 + length, z + 0.012), (x0 + length, z + 0.024), (x0 + length - 0.14, z + 0.045), (x0 + 0.03, z + 0.045), (x0 + 0.03, z + shank), (x0 - 0.03, z + shank)]
        m.prism(node, "fork", profile, width, at=side * spacing, bevel=0.004, segs=1)
        m.box(node, "fork", (0.07, width, 0.06), (x0 - 0.045, side * spacing, z + shank - 0.03), bevel=0.0)
        m.box(node, "fork", (0.07, width, 0.05), (x0 - 0.045, side * spacing, z + 0.14), bevel=0.0)


def mast(m, parent, x, height, width, inner_height, carriage_width, fork_length, backrest=0.78):
    """Duplex mast: C-channel uprights, lift cylinders, crossheads with chain
    sheaves, fork carriage with load backrest and forks."""
    outer = m.node("mast_outer", parent, (x, 0, 0))
    z0 = 0.08
    for side in (-1, 1):
        y = side * width / 2
        m.box(outer, "mast", (0.12, 0.022, height), (x, y, z0 + height / 2), bevel=0.0)
        for dx in (-0.05, 0.05):
            m.box(outer, "mast", (0.022, 0.07, height), (x + dx, y - side * 0.035, z0 + height / 2), bevel=0.0)
        m.cylinder(outer, "graphite", 0.048, height * 0.55, (x - 0.13, side * (width / 2 - 0.13), z0 + height * 0.275), axis="Z", segments=12)
        m.cylinder(outer, "chrome", 0.03, height * 0.45, (x - 0.13, side * (width / 2 - 0.13), z0 + height * 0.55 + height * 0.2), axis="Z", segments=10)
    m.box(outer, "mast", (0.12, width + 0.02, 0.1), (x, 0, z0 + height - 0.05), bevel=0.0)
    m.box(outer, "mast", (0.12, width + 0.02, 0.12), (x, 0, 0.32), bevel=0.0)
    m.box(outer, "mast", (0.06, width * 0.7, 0.05), (x - 0.13, 0, z0 + height * 0.55), bevel=0.0)
    inner = m.node("mast_inner", outer, (x, 0, 0))
    for side in (-1, 1):
        y = side * (width / 2 - 0.075)
        m.box(inner, "mast", (0.1, 0.02, inner_height), (x + 0.02, y, 0.15 + inner_height / 2), bevel=0.0)
        for dx in (-0.04, 0.04):
            m.box(inner, "mast", (0.02, 0.06, inner_height), (x + 0.02 + dx, y + side * 0.03, 0.15 + inner_height / 2), bevel=0.0)
        m.cylinder(inner, "chrome", 0.06, 0.05, (x + 0.02, side * 0.16, inner_height + 0.1), axis="Y", segments=12)
    m.box(inner, "mast", (0.1, width - 0.15, 0.08), (x + 0.02, 0, inner_height + 0.15), bevel=0.0)
    carriage = m.node("carriage", parent, (x + 0.14, 0, 0))
    cx = x + 0.15
    m.box(carriage, "graphite", (0.06, carriage_width, 0.12), (cx, 0, 0.43), bevel=0.0)
    m.box(carriage, "graphite", (0.06, carriage_width, 0.12), (cx, 0, 0.13), bevel=0.0)
    for side in (-1, 1):
        m.box(carriage, "graphite", (0.08, 0.04, 0.5), (cx - 0.02, side * (carriage_width / 2 - 0.02), 0.3), bevel=0.0)
    for k in range(7):  # load backrest
        m.box(carriage, "graphite", (0.025, 0.03, backrest), (cx, -carriage_width / 2 + 0.03 + k * (carriage_width - 0.06) / 6, 0.49 + backrest / 2), bevel=0.0)
    m.box(carriage, "graphite", (0.04, carriage_width, 0.05), (cx, 0, 0.49 + backrest), bevel=0.0)
    m.box(carriage, "graphite", (0.03, carriage_width, 0.03), (cx, 0, 0.49 + backrest * 0.5), bevel=0.0)
    forks(m, carriage, x + 0.2, fork_length, 0.0)
    m.node("load_socket", carriage, (x + 0.2 + fork_length / 2, 0, 0.05))
    return outer, inner, carriage


def beacon(m, x, y, z, radius=0.06):
    m.cylinder("root", "graphite", radius + 0.012, 0.03, (x, y, z - 0.015), axis="Z", segments=12)
    node = m.node("beacon", "root", (x, y, z + 0.07))
    m.cylinder(node, "beacon", radius, 0.13, (x, y, z + 0.065), axis="Z", segments=14, radius2=radius * 0.8)


def build_reach_truck():
    """Linde R14-class reach truck: 1.27 m wide chassis, 2.25 m overhead guard,
    straddle legs with load wheels, mast on a pantograph-free reach carriage."""
    m = Model("reach_truck", {**MHE_ALIASES, "lamp_red": "beacon"})
    body = "livery"
    plan = rounded_rect(-1.08, 0.37, -0.625, 0.625, (0.05, 0.32, 0.32, 0.05))
    m.prism("root", body, plan, 0.5, at=0.08, axis="Z", bevel=0.03)
    m.prism("root", "graphite", rounded_rect(-1.095, 0.385, -0.64, 0.64, (0.06, 0.33, 0.33, 0.06)), 0.1, at=0.04, axis="Z", bevel=0.0)
    # battery tower with cover, vents and lifting handles
    m.box("root", body, (0.62, 1.25, 0.56), (0.06, 0, 0.86), bevel=0.04)
    m.box("root", "graphite", (0.6, 1.2, 0.035), (0.06, 0, 1.155), bevel=0.01, segs=1)
    for s in (-1, 1):
        for k in range(4):  # louvres
            m.box("root", "graphite", (0.38, 0.01, 0.025), (0.06, s * 0.628, 0.74 + k * 0.065), bevel=0.0)
    # operator compartment: right and rear walls, floor, step, seat facing sideways
    m.box("root", body, (0.83, 0.09, 0.48), (-0.665, -0.58, 0.82), bevel=0.03, segs=1)
    m.prism("root", body, arc(-0.76, -0.3, 0.32, 180, 270, 4) + [(-0.25, -0.62), (-0.25, -0.54), (-0.76, -0.54)] + arc(-0.76, -0.3, 0.24, 270, 180, 4), 0.48, at=0.58, axis="Z", bevel=0.0)
    m.box("root", "graphite", (0.7, 0.95, 0.02), (-0.66, 0.05, 0.59), bevel=0.0)
    m.box("root", "hazard_yellow", (0.42, 0.16, 0.03), (-0.65, 0.65, 0.33), bevel=0.0)
    m.box("root", "graphite", (0.42, 0.04, 0.27), (-0.65, 0.6, 0.46), bevel=0.0)
    m.box("root", "seat", (0.42, 0.4, 0.09), (-0.64, -0.28, 0.98), bevel=0.03, segs=1)
    m.box("root", "seat", (0.42, 0.09, 0.46), (-0.64, -0.5, 1.26), bevel=0.03, segs=1, rotation=Matrix.Rotation(-0.12, 4, "X"))
    m.rod("root", "graphite", (-0.64, -0.28, 0.6), (-0.64, -0.28, 0.93), 0.05, segments=8)
    m.box("root", "graphite", (0.26, 0.2, 0.28), (-0.32, -0.25, 1.06), bevel=0.02, segs=1)
    for k in range(4):  # mini levers
        m.rod("root", "hazard_yellow", (-0.36 + k * 0.035, -0.22, 1.2), (-0.36 + k * 0.035, -0.22, 1.27), 0.012, segments=6)
    m.rod("root", "graphite", (-0.9, 0.22, 0.6), (-0.82, 0.22, 1.08), 0.03, segments=8)
    m.rod("root", "graphite", (-0.83, 0.22, 1.08), (-0.81, 0.22, 1.11), 0.13, segments=16)
    # overhead guard
    height = 2.25
    for x, z in ((-0.18, 1.17), (-1.0, 0.58)):
        for s in (-1, 1):
            m.box("root", "graphite", (0.07, 0.07, height - z), (x, s * 0.58, z + (height - z) / 2), bevel=0.0)
    for s in (-1, 1):
        m.box("root", "graphite", (0.92, 0.07, 0.08), (-0.59, s * 0.58, height), bevel=0.0)
    for x in (-0.18, -1.0):
        m.box("root", "graphite", (0.08, 1.23, 0.08), (x, 0, height), bevel=0.0)
    for k in range(6):
        m.box("root", "graphite", (0.82, 0.05, 0.03), (-0.59, -0.45 + k * 0.18, height + 0.03), bevel=0.0)
    for s in (-1, 1):
        m.box("root", "lamp_white", (0.05, 0.12, 0.08), (-0.13, s * 0.58, height - 0.12), bevel=0.0)
    m.box("root", "graphite", (0.06, 0.26, 0.2), (-0.22, -0.48, 1.55), bevel=0.0)
    m.box("root", "glass", (0.01, 0.22, 0.16), (-0.255, -0.48, 1.55), bevel=0.0)
    beacon(m, -0.85, 0.0, height + 0.06)
    # cold-store cabin kit: glazed side, rear and roof panels
    cabin = m.node("opt_cabin", "root", (-0.6, 0, 1.6))
    m.box(cabin, "glass", (0.8, 1.15, 0.015), (-0.59, 0, height + 0.06), bevel=0.0)
    m.box(cabin, "glass", (0.78, 0.015, 1.05), (-0.59, 0.6, 1.62), bevel=0.0)
    m.box(cabin, "glass", (0.78, 0.015, 0.6), (-0.59, -0.6, 1.88), bevel=0.0)
    m.box(cabin, "glass", (0.015, 1.12, 1.55), (-1.04, 0, 1.4), bevel=0.0)
    # straddle legs with load-wheel pockets, mast rails
    for s in (-1, 1):
        leg = [(0.3, 0.05), (1.26, 0.05), (1.26, 0.13), (1.5, 0.13), (1.62, 0.19), (1.62, 0.25), (1.52, 0.29), (0.3, 0.31)]
        m.prism("root", body, leg, 0.16, at=s * 0.55, bevel=0.012, segs=1)
        m.box("root", "graphite", (1.18, 0.04, 0.12), (0.9, s * 0.45, 0.25), bevel=0.0)
        m.box("root", "hazard_yellow", (0.06, 0.161, 0.1), (1.58, s * 0.55, 0.22), bevel=0.0)
        m.wheel(f"wheel_load_{'l' if s > 0 else 'r'}", "root", (1.38, s * 0.55, 0.11), 0.11, 0.1, rim="steel", tread_bevel=0.01)
    m.wheel("wheel_drive", "root", (-0.75, -0.25, 0.18), 0.18, 0.16, rim="steel")
    m.wheel("wheel_caster", "root", (-0.75, 0.42, 0.1), 0.1, 0.08, rim="steel")
    reach = m.node("reach", "root", (0.42, 0, 0))
    for s in (-1, 1):
        m.box(reach, "graphite", (0.3, 0.1, 0.18), (0.42, s * 0.45, 0.4), bevel=0.0)
    m.rod(reach, "graphite", (0.3, 0.2, 0.55), (0.28, 0.2, 1.3), 0.015, segments=6)
    m.rod(reach, "graphite", (0.3, -0.2, 0.55), (0.28, -0.2, 1.3), 0.015, segments=6)
    mast(m, reach, 0.42, 3.0, 0.78, 3.15, 0.8, 1.15, backrest=0.95)
    camera = m.node("opt_camera", "carriage", (0.6, 0, 1.5))
    m.box(camera, "graphite", (0.08, 0.12, 0.1), (0.6, 0, 1.52), bevel=0.0)
    m.box(camera, "glass", (0.01, 0.06, 0.06), (0.645, 0, 1.52), bevel=0.0)
    m.export()


def build_forklift():
    """Toyota 8-series-class counterbalance: 1.15 m wide, 2.14 m guard,
    drive axle outboard of the mast, counterweight over the steer axle."""
    m = Model("forklift", MHE_ALIASES)
    body = "livery"
    # frame between the wheels, hood/cowl above them
    m.box("root", body, (1.3, 0.64, 0.5), (-0.2, 0, 0.42), bevel=0.03, segs=1)
    m.prism("root", body, [(-0.72, 0.66), (0.56, 0.66), (0.58, 0.95), (0.48, 1.12), (0.3, 1.14), (0.24, 1.0), (-0.72, 1.0)], 1.12, bevel=0.035)
    # counterweight: narrow between the steer wheels, full width above
    m.prism("root", "graphite", [(-0.7, 0.14), (-1.12, 0.14), (-1.24, 0.3), (-1.27, 0.55), (-0.7, 0.55)], 0.62, bevel=0.02, segs=1)
    m.prism("root", "graphite", [(-0.7, 0.55), (-1.27, 0.55), (-1.29, 0.86), (-1.21, 1.1), (-1.05, 1.2), (-0.7, 1.2)], 1.12, bevel=0.03)
    for s in (-1, 1):
        m.box("root", "lamp_red", (0.03, 0.12, 0.08), (-1.29, s * 0.4, 0.92), bevel=0.0, rotation=Matrix.Rotation(-0.25, 4, "Y"))
    m.box("root", "tyre", (0.04, 0.2, 0.09), (-1.27, 0, 0.42), bevel=0.0)  # tow pin slot
    # step, seat, steering, levers
    m.box("root", "graphite", (0.36, 0.14, 0.04), (-0.3, 0.42, 0.4), bevel=0.0)
    m.box("root", "hazard_yellow", (0.36, 0.02, 0.045), (-0.3, 0.49, 0.4), bevel=0.0)
    m.box("root", "seat", (0.46, 0.5, 0.1), (-0.38, 0, 1.06), bevel=0.03, segs=1)
    m.box("root", "seat", (0.1, 0.48, 0.5), (-0.64, 0, 1.36), bevel=0.03, segs=1, rotation=Matrix.Rotation(-0.18, 4, "Y"))
    for s in (-1, 1):
        m.box("root", "seat", (0.3, 0.05, 0.12), (-0.42, s * 0.27, 1.17), bevel=0.0)
    column0, column1 = Vector((0.32, 0, 1.12)), Vector((0.14, 0, 1.45))
    m.rod("root", "graphite", column0, column1, 0.03, segments=8)
    axis = (column1 - column0).normalized()
    m.rod("root", "graphite", column1 - axis * 0.02, column1 + axis * 0.02, 0.17, segments=18)
    for k in range(3):
        m.rod("root", "graphite", (0.44, -0.18 - k * 0.07, 1.12), (0.38, -0.18 - k * 0.07, 1.33), 0.012, segments=6)
        m.cylinder("root", "graphite", 0.025, 0.05, (0.38, -0.18 - k * 0.07, 1.35), axis="Z", segments=8)
    # overhead guard: raked front posts, vertical rear posts, slatted top
    top = 2.14
    for s in (-1, 1):
        m.beam("root", "graphite", (0.5, s * 0.53, 1.0), (0.28, s * 0.53, top), 0.07)
        m.box("root", "graphite", (0.07, 0.07, top - 1.15), (-0.95, s * 0.53, 1.15 + (top - 1.15) / 2), bevel=0.0)
        m.box("root", "graphite", (1.32, 0.07, 0.07), (-0.33, s * 0.53, top + 0.02), bevel=0.0)
        m.box("root", "lamp_white", (0.06, 0.11, 0.09), (0.33, s * 0.53, top - 0.1), bevel=0.0)
    for x in (0.3, -0.96):
        m.box("root", "graphite", (0.07, 1.13, 0.07), (x, 0, top + 0.02), bevel=0.0)
    for k in range(5):
        m.box("root", "graphite", (1.22, 0.05, 0.03), (-0.33, -0.4 + k * 0.2, top + 0.05), bevel=0.0)
    m.box("root", "lamp_white", (0.05, 0.1, 0.08), (-0.99, -0.35, top - 0.08), bevel=0.0)
    m.rod("root", "hazard_yellow", (-0.92, 0.6, 1.3), (-0.92, 0.6, 1.8), 0.022, segments=8)
    for z in (1.3, 1.8):
        m.box("root", "hazard_yellow", (0.04, 0.08, 0.04), (-0.92, 0.565, z), bevel=0.0)
    m.rod("root", "graphite", (0.28, 0.55, 1.95), (0.36, 0.7, 1.95), 0.012, segments=6)
    m.box("root", "graphite", (0.03, 0.16, 0.11), (0.37, 0.72, 1.95), bevel=0.0)
    beacon(m, -0.96, 0.0, top + 0.08)
    # tilt cylinders from the cowl to the mast
    for s in (-1, 1):
        m.rod("root", "graphite", (0.42, s * 0.3, 0.86), (0.58, s * 0.3, 0.96), 0.04, segments=10)
        m.rod("root", "steel", (0.58, s * 0.3, 0.96), (0.7, s * 0.3, 1.03), 0.025, segments=8)
    # LPG variant: bottle across the counterweight on a bracket
    lpg = m.node("opt_lpg", "root", (-1.02, 0, 1.4))
    m.cylinder(lpg, "steel", 0.16, 0.86, (-1.02, 0, 1.4), axis="Y", segments=16, bevel=0.03, segs=1)
    m.cylinder(lpg, "hazard_yellow", 0.04, 0.08, (-1.02, 0.47, 1.4), axis="Y", segments=8)
    for s in (-1, 1):
        m.box(lpg, "graphite", (0.06, 0.05, 0.22), (-1.02, s * 0.3, 1.27), bevel=0.0)
    roof = m.node("opt_roof", "root", (-0.33, 0, top))
    m.box(roof, "graphite", (1.32, 1.12, 0.02), (-0.33, 0, top + 0.075), bevel=0.0)
    for side, tag in ((1, "l"), (-1, "r")):
        m.wheel(f"wheel_f_{tag}", "root", (0.3, side * 0.47, 0.33), 0.33, 0.22, rim="steel", tread_bevel=0.04)
        m.wheel(f"wheel_b_{tag}", "root", (-1.0, side * 0.42, 0.26), 0.26, 0.18, rim="steel", tread_bevel=0.035)
    tilt = m.node("tilt", "root", (0.72, 0, 0.1))
    mast(m, tilt, 0.72, 2.25, 0.8, 2.35, 0.95, 1.15)
    m.export()


def build_pallet_truck():
    """Linde T20 SP-class electric rider pallet truck: 0.79 m wide drive unit,
    fold-down platform with side guard arms, 1.15 m forks with load rollers."""
    m = Model("pallet_truck", MHE_ALIASES)
    body = "livery"
    plan = rounded_rect(-0.66, -0.02, -0.39, 0.39, (0.04, 0.22, 0.22, 0.04))
    m.prism("root", body, plan, 0.7, at=0.1, axis="Z", bevel=0.03)
    m.prism("root", "graphite", rounded_rect(-0.675, -0.005, -0.405, 0.405, (0.05, 0.23, 0.23, 0.05)), 0.12, at=0.05, axis="Z", bevel=0.0)
    m.prism("root", "graphite", rounded_rect(-0.63, -0.05, -0.36, 0.36, (0.03, 0.19, 0.19, 0.03)), 0.05, at=0.8, axis="Z", bevel=0.012, segs=1)
    m.prism("root", "graphite", rounded_rect(-0.67, -0.01, -0.395, 0.395, (0.04, 0.22, 0.22, 0.04)), 0.04, at=0.44, axis="Z", bevel=0.0)
    m.box("root", "glass", (0.1, 0.16, 0.012), (-0.12, 0.2, 0.856), bevel=0.0)
    m.box("root", "graphite", (0.06, 0.6, 0.22), (-0.7, 0, 0.96), bevel=0.03, segs=1)  # back pad
    # platform and side guard arms
    m.prism("root", "graphite", rounded_rect(-1.08, -0.66, -0.36, 0.36, (0, 0.06, 0.06, 0)), 0.05, at=0.1, axis="Z", bevel=0.0)
    m.box("root", "hazard_yellow", (0.03, 0.7, 0.052), (-1.065, 0, 0.126), bevel=0.0)
    for s in (-1, 1):
        m.rod("root", "graphite", (-0.64, s * 0.37, 0.95), (-1.02, s * 0.37, 0.95), 0.025, segments=8)
        m.rod("root", "graphite", (-1.02, s * 0.37, 0.95), (-1.02, s * 0.37, 0.75), 0.025, segments=8)
        m.box("root", "graphite", (0.06, 0.06, 0.18), (-0.64, s * 0.37, 0.88), bevel=0.0)
    tiller = m.node("tiller", "root", (-0.12, 0, 0.86))
    m.rod(tiller, "graphite", (-0.12, 0, 0.86), (-0.42, 0, 1.2), 0.03, segments=8)
    m.box(tiller, "graphite", (0.12, 0.2, 0.08), (-0.45, 0, 1.23), bevel=0.02, segs=1)
    for s in (-1, 1):
        m.rod(tiller, "graphite", (-0.45, s * 0.08, 1.23), (-0.5, s * 0.22, 1.27), 0.022, segments=8)
    m.box(tiller, "hazard_yellow", (0.04, 0.06, 0.02), (-0.44, 0, 1.275), bevel=0.0)
    m.rod("root", "graphite", (-0.25, -0.3, 0.86), (-0.25, -0.3, 1.1), 0.015, segments=6)
    beacon(m, -0.25, -0.3, 1.12, radius=0.05)
    m.wheel("wheel_drive", "root", (-0.3, 0.0, 0.12), 0.12, 0.08, rim="steel", tread_bevel=0.01)
    lift = m.node("forks", "root", (0.0, 0, 0))
    m.box(lift, "graphite", (0.08, 0.74, 0.5), (0.02, 0, 0.33), bevel=0.01, segs=1)
    for s in (-1, 1):
        m.box(lift, "graphite", (0.03, 0.04, 0.42), (0.07, s * 0.3, 0.75), bevel=0.0)
    m.box(lift, "graphite", (0.03, 0.64, 0.04), (0.07, 0, 0.95), bevel=0.0)
    for side in (-1, 1):
        y = side * 0.27
        m.prism(lift, "fork", [(0.05, 0.02), (1.05, 0.02), (1.17, 0.035), (1.17, 0.06), (1.07, 0.085), (0.05, 0.085)], 0.17, at=y, bevel=0.006, segs=1)
        m.cylinder(lift, "steel", 0.04, 0.12, (1.0, y, 0.045), axis="Y", segments=10)
        m.cylinder(lift, "steel", 0.018, 0.1, (1.15, y, 0.02), axis="Y", segments=8)
    m.node("load_socket", lift, (0.6, 0, 0.1))
    m.export()


# --------------------------------------------------------------------------- loads

def pallet_base(m):
    # flat, unbevelled boards: pallets are instanced by the hundred
    for y in (-0.35, 0.0, 0.35):
        m.box("root", "wood", (1.2, 0.1, 0.078), (0, y, 0.039 + 0.022), bevel=0.0)
    for x in (-0.55, 0.0, 0.55):
        m.box("root", "wood", (0.1, 0.8, 0.022), (x, 0, 0.011), bevel=0.0)
    for k in range(7):
        m.box("root", "wood", (1.2, 0.1, 0.022), (0, -0.35 + k * 0.1167, 0.133), bevel=0.0)


def build_pallet_full():
    m = Model("pallet_full", bevel_segments=1)
    pallet_base(m)
    m.box("root", "kraft", (1.18, 0.78, 1.0), (0, 0, 0.145 + 0.5), bevel=0.0)
    m.box("root", "wrap", (1.2, 0.8, 0.96), (0, 0, 0.145 + 0.52), bevel=0.02)
    for x in (-0.59, 0.59):
        for y in (-0.39, 0.39):
            m.box("root", "tint", (0.05, 0.05, 1.0), (x, y, 0.145 + 0.5), bevel=0.0)  # corner boards
    m.export()


def build_pallet_mixed():
    m = Model("pallet_mixed", {"label": "kraft"}, bevel_segments=1)
    pallet_base(m)
    cartons = [
        ((0.58, 0.38, 0.42), (-0.3, -0.2, 0.355)),
        ((0.58, 0.38, 0.36), (0.3, -0.2, 0.325)),
        ((0.58, 0.38, 0.5), (-0.3, 0.2, 0.395)),
        ((0.58, 0.38, 0.42), (0.3, 0.2, 0.355)),
        ((0.5, 0.36, 0.3), (-0.3, -0.2, 0.73)),
        ((0.55, 0.7, 0.32), (0.3, 0.0, 0.73)),
        ((0.4, 0.3, 0.26), (-0.3, 0.2, 0.775)),
    ]
    for index, (size, centre) in enumerate(cartons):
        m.box("root", "kraft" if index % 3 else "tint", size, centre, bevel=0.0)
    m.export()


# --------------------------------------------------------------------------- site fixtures

def build_dock_station():
    """Origin at the dock door centre on the outside wall face, at yard level.

    The dock slab is 1.2 m above the yard. Outward (towards the trucks) is
    Blender -Y, which becomes three.js +Z.
    """
    m = Model("dock_station", DOCK_ALIASES)
    slab = 1.2
    width, height = 3.0, 3.1
    out = -1
    # insulated wall panels around the opening, with panel seams
    m.box("root", "wall_panel", (1.2, 0.2, height + 1.6), (-(width / 2 + 0.6), 0.1, slab + (height + 1.6) / 2), bevel=0.0)
    m.box("root", "wall_panel", (1.2, 0.2, height + 1.6), ((width / 2 + 0.6), 0.1, slab + (height + 1.6) / 2), bevel=0.0)
    m.box("root", "wall_panel", (width, 0.2, 1.6), (0, 0.1, slab + height + 0.8), bevel=0.0)
    for k in range(1, 5):
        m.box("root", "steel", (width + 2.4, 0.012, 0.02), (0, -0.004, slab + k * (height + 1.6) / 5), bevel=0.0)
    # dock pit wall with a steel nosing, laminated bumpers
    m.box("root", "concrete", (width + 2.4, 0.5, slab), (0, out * 0.05, slab / 2), bevel=0.02)
    m.box("root", "steel", (width + 2.4, 0.06, 0.06), (0, out * 0.3, slab - 0.03), bevel=0.0)
    for side in (-1, 1):
        m.box("root", "rubber", (0.3, 0.16, 0.55), (side * (width / 2 - 0.22), out * 0.38, slab - 0.32), bevel=0.02, segs=1)
        m.box("root", "steel", (0.26, 0.02, 0.48), (side * (width / 2 - 0.22), out * 0.465, slab - 0.32), bevel=0.0)
        # bollards with a black band and wheel guide rails in the yard
        m.cylinder("root", "hazard_yellow", 0.1, 1.0, (side * (width / 2 + 1.0), out * 0.45, 0.5), axis="Z", segments=14)
        m.cylinder("root", "hazard_black", 0.102, 0.12, (side * (width / 2 + 1.0), out * 0.45, 0.78), axis="Z", segments=14)
        gx = side * 1.55
        m.rod("root", "hazard_yellow", (gx, out * 0.6, 0.32), (gx, out * 3.8, 0.32), 0.05, segments=8)
        m.rod("root", "hazard_yellow", (gx, out * 3.8, 0.32), (gx + side * 0.35, out * 4.5, 0.32), 0.05, segments=8)
        for y in (0.8, 2.3, 3.7):
            m.rod("root", "hazard_yellow", (gx, out * y, 0.0), (gx, out * y, 0.32), 0.045, segments=8)
    # foam shelter: side pads with guide stripes, slit head curtain
    for side in (-1, 1):
        m.box("root", "foam", (0.4, 0.95, height + 0.2), (side * (width / 2 + 0.2), out * 0.45, slab + height / 2), bevel=0.05)
        m.box("root", "hazard_yellow", (0.08, 0.02, height - 0.3), (side * (width / 2 + 0.1), out * 0.93, slab + height / 2 - 0.1), bevel=0.0)
    m.box("root", "foam", (width + 0.8, 0.95, 0.45), (0, out * 0.45, slab + height + 0.1), bevel=0.05)
    m.box("root", "hazard_yellow", (width + 0.8, 0.96, 0.08), (0, out * 0.45, slab + height - 0.15), bevel=0.0)
    for k in range(6):
        m.box("root", "foam", (width / 6 - 0.03, 0.03, 0.5), (-width / 2 + (k + 0.5) * width / 6, out * 0.9, slab + height - 0.38), bevel=0.0)
    # leveller with lip and toe guards
    leveller = m.node("leveller", "root", (0, 0, slab))
    m.box(leveller, "steel", (width - 0.4, 2.0, 0.08), (0, 1.0, slab - 0.04), bevel=0.01)
    m.box(leveller, "hazard_yellow", (0.1, 2.0, 0.085), (-(width / 2 - 0.25), 1.0, slab - 0.04), bevel=0.0)
    m.box(leveller, "hazard_yellow", (0.1, 2.0, 0.085), ((width / 2 - 0.25), 1.0, slab - 0.04), bevel=0.0)
    m.box(leveller, "steel", (width - 0.5, 0.4, 0.04), (0, out * 0.2, slab - 0.02), bevel=0.0)
    for side in (-1, 1):
        m.prism(leveller, "hazard_yellow", [(0.0, slab - 0.08), (-0.35, slab - 0.08), (0.0, slab - 0.42)], 0.02, at=side * (width / 2 - 0.22), axis="X")
    # sectional door with ribbed panels, vision windows and bottom seal (slides up into the header)
    door = m.node("door", "root", (0, 0.05, slab))
    sections = 6
    for k in range(sections):
        z = slab + (k + 0.5) * height / sections
        m.box(door, "door", (width, 0.06, height / sections - 0.02), (0, 0.05, z), bevel=0.01, segs=1)
        for dz in (-0.12, 0.12):
            m.box(door, "door", (width - 0.1, 0.012, 0.025), (0, 0.016, z + dz), bevel=0.0)
    for k in range(4):
        m.box(door, "glass", (0.55, 0.07, 0.24), (-1.05 + k * 0.7, 0.05, slab + 3.5 * height / sections), bevel=0.0)
    m.box(door, "foam", (width, 0.07, 0.05), (0, 0.05, slab + 0.025), bevel=0.0)
    for side in (-1, 1):
        m.box("root", "steel", (0.07, 0.12, height + 0.3), (side * (width / 2 + 0.06), 0.13, slab + height / 2 + 0.15), bevel=0.0)
    m.box("root", "graphite", (width + 0.3, 0.6, 0.4), (0, 0.4, slab + height + 0.25), bevel=0.03)  # header box (inside)
    m.cylinder("root", "steel", 0.05, width + 0.2, (0, 0.2, slab + height + 0.55), axis="X", segments=10)
    # traffic light outside with visors
    tx = width / 2 + 0.75
    m.box("root", "graphite", (0.24, 0.16, 0.6), (tx, out * 0.12, slab + 1.4), bevel=0.02)
    for z in (1.53, 1.27):
        m.box("root", "graphite", (0.18, 0.12, 0.025), (tx, out * 0.25, slab + z + 0.1), bevel=0.0)
    red = m.node("signal_red", "root", (tx, out * 0.2, slab + 1.53))
    m.cylinder(red, "signal_red", 0.07, 0.04, (tx, out * 0.2, slab + 1.53), axis="Y", segments=14)
    green = m.node("signal_green", "root", (tx, out * 0.2, slab + 1.27))
    m.cylinder(green, "signal_green", 0.07, 0.04, (tx, out * 0.2, slab + 1.27), axis="Y", segments=14)
    # LED floodlight over the door, control box and wheel chock
    m.box("root", "graphite", (0.55, 0.3, 0.1), (0, out * 0.25, slab + height + 0.62), bevel=0.02)
    m.box("root", "lamp_white", (0.48, 0.24, 0.02), (0, out * 0.25, slab + height + 0.565), bevel=0.0)
    m.box("root", "door", (0.36, 0.18, 0.5), (-(width / 2 + 0.6), 0.29, slab + 1.3), bevel=0.02, segs=1)
    m.cylinder("root", "hazard_yellow", 0.035, 0.03, (-(width / 2 + 0.6), 0.39, slab + 1.42), axis="Y", segments=10)
    m.cylinder("root", "signal_red", 0.035, 0.03, (-(width / 2 + 0.6), 0.39, slab + 1.3), axis="Y", segments=10)
    m.prism("root", "hazard_yellow", [(0.0, 0.0), (-0.38, 0.0), (-0.06, 0.24), (0.0, 0.24)], 0.2, at=width / 2 + 0.35, axis="X")
    m.export()


def build_barrier():
    """Boom barrier: steel cabinet, red/white aluminium boom with LEDs and a
    rubber skirt, fixed boom rest at the far end."""
    m = Model("barrier")
    m.box("root", "concrete", (0.7, 0.6, 0.1), (0, 0, 0.05), bevel=0.0)
    m.box("root", "hazard_yellow", (0.34, 0.32, 0.95), (-0.02, 0, 0.575), bevel=0.03)
    m.box("root", "graphite", (0.38, 0.36, 0.04), (-0.02, 0, 1.07), bevel=0.015, segs=1)
    for x in (-0.14, 0.1):
        m.box("root", "graphite", (0.012, 0.006, 0.75), (x, -0.162, 0.55), bevel=0.0)
    for z in (0.17, 0.92):
        m.box("root", "graphite", (0.25, 0.006, 0.012), (-0.02, -0.162, z), bevel=0.0)
    m.cylinder("root", "steel", 0.018, 0.02, (0.06, -0.165, 0.7), axis="Y", segments=8)
    for k in range(4):
        m.box("root", "graphite", (0.2, 0.006, 0.015), (-0.02, 0.162, 0.3 + k * 0.05), bevel=0.0)
    arm = m.node("arm", "root", (0.1, 0, 0.95))
    m.box(arm, "graphite", (0.16, 0.22, 0.24), (0.16, 0, 0.95), bevel=0.02, segs=1)
    m.cylinder(arm, "steel", 0.06, 0.26, (0.1, 0, 0.95), axis="Y", segments=14)
    for k in range(8):
        m.box(arm, "red_white_r" if k % 2 == 0 else "red_white_w", (0.52, 0.08, 0.11), (0.5 + k * 0.52, 0, 0.95), bevel=0.012, segs=1)
    m.box(arm, "graphite", (4.16, 0.03, 0.04), (2.32, 0, 0.875), bevel=0.0)
    for x in (1.4, 2.8, 4.3):
        m.box(arm, "lamp_red", (0.06, 0.085, 0.03), (x, 0, 1.01), bevel=0.0)
    # boom rest
    m.box("root", "concrete", (0.3, 0.3, 0.06), (4.0, 0, 0.03), bevel=0.0)
    m.box("root", "hazard_yellow", (0.08, 0.08, 0.8), (4.0, 0, 0.46), bevel=0.0)
    m.box("root", "graphite", (0.08, 0.2, 0.03), (4.0, 0, 0.865), bevel=0.0)
    for s in (-1, 1):
        m.box("root", "graphite", (0.06, 0.03, 0.14), (4.0, s * 0.075, 0.93), bevel=0.0)
    m.export()


def build_gatehouse():
    """Security booth (glazed above a solid dado, door, AC unit, bollards,
    intercom) under a lane canopy that spans both gate lanes."""
    m = Model("gatehouse", {"rubber": "graphite", "hazard_black": "graphite"})
    m.box("root", "concrete", (3.2, 1.6, 0.18), (0, 0, 0.09), bevel=0.03)  # island
    m.box("root", "hazard_yellow", (0.25, 1.6, 0.2), (1.55, 0, 0.1), bevel=0.0)
    m.box("root", "hazard_yellow", (0.25, 1.6, 0.2), (-1.55, 0, 0.1), bevel=0.0)
    m.box("root", "wall_panel", (2.2, 1.3, 0.9), (0, 0, 0.63), bevel=0.03)
    for x in (-1.08, 1.08):
        for y in (-0.63, 0.63):
            m.box("root", "graphite", (0.07, 0.07, 1.32), (x, y, 1.74), bevel=0.0)
    m.box("root", "graphite", (2.22, 1.32, 0.05), (0, 0, 1.1), bevel=0.0)  # sill
    for y in (-0.64, 0.64):
        m.box("root", "glass", (2.1, 0.02, 1.25), (0, y, 1.73), bevel=0.0)
        for x in (-0.36, 0.36):
            m.box("root", "graphite", (0.04, 0.03, 1.25), (x, y, 1.73), bevel=0.0)
    m.box("root", "glass", (0.02, 1.2, 1.25), (-1.09, 0, 1.73), bevel=0.0)
    m.box("root", "glass", (0.02, 0.35, 1.25), (1.09, -0.4, 1.73), bevel=0.0)
    m.box("root", "door", (0.04, 0.78, 2.1), (1.1, 0.2, 1.23), bevel=0.0)
    m.box("root", "glass", (0.045, 0.5, 0.6), (1.1, 0.2, 1.75), bevel=0.0)
    m.box("root", "graphite", (0.06, 0.04, 0.16), (1.13, -0.1, 1.2), bevel=0.0)
    m.box("root", "wall_panel", (2.2, 1.3, 0.14), (0, 0, 2.43), bevel=0.0)
    m.box("root", "canopy", (2.8, 1.8, 0.16), (0, 0, 2.58), bevel=0.04)
    m.box("root", "door", (0.24, 0.7, 0.45), (-1.24, 0, 2.0), bevel=0.02, segs=1)  # AC unit
    m.cylinder("root", "graphite", 0.16, 0.02, (-1.37, 0, 2.0), axis="X", segments=16)
    m.rod("root", "graphite", (-1.11, 0.66, 0.2), (-1.11, 0.66, 2.5), 0.03, segments=8)  # downpipe
    for x in (-1.45, 1.45):
        for y in (-0.6, 0.6):
            m.cylinder("root", "hazard_yellow", 0.09, 0.9, (x, y, 0.63), axis="Z", segments=12)
            m.cylinder("root", "graphite", 0.092, 0.08, (x, y, 0.95), axis="Z", segments=12)
    m.box("root", "graphite", (0.22, 0.2, 1.2), (1.2, -0.62, 0.78), bevel=0.02, segs=1)  # intercom pedestal
    m.box("root", "glass", (0.15, 0.02, 0.12), (1.2, -0.73, 1.2), bevel=0.0)
    # lane canopy spanning both gate lanes
    for x in (-2.5, 2.5):
        for y in (-4.6, 4.6):
            m.box("root", "concrete", (0.5, 0.5, 0.2), (x, y, 0.1), bevel=0.02, segs=1)
            m.box("root", "steel", (0.22, 0.22, 5.2), (x, y, 2.8), bevel=0.02)
    m.box("root", "canopy", (6.3, 10.1, 0.55), (0, 0, 5.6), bevel=0.05)
    m.box("root", "wall_panel", (6.32, 10.12, 0.08), (0, 0, 5.72), bevel=0.0)
    m.box("root", "wall_panel", (6.1, 9.9, 0.02), (0, 0, 5.32), bevel=0.0)
    for y in (-3.4, -2.2, 2.2, 3.4):
        m.box("root", "lamp_white", (5.0, 0.3, 0.05), (0, y, 5.3), bevel=0.0)
    m.box("root", "graphite", (0.14, 0.1, 0.1), (2.5, -4.45, 4.9), bevel=0.0)  # camera
    m.export()


def build_worker():
    """Warehouse worker, 1.75 m: hi-vis vest, hard hat (per-instance colour), swinging arms and legs."""
    m = Model("worker", bevel_segments=1)
    for side, tag in ((1, "l"), (-1, "r")):
        leg = m.node(f"leg_{tag}", "root", (0, side * 0.1, 0.9))
        m.box(leg, "navy", (0.16, 0.15, 0.82), (0, side * 0.1, 0.49), bevel=0.0)
        m.box(leg, "rubber", (0.26, 0.15, 0.1), (0.04, side * 0.1, 0.05), bevel=0.0)
        arm = m.node(f"arm_{tag}", "root", (0, side * 0.25, 1.42))
        m.box(arm, "hivis", (0.13, 0.12, 0.3), (0, side * 0.25, 1.28), bevel=0.0)
        m.box(arm, "navy", (0.11, 0.1, 0.32), (0, side * 0.25, 0.98), bevel=0.0)
        m.box(arm, "skin", (0.1, 0.09, 0.09), (0, side * 0.25, 0.8), bevel=0.0)
    m.box("root", "hivis", (0.28, 0.42, 0.58), (0, 0, 1.2), bevel=0.03)
    for z in (1.05, 1.25):
        m.box("root", "reflect", (0.29, 0.43, 0.04), (0, 0, z), bevel=0.0)
    m.cylinder("root", "skin", 0.05, 0.1, (0, 0, 1.54), axis="Z", segments=8)
    m.cylinder("root", "skin", 0.11, 0.22, (0, 0, 1.66), axis="Z", segments=10)
    m.cylinder("root", "tint_hat", 0.135, 0.09, (0.01, 0, 1.79), axis="Z", segments=12)
    m.box("root", "tint_hat", (0.16, 0.24, 0.02), (0.1, 0, 1.75), bevel=0.0)
    m.export()


BUILDERS = {
    # 20 ft: medium-duty day cab (Tata LPT/Ultra class), single drive axle
    "truck_20": lambda: build_rigid("truck_20", 8.6, 6.1, (1.9,), cab_length=1.95, cab_width=2.3, roof=2.9, sleeper=False, front_overhang=1.2, wheel_r=0.48),
    # 32 ft: heavy sleeper cab (Signa class), tandem rear
    "truck_32": lambda: build_rigid("truck_32", 11.6, 9.3, (2.3, 3.6), cab_length=2.15, cab_width=2.44, roof=3.1, sleeper=True, front_overhang=1.3, wheel_r=0.5),
    "tractor": build_tractor,
    "trailer_40": build_trailer,
    "reach_truck": build_reach_truck,
    "forklift": build_forklift,
    "pallet_truck": build_pallet_truck,
    "pallet_full": build_pallet_full,
    "pallet_mixed": build_pallet_mixed,
    "dock_station": build_dock_station,
    "barrier": build_barrier,
    "gatehouse": build_gatehouse,
    "worker": build_worker,
}

# Optional: build only some items (ids after the output folders), e.g. -- tools/blender/out "" forklift
ONLY = [arg for arg in ARGS[2:] if arg in BUILDERS]
if len(ARGS) > 1 and not ARGS[1]:
    PREVIEW_DIR = None
for item_id, builder in BUILDERS.items():
    if not ONLY or item_id in ONLY:
        builder()
print("BUILD_COMPLETE")
