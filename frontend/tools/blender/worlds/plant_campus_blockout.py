import bpy, bmesh, math, sys, random
from mathutils import Vector
import os
# Blockout of a car-plant campus: the seed for the production-plant world template
# (press, body, paint, PBS tower, assembly, test track, dispatch yard).
# Starter-kit script; it renders a review picture and does not export a GLB yet.
#   node tools/blender/run-blender.mjs tools/blender/worlds/plant_campus_blockout.py -- out.png
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "helpers.py"), encoding="utf-8").read())
def MM(n,h,r=.6,m=0,e=0): M[n]=mat(n,h,r,m,e)
for n,h,r in [('Ground',0xDCEBE2,.95),('Road',0xC4CCD3,.9),('Walk',0xF3EFE2,.8),('Paint',0xF2C14E,.6),('White',0xFFFFFF,.6),
              ('Wall',0x1F9E96,.55),('Roof',0x136E6B,.5),('Trim',0xF7F3E8,.5),('Glass',0x9FD8D3,.2),('Sand',0xE6D8BE,.7),('SandRoof',0xB9A27E,.6),
              ('Coil',0x8A9499,.4),('Panel',0xB8C2C7,.5),('BIW',0x9AA5AA,.5),('CarW',0xF4F4F0,.4),('CarG',0x7C898D,.4),('CarR',0xC9502F,.4),('CarB',0x2F5DA8,.4),
              ('Leaf',0x4FB477,.7),('Leaf2',0x7CCB8E,.7),('Trunk',0xA2826A,.8),('Rail',0x6B7378,.5),('Wagon',0x34508C,.5),('Track',0x9AA4A8,.8),('Grass',0xC9E4D2,.95),]:
    MM(n,h,r)
MM('Lamp',0x3BB273,.3,0,3); MM('LampA',0xF2B329,.3,0,3); MM('LampR',0xE0473E,.3,0,3)
def zprism(name,xy,z0,z1,m,bevel=0.0):
    bm=bmesh.new(); a=[bm.verts.new(G(x,y,z0)) for x,y in xy]; b=[bm.verts.new(G(x,y,z1)) for x,y in xy]
    bm.faces.new(a); bm.faces.new(list(reversed(b))); n=len(xy)
    for i in range(n):
        j=(i+1)%n; bm.faces.new([a[i],a[j],b[j],b[i]])
    bmesh.ops.recalc_face_normals(bm,faces=bm.faces); me=bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(o); return finish(o,name,m,bevel,2,None)
def flat(name,x0,x1,z0,z1,y,m,t=0.05): return box(name,x1-x0,t,z1-z0,((x0+x1)/2,y,(z0+z1)/2),m,0,1)
def outline(n,x0,x1,z0,z1,y=0.06,m='Paint',w=0.35):
    flat(n+'a',x0,x1,z0,z0+w,y,m); flat(n+'b',x0,x1,z1-w,z1,y,m); flat(n+'c',x0,x0+w,z0,z1,y,m); flat(n+'d',x1-w,x1,z0,z1,y,m)
def hall(n,x0,x1,z0,z1,h,teeth=None,wall='Wall',roof='Roof',sign=None):
    box(n+'w',x1-x0,h,z1-z0,((x0+x1)/2,h/2,(z0+z1)/2),wall,0.25,2)
    # sawtooth roof: teeth along x, ridge lines along z
    teeth=teeth or max(2,int((x1-x0)/8))
    step=(x1-x0)/teeth
    for i in range(teeth):
        a=x0+i*step; zprism(f'{n}st{i}',[(a,h),(a+step,h),(a+step,h+2.6),(a+step-0.6,h+2.6)],z0-0.4,z1+0.4,roof)
        box(f'{n}gl{i}',0.3,2.2,z1-z0,(a+step-0.15,h+1.3,(z0+z1)/2),'Glass',0,1)
    box(n+'trim',x1-x0+0.4,0.5,0.6,((x0+x1)/2,h-0.25,z1+0.1),'Trim',0.1,2)
    outline(n+'walk',x0-2.5,x1+2.5,z0-2.5,z1+2.5,0.05,'Paint',0.3)
def tree(n,x,z,s=1.0):
    cyl(n+'t',0.4*s,2.6*s,(x,1.3*s,z),'y','Trunk',8,0,1)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=2.4*s,location=G(x,4.2*s,z),segments=14,ring_count=9); o=bpy.context.active_object; finish(o,n+'l','Leaf' if random.random()<.6 else 'Leaf2',0,1,None)
random.seed(4)
# ground, plots, roads
box('ground',420,0.2,300,(0,-0.1,0),'Ground',0,1)
flat('campus',-128,124,-74,74,0.02,'Walk',0.04)
for z in (-30,30): flat(f'road{z}',-128,124,z-3.5,z+3.5,0.06,'Road')
for x in (-124,120): flat(f'roadv{x}',x-3.5,x+3.5,-74,74,0.06,'Road')
for x in range(-120,120,10):
    for z in (-30,30): flat(f'dash{x}{z}',x,x+4,z-0.15,z+0.15,0.09,'White')
# coil yard (left), with marked bays and coil stacks
outline('coil',-118,-98,-24,24)
for i in range(6):
    for j in range(3):
        cyl(f'coil{i}{j}',1.2,1.6,(-114+j*5,1.2,-18+i*7),'z','Coil',20,0.2,2)
# PRESS hall
hall('press',-92,-64,-22,22,14,4)
# panel store bay (outside, between press and body): racks of panels
outline('pst',-60,-52,-20,20)
for i in range(6): box(f'pr{i}',5,2.2,4,(-56,1.1,-16+i*6.4),'Panel',0.15,2)
# BODY hall
hall('body',-48,-22,-22,22,12,4)
outline('bbuf',-18,-12,-20,20)
for i in range(5): box(f'biw{i}',3.4,1.8,1.8,(-15,0.95,-15+i*7),'BIW',0.4,3)
# PAINT hall (taller) with stacks and oven
hall('paint',-8,22,-24,24,18,4)
for i,x in enumerate((-4,4,12,20)):
    cyl(f'stack{i}',0.9,9,(x,22.5,-14),'y','Trim',16,0.1,1)
box('oven',26,4,8,(7,20.5,10),'Roof',0.4,3)
# PBS high-bay tower
box('pbs',10,24,40,(29,12,0),'Glass',0.3,2)
for i in range(6):
    for j in range(4):
        box(f'pbsb{i}{j}',3.0,1.4,1.6,(29,2+i*3.6,-15+j*10),['CarW','CarG','CarR','CarB'][(i+j)%4],0.4,2)
box('pbsroof',10.6,0.6,40.6,(29,24.3,0),'Roof',0.1,1)
# ASSEMBLY hall (long)
hall('asm',36,88,-22,22,12,6)
# TEST hall + oval track (toward camera)
hall('test',92,108,-22,4,10,2)
for k in range(48):
    a=2*math.pi*k/48; x=100+16*math.cos(a); z=48+9*math.sin(a)
    box(f'trk{k}',3.2,0.12,1.8,(x,0.08,z),'Track',0,1)
for k,(cx,c) in enumerate([(88,'CarR'),(108,'CarW'),(100,'CarB')]):
    box(f'tcar{k}',3.6,1.4,1.8,(cx,0.8,48+(-9 if k==2 else 0)),c,0.5,3)
# DISPATCH yard (back right): marked rows of finished cars
outline('disp',90,120,-70,-36)
cols=['CarW','CarW','CarG','CarR','CarB','CarW']
for r in range(5):
    for c in range(9):
        if random.random()<0.82: box(f'dc{r}{c}',1.9,1.3,3.6,(93+c*3.2,0.75,-66+r*6.2),random.choice(cols),0.45,3)
# RAIL siding along the back, with double-deck wagons
for z in (-72.5,-71): flat(f'rail{z}',-120,120,z-0.15,z+0.15,0.12,'Rail')
for i in range(9): box(f'wag{i}',18,4.2,3.2,(-60+i*19,2.3,-71.75),'Wagon',0.3,2)
# FEEDERS toward camera: engine plant and supplier park (sand = supplier)
hall('eng',38,68,40,62,10,3)
hall('seat',6,28,40,58,9,2,'Sand','SandRoof')
outline('seatlink',28,38,48,52)
# office, canteen, car park, gate
box('office',18,9,12,(-110,4.5,52),'Trim',0.4,3); box('officeg',18.2,2,12.2,(-110,6,52),'Glass',0.1,1)
box('canteen',12,6,10,(-88,3,52),'Sand',0.4,3)
outline('park',-74,-44,40,64)
for c in range(8):
    for r in range(3):
        if random.random()<0.75: box(f'pk{c}{r}',1.8,1.3,3.4,(-71+c*3.6,0.7,44+r*7.5),random.choice(cols),0.45,3)
# andon lamps on shop corners (state colours)
for k,(x,z,m) in enumerate([(-63,23,'Lamp'),(-21,23,'Lamp'),(23,25,'LampA'),(89,23,'LampR'),(109,5,'Lamp')]):
    cyl(f'pole{k}',0.18,5,(x,2.5,z),'y','Rail',8,0,1); cyl(f'lamp{k}',0.6,1.2,(x,5.6,z),'y',m,16,0.1,1)
# trees and grass verges
flat('grassN',-128,124,64,74,0.07,'Grass')
for k in range(26): tree(f'tr{k}',-120+k*9.5+random.uniform(-2,2),69+random.uniform(-2,2),random.uniform(0.8,1.2))
for k in range(8): tree(f'tw{k}',-126+random.uniform(-1,1),-60+k*15,random.uniform(0.8,1.1))
# render
out=sys.argv[sys.argv.index('--')+1]
scn=bpy.context.scene; scn.render.engine='CYCLES'; scn.cycles.samples=24; scn.cycles.device='CPU'; scn.cycles.use_denoising=False
scn.render.resolution_x,scn.render.resolution_y=1600,1000
w=bpy.data.worlds.new('w'); scn.world=w; w.use_nodes=True
w.node_tree.nodes['Background'].inputs[0].default_value=(0.84,0.9,0.87,1); w.node_tree.nodes['Background'].inputs[1].default_value=0.85
bpy.ops.object.light_add(type='SUN',location=(0,0,50)); s=bpy.context.active_object; s.data.energy=3.4; s.data.angle=math.radians(10)
s.rotation_euler=(math.radians(40),math.radians(-30),math.radians(35))
bpy.ops.object.camera_add(location=G(150,150,190)); cam=bpy.context.active_object; cam.data.type='ORTHO'; cam.data.ortho_scale=250; cam.data.clip_end=2000
d=Vector(G(0,0,0))-cam.location; cam.rotation_euler=d.to_track_quat('-Z','Y').to_euler(); scn.camera=cam
scn.render.filepath=out; bpy.ops.render.render(write_still=True); print('RENDERED')
