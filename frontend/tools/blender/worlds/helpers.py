# Builds Yardline hero assets in Blender and exports one GLB.
# Coordinates are written in glTF/three.js space (y up, truck front = +z) via G().
import bpy, bmesh, math, sys
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)

def lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def mat(name, hexv, rough=0.6, metal=0.0, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    r, g, bl = (hexv >> 16) & 255, (hexv >> 8) & 255, hexv & 255
    col = (lin(r), lin(g), lin(bl), 1)
    b.inputs['Base Color'].default_value = col
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit > 0:
        b.inputs['Emission Color'].default_value = col
        b.inputs['Emission Strength'].default_value = emit
    return m

M = {
    'Body': mat('Body', 0xF2793A, 0.42),
    'White': mat('White', 0xF7F8FC, 0.5),
    'Trim': mat('Trim', 0xD5DAE8, 0.45, 0.2),
    'Dark': mat('Dark', 0x2B3047, 0.8),
    'Tire': mat('Tire', 0x23273A, 0.92),
    'Chrome': mat('Chrome', 0xCDD3E3, 0.25, 0.8),
    'Glass': mat('Glass', 0x1B2340, 0.12, 0.3),
    'Lamp': mat('Lamp', 0xFFF4D6, 0.3, 0.0, 1.5),
    'Red': mat('Red', 0xE0473E, 0.35, 0.0, 0.8),
    'Rear': mat('Rear', 0xE4E7F1, 0.55),
    'Yellow': mat('Yellow', 0xF5B82E, 0.4),
    'YellowDk': mat('YellowDk', 0xDB9612, 0.45),
    'Steel': mat('Steel', 0x4A5070, 0.5, 0.4),
    'Orange': mat('Orange', 0xFF8A3D, 0.3, 0.0, 2.0),
    'Wood': mat('Wood', 0xC0925F, 0.85),
    'Card': mat('Card', 0xFFFFFF, 0.78),
    'Tape': mat('Tape', 0xE9D2A7, 0.5),
}

def G(x, y, z):
    """glTF (x, y up, z forward) -> Blender (x, -z, y)."""
    return (x, -z, y)

def smooth(o, angle=35):
    if hasattr(o.data, "use_auto_smooth"):  # Blender 4.0 and older
        o.data.use_auto_smooth = True
        o.data.auto_smooth_angle = math.radians(angle)
        for p in o.data.polygons:
            p.use_smooth = True
    elif hasattr(o.data, "shade_smooth_by_angle"):  # Blender 4.1+: auto smooth became shading by angle
        o.data.shade_smooth_by_angle(angle=math.radians(angle))
    else:
        for p in o.data.polygons:
            p.use_smooth = True

def finish(o, name, m, bevel, seg, parent):
    o.name = name
    o.data.materials.clear()
    o.data.materials.append(M[m])
    if bevel > 0:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
        b.harden_normals = True
    smooth(o)
    if parent:
        o.parent = parent
    return o

def box(name, w, h, d, at, m, bevel=0.06, seg=3, parent=None, taper=None, shear=None):
    """w = x size, h = height, d = length along the truck. at = glTF centre."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=G(*at))
    o = bpy.context.active_object
    o.scale = (w, d, h)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if taper:  # (dz) move top-front edge back by dz (front = -Y in Blender)
        bm = bmesh.new(); bm.from_mesh(o.data)
        for v in bm.verts:
            if v.co.z > 0 and v.co.y < 0:
                v.co.y += taper
        bm.to_mesh(o.data); bm.free()
    if shear:  # lean the whole box back: top moves +Y (back), bottom moves -Y
        bm = bmesh.new(); bm.from_mesh(o.data)
        for v in bm.verts:
            v.co.y += shear * (v.co.z / h)
        bm.to_mesh(o.data); bm.free()
    return finish(o, name, m, bevel, seg, parent)

def cyl(name, r, depth, at, axis, m, verts=32, bevel=0.0, seg=3, parent=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=G(*at))
    o = bpy.context.active_object
    if axis == 'x':
        o.rotation_euler = (0, math.radians(90), 0)
    elif axis == 'z':   # along truck length (Blender Y)
        o.rotation_euler = (math.radians(90), 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return finish(o, name, m, bevel, seg, parent)

def empty(name, parent=None):
    bpy.ops.object.empty_add(location=(0, 0, 0))
    e = bpy.context.active_object
    e.name = name
    if parent:
        e.parent = parent
    return e

