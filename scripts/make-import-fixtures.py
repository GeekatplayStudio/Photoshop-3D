# Generates tests/fixtures/public/samples/import/*: a textured cube in the formats the library
# imports, made with Blender so they look like real-world files (external textures, MTL, ...).
#   "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python scripts/make-import-fixtures.py
# The files are committed; this script only needs to run when the fixtures change.
import os
import bpy

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "public", "samples", "import")
os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

# 64×64 checker texture saved next to the models (textures/checker.png).
size = 64
img = bpy.data.images.new("checker", size, size, alpha=False)
px = []
for y in range(size):
    for x in range(size):
        on = ((x // 8) + (y // 8)) % 2 == 0
        px += [0.95, 0.55, 0.1, 1.0] if on else [0.1, 0.35, 0.9, 1.0]
img.pixels = px
img.filepath_raw = os.path.join(OUT, "textures", "checker.png")
img.file_format = "PNG"
img.save()

bpy.ops.mesh.primitive_cube_add(size=1.0)
cube = bpy.context.active_object
cube.name = "TexturedCube"
bpy.ops.object.shade_flat()
mat = bpy.data.materials.new("Checker")
mat.use_nodes = True
nodes = mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")
tex = nodes.new("ShaderNodeTexImage")
tex.image = img
mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
cube.data.materials.append(mat)


def path(name):
    return os.path.join(OUT, name)


bpy.ops.export_scene.fbx(filepath=path("cube.fbx"), use_selection=True, path_mode="RELATIVE", embed_textures=False)
bpy.ops.wm.obj_export(filepath=path("cube.obj"), export_selected_objects=True, export_materials=True, path_mode="RELATIVE")
bpy.ops.export_scene.gltf(filepath=path("cube.gltf"), export_format="GLTF_SEPARATE", use_selection=True, export_texture_dir="textures")
bpy.ops.wm.stl_export(filepath=path("cube.stl"), export_selected_objects=True)
bpy.ops.wm.ply_export(filepath=path("cube.ply"), export_selected_objects=True)
bpy.ops.wm.usd_export(filepath=path("cube.usdz"), selected_objects_only=True)
print("Fixtures written to", OUT)
