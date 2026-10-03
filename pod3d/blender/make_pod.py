"""Blender asset pipeline for the Set Up Pod table.

  blender -b -P make_pod.py -- table|spire|crest

Builds one piece, bakes its wood grain x ambient occlusion into a texture
(rotation-proof: no baked light direction, because thrones swivel and the
table spins at runtime), and exports pod-<piece>.glb. Gold, leather and gems
stay flat PBR materials; the app lights them live.
"""
import bpy, bmesh, math, os, sys
import numpy as np

PIECE = sys.argv[sys.argv.index("--") + 1]
OUT = os.path.dirname(os.path.abspath(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
TOP = 1.0

def hexc(h, a=1):
    h = h.lstrip('#'); r, g, b = (int(h[i:i+2], 16)/255 for i in (0, 2, 4))
    f = lambda c: ((c+0.055)/1.055)**2.4 if c > 0.04045 else c/12.92
    return (f(r), f(g), f(b), a)

def mat(name, color, rough=0.5, metal=0.0, emit=None, strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hexc(color)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = hexc(emit)
        b.inputs["Emission Strength"].default_value = strength
    return m

def wood(name, c1, c2, scale=3.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    n = m.node_tree.nodes; l = m.node_tree.links
    b = n["Principled BSDF"]; b.inputs["Roughness"].default_value = 0.5
    tc = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale*0.3, scale)
    w = n.new("ShaderNodeTexWave"); w.wave_type = 'BANDS'
    w.inputs["Scale"].default_value = 4; w.inputs["Distortion"].default_value = 7
    w.inputs["Detail"].default_value = 3
    cr = n.new("ShaderNodeValToRGB")
    cr.color_ramp.elements[0].color = hexc(c1); cr.color_ramp.elements[1].color = hexc(c2)
    l.new(tc.outputs["Object"], mp.inputs["Vector"]); l.new(mp.outputs["Vector"], w.inputs["Vector"])
    l.new(w.outputs["Color"], cr.inputs["Fac"]); l.new(cr.outputs["Color"], b.inputs["Base Color"])
    return m

M_OAK   = wood("Oak", "#5e3d2a", "#976b4c")
M_DEEP  = wood("OakDeep", "#2f1d13", "#5e3d2a", 2.0)
M_GOLD  = mat("Gold", "#d4a63a", rough=0.28, metal=1.0)
M_BRASS = mat("Brass", "#8a6a2a", rough=0.4, metal=1.0)
M_DARK  = mat("Seam", "#1d120b", rough=0.8)
M_LEATH = mat("Leather", "#35204a", rough=0.55)
M_GEMV  = mat("RuneGem", "#b59cff", rough=0.1, emit="#b59cff", strength=3)
M_WELL  = mat("Well", "#7b5cff", rough=0.3, emit="#7b5cff", strength=2)
MANA = {k: mat("Mana"+k, c, rough=0.1, emit=e, strength=2.5) for k, c, e in (
    ("W", "#f6f1c8", "#fff6c0"), ("U", "#0e68ab", "#1b8cff"), ("B", "#150b14", "#6b2b8a"),
    ("R", "#d3202a", "#ff2a1a"), ("G", "#00733e", "#17d36a"))}

def finish(o, m, smooth=True, bev=None):
    o.data.materials.append(m)
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
    if bev:
        md = o.modifiers.new("bev", 'BEVEL'); md.width = bev; md.segments = 2
    return o

def cyl(name, r, h, loc, m, verts=96, bev=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=verts, location=loc)
    o = bpy.context.object; o.name = name; return finish(o, m, bev=bev)

def torus(name, R, r, loc, m, minor=12):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=96,
                                     minor_segments=minor, location=loc)
    o = bpy.context.object; o.name = name; return finish(o, m)

def sphere(name, r, loc, m, scale=(1, 1, 1), seg=24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=seg, ring_count=seg//2, location=loc)
    o = bpy.context.object; o.name = name; o.scale = scale
    bpy.ops.object.transform_apply(scale=True); return finish(o, m)

def box(name, size, loc, m, rot=(0, 0, 0), bev=None):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.object; o.name = name; o.scale = (size[0]/2, size[1]/2, size[2]/2)
    bpy.ops.object.transform_apply(scale=True); return finish(o, m, bev=bev)

def apply_all():
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.objects:
        if o.type == 'MESH': o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target='MESH')

def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join(); o = bpy.context.object; o.name = name; return o

# ---------------- pieces ----------------
wood_objs, gold_objs, brass_objs, dark_objs, leath_objs, gem_objs = [], [], [], [], [], []

def build_table():
    R = 2.4; HOLE = 0.34*R
    top = cyl("Top", R, 0.2, (0, 0, TOP-0.1), M_OAK, bev=0.035)
    cut = cyl("Cut", HOLE, 0.5, (0, 0, TOP-0.1), M_OAK, 96)
    bm = top.modifiers.new("hole", 'BOOLEAN'); bm.operation = 'DIFFERENCE'; bm.object = cut
    bpy.context.view_layer.objects.active = top
    bpy.ops.object.modifier_apply(modifier="hole"); bpy.data.objects.remove(cut)
    md = top.modifiers.new("bev", 'BEVEL'); md.width = 0.03; md.segments = 3; md.limit_method = 'ANGLE'
    wood_objs.append(top)
    wood_objs.append(cyl("Apron", 2.15, 0.22, (0, 0, TOP-0.31), M_DEEP, bev=0.03))
    wood_objs.append(cyl("Column", 0.38, 0.8, (0, 0, 0.5), M_DEEP, 48, bev=0.03))
    wood_objs.append(cyl("Foot", 0.9, 0.12, (0, 0, 0.06), M_DEEP, 64, bev=0.04))
    gold_objs.append(torus("ColumnBand", 0.39, 0.03, (0, 0, 0.78), M_GOLD))
    for i in range(6):                                  # six legs, as in the CSS table
        a = math.radians(30 + i*60); x, y = 1.7*math.cos(a), 1.7*math.sin(a)
        wood_objs.append(cyl("Leg", 0.13, 0.84, (x, y, 0.48), M_DEEP, 32, bev=0.02))
        gold_objs.append(torus("LegBand", 0.135, 0.02, (x, y, 0.89), M_GOLD))
        gold_objs.append(torus("LegBand2", 0.135, 0.02, (x, y, 0.25), M_GOLD))
        brass_objs.append(sphere("LegFoot", 0.16, (x, y, 0.1), M_BRASS, scale=(1, 1, 0.6)))
    # inlay: lip of the well, groove between the bands, border, studs
    gold_objs.append(torus("Lip", HOLE+0.01, 0.022, (0, 0, TOP+0.003), M_GOLD))
    gold_objs.append(torus("Groove1", 1.30, 0.012, (0, 0, TOP+0.0), M_GOLD))
    gold_objs.append(torus("Groove2", 2.126, 0.015, (0, 0, TOP+0.0), M_GOLD))
    gold_objs.append(torus("Border", 2.36, 0.028, (0, 0, TOP-0.01), M_GOLD))
    for i in range(40):
        a = i*math.tau/40
        gold_objs.append(sphere("Stud", 0.034, (2.25*math.cos(a), 2.25*math.sin(a), TOP+0.0), M_GOLD, seg=10))
    for k in range(8):                                  # plank seams + a carved diamond per outer plank
        for deg, r1, r2 in ((22.5+k*45, HOLE+0.02, 1.30), (k*45, 1.30, 2.126)):
            a = math.radians(deg); rm = (r1+r2)/2
            dark_objs.append(box("Seam", (r2-r1, 0.012, 0.01), (rm*math.cos(a), rm*math.sin(a), TOP+0.0), M_DARK, rot=(0, 0, a)))
        a = math.radians(22.5+k*45)
        gold_objs.append(box("Scroll", (0.11, 0.11, 0.012), (1.71*math.cos(a), 1.71*math.sin(a), TOP+0.002), M_GOLD, rot=(0, 0, a+math.pi/4)))
    for i, k in enumerate("WUBRG"):                     # mana gems set in the outer band
        a = math.radians(90 - i*72 + 36)
        x, y = 1.97*math.cos(a), 1.97*math.sin(a)
        gem_objs.append(sphere("Gem"+k, 0.085, (x, y, TOP+0.012), MANA[k], scale=(1, 1, 0.55)))
        gold_objs.append(torus("Set"+k, 0.092, 0.016, (x, y, TOP+0.012), M_GOLD))
    well = cyl("Well", HOLE-0.02, 0.01, (0, 0, TOP-0.165), M_WELL, 64)
    return well

def throne(crest):
    SPIRE = [(50,0),(53,6),(57,8),(65,12),(75,19),(85,29),(92,40),(97,52),(100,63),(100,100),(0,100),(0,63),(3,52),(8,40),(15,29),(25,19),(35,12),(43,8),(47,6)]
    CREST = [(0,100),(0,30),(4,24),(12,22),(16,15),(26,11),(34,6),(42,3),(50,0),(58,3),(66,6),(74,11),(84,15),(88,22),(96,24),(100,30),(100,100)]
    def prism(name, prof, W, Hh, zb, y0, depth, m, inset=1.0, lift=0.0):
        pts = [((px/100-0.5)*W*inset, zb + lift + ((1-py/100)*Hh)*inset) for px, py in prof]
        bm = bmesh.new(); vs = [bm.verts.new((x, y0, z)) for x, z in pts]
        f = bm.faces.new(vs)
        r = bmesh.ops.extrude_face_region(bm, geom=[f])
        bmesh.ops.translate(bm, verts=[e for e in r["geom"] if isinstance(e, bmesh.types.BMVert)], vec=(0, depth, 0))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new(name, me); sc.collection.objects.link(o)
        return finish(o, m, smooth=False, bev=0.008)
    SW, SD, SH = 0.64, 0.58, 0.60
    for sx in (-1, 1):
        for sy in (-1, 1):
            wood_objs.append(box("Leg", (0.07, 0.07, SH), (sx*(SW/2-0.035), sy*(SD/2-0.035), SH/2), M_OAK, bev=0.01))
        wood_objs.append(box("Rail", (0.04, SD-0.1, 0.05), (sx*(SW/2-0.035), 0, 0.2), M_OAK, bev=0.008))
    wood_objs.append(box("Frame", (SW, SD, 0.07), (0, 0, SH+0.035), M_OAK, bev=0.015))
    leath_objs.append(box("Seat", (SW-0.1, SD-0.1, 0.07), (0, -0.01, SH+0.085), M_LEATH, bev=0.025))
    for sx in (-1, 1):
        wood_objs.append(box("ArmPost", (0.06, 0.06, 0.34), (sx*(SW/2-0.03), -SD/2+0.06, SH+0.07+0.17), M_OAK, bev=0.01))
        wood_objs.append(box("Arm", (0.09, SD, 0.05), (sx*(SW/2-0.03), 0, SH+0.07+0.34), M_OAK, bev=0.015))
    bw, bh, zb, yb = SW+0.04, 1.3, SH+0.07, SD/2-0.07
    prof = CREST if crest else SPIRE
    wood_objs.append(prism("BackEdge", prof, bw, bh, zb, yb, 0.07, M_OAK))
    wood_objs.append(prism("BackOak", prof, bw, bh, zb, yb-0.012, 0.07, M_DEEP, inset=0.93))
    leath_objs.append(prism("BackLeather", prof, bw, bh, zb, yb-0.02, 0.07, M_LEATH, inset=0.78, lift=0.09))
    gem_objs.append(box("RuneGem", (0.07, 0.025, 0.07), (0, yb-0.03, zb+bh*0.74), M_GEMV, rot=(0, math.radians(45), 0)))

def unwrap(o, size):
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')

def srgb2lin(c):
    c = np.clip(c, 0, 1); return np.where(c <= 0.04045, c/12.92, ((c+0.055)/1.055)**2.4)

def hexrgb(h):
    h = h.lstrip('#'); return np.array([int(h[i:i+2], 16)/255 for i in (0, 2, 4)])

def vnoise(p):
    """Vectorised 3D value noise, p: (...,3) -> (...)"""
    i = np.floor(p); f = p - i; f = f*f*(3-2*f)
    def h(ix, iy, iz):
        v = np.sin(ix*127.1 + iy*311.7 + iz*74.7) * 43758.5453
        return v - np.floor(v)
    x, y, z = i[..., 0], i[..., 1], i[..., 2]; fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    def lerp(a, b, t): return a + (b-a)*t
    c00 = lerp(h(x, y, z), h(x+1, y, z), fx);     c10 = lerp(h(x, y+1, z), h(x+1, y+1, z), fx)
    c01 = lerp(h(x, y, z+1), h(x+1, y, z+1), fx); c11 = lerp(h(x, y+1, z+1), h(x+1, y+1, z+1), fx)
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)

PAL = {"Oak": ("#8c6246", "#c4997a", 3.0), "OakDeep": ("#53372a", "#8c6246", 2.0)}
def wood_color(pos, midx, names):
    out = np.zeros(pos.shape[:-1] + (3,))
    for k, name in enumerate(names):
        c1, c2, sc_ = PAL[name]; sel = midx == k
        if not sel.any(): continue
        p = pos[sel] * sc_
        warp = vnoise(p*0.7) + 0.4*vnoise(p*1.9)
        rings = np.sin(6.2832 * (p[:, 0]*4.2 + p[:, 2]*1.1 + warp*0.9))
        t = np.clip(0.5 + 0.5*rings, 0, 1); t = 0.5 + 0.5*t*t*(3-2*t)
        streak = 0.93 + 0.14*vnoise(np.stack([p[:, 0]*30, p[:, 1]*2.5, p[:, 2]*4.0], -1))
        col = (hexrgb(c1)[None]*(1-t[:, None]) + hexrgb(c2)[None]*t[:, None]) * streak[:, None]
        out[sel] = col
    return out

def raster(o, size):
    """UV-space rasterisation: per texel the world position, normal and material slot."""
    me = o.data; me.calc_loop_triangles(); uv = me.uv_layers.active.data
    mw = o.matrix_world; mn = mw.to_3x3()
    mask = np.zeros((size, size), bool); P = np.zeros((size, size, 3), np.float32)
    N = np.zeros((size, size, 3), np.float32); M = np.zeros((size, size), np.int16)
    co = me.vertices
    for t in me.loop_triangles:
        uvs = np.array([uv[l].uv[:] for l in t.loops]) * size
        mn_, mx_ = np.floor(uvs.min(0)).astype(int) - 1, np.ceil(uvs.max(0)).astype(int) + 1
        x0, y0 = max(mn_[0], 0), max(mn_[1], 0); x1, y1 = min(mx_[0], size), min(mx_[1], size)
        if x1 <= x0 or y1 <= y0: continue
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        a, b, c = uvs
        d = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1])
        if abs(d) < 1e-12: continue
        w0 = ((b[1]-c[1])*(gx-c[0]) + (c[0]-b[0])*(gy-c[1])) / d
        w1 = ((c[1]-a[1])*(gx-c[0]) + (a[0]-c[0])*(gy-c[1])) / d
        w2 = 1 - w0 - w1
        m = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
        if not m.any(): continue
        vs = [mw @ co[i].co for i in t.vertices]
        pw = np.stack([np.array(v[:]) for v in vs])
        pos = w0[m][:, None]*pw[0] + w1[m][:, None]*pw[1] + w2[m][:, None]*pw[2]
        nrm = np.array((mn @ t.normal)[:])
        ys, xs = np.nonzero(m); ys = ys + y0; xs = xs + x0
        P[ys, xs] = pos; N[ys, xs] = nrm; M[ys, xs] = t.material_index; mask[ys, xs] = True
    return mask, P, N, M

def dilate(img, mask, iters):
    img = img.copy(); mask = mask.copy()
    for _ in range(iters):
        grow = ~mask
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            src = np.roll(np.roll(mask, dy, 0), dx, 1); simg = np.roll(np.roll(img, dy, 0), dx, 1)
            take = grow & src
            img[take] = simg[take]; mask |= take; grow = ~mask
    return img

def scene_bvh():
    from mathutils.bvhtree import BVHTree
    verts, tris = [], []
    for ob in bpy.data.objects:
        if ob.type != 'MESH': continue
        me = ob.data; me.calc_loop_triangles(); base = len(verts)
        verts += [ob.matrix_world @ v.co for v in me.vertices]
        tris += [(base + t.vertices[0], base + t.vertices[1], base + t.vertices[2]) for t in me.loop_triangles]
    return BVHTree.FromPolygons(verts, tris)

def ambient_occlusion(o, res, rays, reach):
    from mathutils import Vector
    tree = scene_bvh(); mask, P, N, _ = raster(o, res)
    rng = np.random.default_rng(3); ao = np.ones((res, res), np.float32)
    ys, xs = np.nonzero(mask)
    # cosine-weighted hemisphere samples in a tangent frame
    u1 = (np.arange(rays) + 0.5) / rays; u2 = (np.arange(rays) * 0.61803398875) % 1.0
    r = np.sqrt(u1); loc = np.stack([r*np.cos(6.2832*u2), r*np.sin(6.2832*u2), np.sqrt(1-u1)], -1)
    for y, x in zip(ys, xs):
        n = N[y, x]; ln = np.linalg.norm(n)
        if ln < 1e-6: continue
        n = n/ln; t = np.cross(n, [0, 0, 1] if abs(n[2]) < 0.9 else [1, 0, 0]); t /= np.linalg.norm(t); bt = np.cross(n, t)
        rot = rng.uniform(0, 6.2832); cr, sr = np.cos(rot), np.sin(rot)
        o_ = Vector((P[y, x] + n*0.004).tolist()); occ = 0.0
        for l in loc:
            lx, ly = l[0]*cr - l[1]*sr, l[0]*sr + l[1]*cr
            d = t*lx + bt*ly + n*l[2]
            hit = tree.ray_cast(o_, Vector(d.tolist()), reach)
            if hit[0] is not None: occ += 1.0 - hit[3]/reach*0.6
        ao[y, x] = 1.0 - occ/rays
    return dilate(ao[..., None], mask, 6)[..., 0]

def upsample(a, size):
    r = a.shape[0]; xs = (np.arange(size) + 0.5) / size * r - 0.5; g = np.arange(r)
    tmp = np.stack([np.interp(xs, g, a[i]) for i in range(r)])
    return np.stack([np.interp(xs, g, tmp[:, j]) for j in range(size)], 1)

def bake_wood(o, size, tag, ao_res, rays, reach):
    """Wood colour x ambient occlusion -> one JPEG, then a single plain material.
    (Cycles' own shader bake returns black in this build, so this is done by hand.)"""
    unwrap(o, size)
    names = [m.name.split(".")[0] for m in o.data.materials]
    mask, P, N, M = raster(o, size)
    img = np.zeros((size, size, 3)); img[mask] = wood_color(P[mask], M[mask], names)
    img = dilate(img, mask, 10)
    ao = upsample(ambient_occlusion(o, ao_res, rays, reach), size)
    img = np.clip(img * (0.62 + 0.38*np.clip(ao, 0, 1))[..., None], 0, 1)
    sc.view_settings.view_transform = 'Standard'; sc.render.image_settings.quality = 88
    final = bpy.data.images.new(tag+"_wood", size, size, alpha=False)
    rgba = np.ones((size, size, 4)); rgba[..., :3] = srgb2lin(img)
    final.pixels = rgba.ravel().tolist()
    path = os.path.join(OUT, f"{tag}_wood.jpg"); final.filepath_raw = path; final.file_format = 'JPEG'
    final.save_render(path, scene=sc); final.source = 'FILE'; final.filepath = path; final.reload()
    m = bpy.data.materials.new(tag+"Wood"); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value = 0.55
    t = m.node_tree.nodes.new("ShaderNodeTexImage"); t.image = final
    m.node_tree.links.new(t.outputs["Color"], b.inputs["Base Color"])
    o.data.materials.clear(); o.data.materials.append(m)

AO = {'table': (160, 20, 0.9), 'throne': (96, 20, 0.5)}  # ao texture res, rays, reach
extra = []
if PIECE == "table":
    extra.append(build_table()); tag, size = "table", 2048
else:
    throne(PIECE == "crest"); tag, size = PIECE, 1024
apply_all()
parts = []
def grp(objs, name, bake=False):
    objs = [o for o in objs if o.name in bpy.data.objects]
    if not objs: return
    o = join(objs, name); parts.append(o); return o

# multiple materials per group are fine; the join keeps slots
wood = grp(wood_objs, tag.capitalize()+"_Wood")
grp(gold_objs, "Gold"); grp(brass_objs, "Brass"); grp(dark_objs, "Seams")
grp(leath_objs, "Leather"); grp(gem_objs, "Gems")
if extra: extra[0].name = "Well"

# light for the AO/colour bake only (AO is lighting-independent, colour pass ignores lights)
bpy.ops.object.select_all(action='DESELECT')
bake_wood(wood, size, tag, *AO[tag if tag == 'table' else 'throne'])

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f"pod-{tag}.glb"), export_format='GLB',
                          use_selection=True, export_image_format='JPEG', export_image_quality=85,
                          export_apply=True)
print("EXPORTED", tag)
