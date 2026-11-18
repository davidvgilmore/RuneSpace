"""Render the checked-in inventory icons and interchangeable dressed-player layers."""
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageColor

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / 'layout/mods/runespace'
EXPORT = """
import {buildCharacter} from './layout/mods/runespace/world-art.js';
import {hash,Mesh} from './layout/mods/runespace/world-engine.js';
import {DEFAULT_LOADOUT,EQUIPMENT_ITEMS,PLAYER_PARTS,playerPartKey} from './layout/mods/runespace/equipment.js';
const skin=['#cea67e','#ba8a62','#e0bc91','#a77954'][hash('player')%4];
class ItemMesh extends Mesh {
  face(points,color,lit=true){
    if(color!==skin && color!=='#565055' && color!=='#85848c')super.face(points,color,lit);
  }
}
function output(slot,loadout,icon){
  const mesh=buildCharacter(icon?ItemMesh:Mesh,hash,{key:'player',player:true,activity:'idle',
    posePhase:0,equipmentPart:slot,loadout,itemOnly:icon},0);
  const id=loadout[slot],part=playerPartKey(slot,loadout,'idle').replaceAll(':','-');
  console.log(JSON.stringify({id,slot,part,icon,faces:mesh.faces}));
}
for(const {id,slot} of EQUIPMENT_ITEMS){
  output(slot,{...DEFAULT_LOADOUT,[slot]:id},true);
}
for(const slot of PLAYER_PARTS){
  const ids=EQUIPMENT_ITEMS.filter(item=>item.slot===slot).map(item=>item.id);
  if(!['weapon','shield','cape'].includes(slot))ids.push('none');
  for(const id of ids){
    const loadout={...DEFAULT_LOADOUT,[slot]:id};
    output(slot,loadout,false);
    if(slot==='torso')output(slot,{...loadout,weapon:'armadyl-godsword'},false);
  }
}
"""


def projection(item, yaw, tilt, roll=0):
    def project(point):
        x, y, z = point
        side = x * math.cos(yaw) - z * math.sin(yaw)
        near = x * math.sin(yaw) + z * math.cos(yaw)
        up = y * math.cos(tilt) - near * math.sin(tilt)
        return (side * math.cos(roll) - up * math.sin(roll), -side * math.sin(roll) - up * math.cos(roll),
                near * math.cos(tilt) + y * math.sin(tilt))

    return [(list(map(project, f['points'])), f['color'], f.get('vertexColors')) for f in item['faces']]


def paint(faces, dimensions, scale, origin, target):
    # Match the depth test in the game. Sorting whole polygons by their centre
    # would let the back of a helmet paint over the face or the inside of its rim.
    width, height = dimensions
    depth = np.full((height, width), -np.inf, dtype=np.float32)
    pixels = np.zeros((height, width, 4), dtype=np.uint8)
    for vertices, color, corners in faces:
        screen = [(origin[0]+x*scale,origin[1]+y*scale,z) for x,y,z in vertices]
        for i in range(1,len(screen)-1):
            (ax,ay,az),(bx,by,bz),(cx,cy,cz) = screen[0],screen[i],screen[i+1]
            area = (by-cy)*(ax-cx)+(cx-bx)*(ay-cy)
            if abs(area)<1e-8:
                continue
            left,top = max(0,math.floor(min(ax,bx,cx))),max(0,math.floor(min(ay,by,cy)))
            right,bottom = min(width,math.ceil(max(ax,bx,cx))),min(height,math.ceil(max(ay,by,cy)))
            if left>=right or top>=bottom:
                continue
            y,x = np.ogrid[top:bottom,left:right]
            u = ((by-cy)*(x+.5-cx)+(cx-bx)*(y+.5-cy))/area
            v = ((cy-ay)*(x+.5-cx)+(ax-cx)*(y+.5-cy))/area
            w = 1-u-v
            z = u*az+v*bz+w*cz
            tile_depth = depth[top:bottom,left:right]
            mask = (np.minimum(np.minimum(u,v),w)>=-1e-8) & (z>=tile_depth-1e-7)
            tile_depth[mask] = z[mask]
            tile = pixels[top:bottom,left:right]
            if corners:
                first,second,third = [np.array(ImageColor.getcolor(corners[k],'RGBA')) for k in (0,i,i+1)]
                tile[mask] = np.rint(u[mask,None]*first+v[mask,None]*second+w[mask,None]*third)
            else:
                tile[mask] = ImageColor.getcolor(color,'RGBA')
    return Image.fromarray(pixels,'RGBA').resize(target,Image.Resampling.LANCZOS)


def thumbnail(item):
    slot = item['slot']
    yaw = {'head': .42, 'torso': .36, 'weapon': .27, 'shield': .84,
           'boots': .54, 'legs': .42, 'cape': math.pi + .24}[slot]
    tilt = .35 if slot in ('head', 'boots') else .19
    roll = -.47 if slot == 'weapon' else -.25 if item['id'] == 'rune-defender' else 0
    faces = projection(item, yaw, tilt, roll)
    xs, ys, _ = zip(*(p for vertices, _, _ in faces for p in vertices))
    w, h = max(xs)-min(xs), max(ys)-min(ys)
    size = 448
    scale = (size-48) / max(w, h)
    origin = ((size-scale*w)/2-min(xs)*scale, (size-scale*h)/2-min(ys)*scale)
    return paint(faces,(size,size),scale,origin,(112,112))


def save(image, destination):
    destination.parent.mkdir(exist_ok=True, parents=True)
    image.save(destination, optimize=True)


if __name__ == '__main__':
    result = subprocess.run(['node', '--input-type=module', '-e', EXPORT], cwd=ROOT,
                            capture_output=True, check=True, text=True)
    for line in result.stdout.splitlines():
        item = json.loads(line)
        if item['icon']:
            save(thumbnail(item), MOD/'preview'/(item['id']+'.png'))
            continue
        for view, yaw in [('front', .28), ('back', math.pi-.30)]:
            faces = projection(item, yaw, .18)
            layer = paint(faces,(648,870),331,(324,788),(432,580))
            save(layer, MOD/'wardrobe'/view/(item['part']+'.png'))
