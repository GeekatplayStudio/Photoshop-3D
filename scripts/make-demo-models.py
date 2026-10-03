# Makes the demo models used for the bundled sample and the Marketplace screenshots: original,
# simple models with materials, so no third-party design appears in the listing.
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python scripts/make-demo-models.py
# Writes tests/fixtures/public/samples/demo/{rocket,vase,mushroom}.glb and plugin/samples/sample-rocket.glb.
import math
import os
import shutil

import bpy

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "tests", "fixtures", "public", "samples", "demo")
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness=0.5, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return m


def smooth(obj, bevel=0.0, subsurf=0):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    if subsurf:
        mod = obj.modifiers.new("subsurf", "SUBSURF")
        mod.levels = subsurf
        mod.render_levels = subsurf
    bpy.ops.object.shade_smooth()
    obj.select_set(False)


def spline(points, steps=10):
    """Catmull-Rom curve through (radius, height) points, for smooth silhouettes."""
    pts = [points[0]] + list(points) + [points[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for k in range(steps):
            t = k / steps
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in range(2)))
    out.append(points[-1])
    return [(max(0.0, r), z) for r, z in out]


def lathe(name, profile, segments=96):
    """A solid of revolution from (radius, height) points."""
    verts = []
    faces = []
    n = len(profile)
    for s in range(segments):
        a = 2 * math.pi * s / segments
        for r, z in profile:
            verts.append((r * math.cos(a), r * math.sin(a), z))
    for s in range(segments):
        s2 = (s + 1) % segments
        for i in range(n - 1):
            faces.append((s * n + i, s2 * n + i, s2 * n + i + 1, s * n + i + 1))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def export(name):
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=False, export_apply=True)
    return path


# ---------------------------------------------------------------- toy rocket
reset()
cream = material("Hull", (0.93, 0.9, 0.84), 0.35)
red = material("Paint", (0.86, 0.16, 0.14), 0.3)
glass = material("Window", (0.15, 0.55, 0.95), 0.08, 0.2)
steel = material("Steel", (0.75, 0.77, 0.8), 0.25, 0.9)
body = lathe("Body", spline([(0.0, 0.0), (0.3, 0.02), (0.37, 0.25), (0.41, 0.7), (0.4, 1.05), (0.34, 1.4), (0.22, 1.68), (0.0, 1.86)]))
body.data.materials.append(cream)
smooth(body)
nose = lathe("Nose", spline([(0.0, 1.6), (0.27, 1.6), (0.24, 1.72), (0.15, 1.88), (0.0, 2.04)]))
nose.data.materials.append(red)
smooth(nose)
nozzle = lathe("Nozzle", [(0.0, 0.05), (0.2, 0.05), (0.26, -0.12), (0.22, -0.14), (0.0, -0.1)])
nozzle.data.materials.append(steel)
smooth(nozzle)
bpy.ops.mesh.primitive_torus_add(major_radius=0.14, minor_radius=0.035, location=(0, -0.39, 1.15), rotation=(math.pi / 2, 0, 0))
ring = bpy.context.active_object
ring.data.materials.append(steel)
smooth(ring)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, -0.36, 1.15), scale=(1, 0.45, 1))
window = bpy.context.active_object
window.data.materials.append(glass)
smooth(window)
for i in range(3):
    a = i * 2 * math.pi / 3
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.5 * math.cos(a), 0.5 * math.sin(a), 0.25), rotation=(0, 0, a), scale=(0.28, 0.035, 0.32))
    fin = bpy.context.active_object
    fin.data.materials.append(red)
    smooth(fin, bevel=0.02)
for o in bpy.data.objects:
    o.rotation_mode = "XYZ"
rocket = export("rocket")

# ---------------------------------------------------------------- ceramic vase
reset()
glaze = material("Glaze", (0.05, 0.5, 0.52), 0.12)
clay = material("Clay", (0.72, 0.45, 0.3), 0.85)
prof = [(0.0, 0.0), (0.3, 0.0), (0.42, 0.15), (0.55, 0.55), (0.5, 0.9), (0.26, 1.2), (0.22, 1.45), (0.3, 1.6), (0.27, 1.62), (0.19, 1.47), (0.2, 1.22), (0.44, 0.92), (0.49, 0.56), (0.37, 0.18), (0.0, 0.06)]
vase = lathe("Vase", spline(prof, 6))
vase.data.materials.append(glaze)
smooth(vase)
foot = lathe("Foot", [(0.0, -0.06), (0.31, -0.06), (0.31, 0.01), (0.0, 0.01)])
foot.data.materials.append(clay)
smooth(foot)
export("vase")

# ---------------------------------------------------------------- mushroom
reset()
stem_m = material("Stem", (0.95, 0.9, 0.78), 0.6)
cap_m = material("Cap", (0.8, 0.12, 0.1), 0.35)
dot_m = material("Spots", (0.98, 0.97, 0.94), 0.5)
stem = lathe("Stem", [(0.0, 0.0), (0.24, 0.0), (0.2, 0.3), (0.17, 0.7), (0.2, 0.85), (0.0, 0.9)])
stem.data.materials.append(stem_m)
smooth(stem)
cap = lathe("Cap", spline([(0.0, 0.78), (0.7, 0.78), (0.72, 0.84), (0.62, 1.05), (0.4, 1.22), (0.0, 1.3)]))
cap.data.materials.append(cap_m)
smooth(cap)
for i, (a, h) in enumerate([(0.3, 1.18), (1.4, 1.1), (2.6, 1.0), (3.6, 1.15), (4.7, 1.02), (5.6, 1.12), (0.9, 0.95)]):
    r = math.sqrt(max(0.0, 1 - ((h - 0.78) / 0.52) ** 2)) * 0.66
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.07, location=(r * math.cos(a), r * math.sin(a), h), scale=(1, 1, 0.45))
    dot = bpy.context.active_object
    dot.data.materials.append(dot_m)
    smooth(dot)
export("mushroom")

os.makedirs(os.path.join(ROOT, "plugin", "samples"), exist_ok=True)
shutil.copyfile(rocket, os.path.join(ROOT, "plugin", "samples", "sample-rocket.glb"))
print("Demo models written to", OUT)
