// Painter-order-preserving material batches for convex projected polygons.
// Bounding-box grid queries are followed by exact separating-axis tests, so
// adjacent faces can batch even when their screen-space bounding boxes overlap.
const EPSILON=1e-7;

function geometry(face){
  if(face.packingGeometry)return face.packingGeometry;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const axes=[],points=face.points;
  for(const p of points){left=Math.min(left,p[0]);top=Math.min(top,p[1]);right=Math.max(right,p[0]);bottom=Math.max(bottom,p[1]);}
  for(let i=0;i<points.length;i++){
    const p=points[i],q=points[(i+1)%points.length],dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy);
    if(length<EPSILON)continue;
    const x=-dy/length,y=dx/length;let min=Infinity,max=-Infinity;
    for(const point of points){const d=point[0]*x+point[1]*y;min=Math.min(min,d);max=Math.max(max,d);}
    axes.push({x,y,min,max});
  }
  return face.packingGeometry={left,top,right,bottom,axes};
}

// Touching an edge is not an overlap. This keeps contiguous coplanar triangles
// batchable without permitting one visible polygon to cross another.
export function polygonsOverlap(a,b){
  const ga=geometry(a),gb=geometry(b);
  if(ga.right<=gb.left+EPSILON||gb.right<=ga.left+EPSILON||ga.bottom<=gb.top+EPSILON||gb.bottom<=ga.top+EPSILON)return false;
  for(const [g,other] of [[ga,b],[gb,a]])for(const axis of g.axes){
    let min=Infinity,max=-Infinity;
    for(const p of other.points){const d=p[0]*axis.x+p[1]*axis.y;min=Math.min(min,d);max=Math.max(max,d);}
    if(max<=axis.min+EPSILON||min>=axis.max-EPSILON)return false;
  }
  return true;
}

export function packFaces(faces,width,height,cell=48){
  const cols=Math.max(1,Math.ceil(width/cell)),rows=Math.max(1,Math.ceil(height/cell));
  const buckets=new Array(cols*rows),lastColor=new Map(),groups=[],faceGroups=new Int32Array(faces.length),seen=new Uint32Array(faces.length);
  let comparisons=0;
  for(let i=0;i<faces.length;i++){
    const face=faces[i],b=geometry(face);
    const x0=Math.max(0,Math.min(cols-1,Math.floor(b.left/cell))),x1=Math.max(0,Math.min(cols-1,Math.floor(b.right/cell)));
    const y0=Math.max(0,Math.min(rows-1,Math.floor(b.top/cell))),y1=Math.max(0,Math.min(rows-1,Math.floor(b.bottom/cell)));
    const opaque=/^#[0-9a-f]{6}(ff)?$/i.test(face.color);
    let index=opaque?lastColor.get(face.color):undefined,blocked=false;
    if(index!==undefined){
      search:for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const bucket=buckets[y*cols+x];if(!bucket)continue;
        for(let k=bucket.length-1;k>=0;k--){
          const j=bucket[k];if(faceGroups[j]<=index||seen[j]===i+1)continue;seen[j]=i+1;
          comparisons++;
          if(polygonsOverlap(face,faces[j])){blocked=true;break search;}
        }
      }
    }
    if(index===undefined||blocked){index=groups.length;groups.push({color:face.color,faces:[]});if(opaque)lastColor.set(face.color,index);}
    groups[index].faces.push(face);faceGroups[i]=index;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const at=y*cols+x;if(!buckets[at])buckets[at]=[];buckets[at].push(i);
    }
  }
  // Diagnostic metadata is not used by the renderer or part of the array items.
  groups.comparisons=comparisons;
  return groups;
}

export function sameFaces(a,b){
  if(!a||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
