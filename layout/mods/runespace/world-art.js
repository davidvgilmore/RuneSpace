import {normalizeLoadout} from './equipment.js';
// Original medieval scenery and figures for the Guild. No game assets or renderer dependencies.
const TAU=Math.PI*2;
export const TREES=[[-10,-6],[-13,-8],[-8,-10],[-12,-3],[-8,-3],[-14,-12],[-10,-14],[-5,-16],[3,-17],[9,-16],[15,-13],[17,0],[17,12],[-11,13],[-7,16],[6,17]];
export const ROCKS=[[9,-6],[12,-8],[14,-4],[8,-10],[14,-11],[11,-3]];
export const ART_PALETTE={grass:'#627b3e',stone:'#b3ac8e',timber:'#725235',roof:'#a05c3e',water:'#397b8c',local:'#50764b',remote:'#486c91',other:'#806399'};
const mix=(a,b,t)=>'#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');
const ring=(x,y,z,rx,rz,n=6,phase=0)=>Array.from({length:n},(_,i)=>{const a=phase+i*TAU/n;return[x+Math.cos(a)*rx,y,z+Math.sin(a)*rz];});
const rectRing=(x,y,z,w,d)=>[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y,z+d/2],[x-w/2,y,z+d/2]];
function loft(m,a,b,color,top=true){for(let i=0;i<a.length;i++){let j=(i+1)%a.length;m.face([a[i],b[i],b[j],a[j]],color);}if(top)m.face([...b].reverse(),color);}
function plane(m,x,z,w,d,color,y=.02){m.face([[x-w/2,y,z-d/2],[x-w/2,y,z+d/2],[x+w/2,y,z+d/2],[x+w/2,y,z-d/2]],color,false);}
function shadow(m,x,z,rx,rz,phase=0,color='#4b5f35',y=.063){
  const a=[];for(let i=11;i>=0;i--){const t=i*TAU/12,c=Math.cos(phase),s=Math.sin(phase),px=Math.cos(t)*rx,pz=Math.sin(t)*rz;a.push([x+px*c-pz*s,y,z+px*s+pz*c]);}m.face(a,color.length===7?color+'88':color,false);
}
function blob(m,x,y,z,rx,h,rz,color,seed,n=6,rounded=false){
  const lower=ring(x,y,z,rx*.65,rz*.65,n,.25),middle=ring(x+.09*Math.sin(seed),y+h*.48,z,rx,rz,n,.25);
  for(let i=0;i<n;i++)middle[i][1]+=(i%2?.11:-.07)*h;
  loft(m,lower,middle,color,false);
  const crown=rounded?ring(x-.05,y+h*.84,z-rz*.06,rx*.57,rz*.59,n,.25):middle;
  if(rounded)loft(m,middle,crown,color,false);
  for(let i=0;i<n;i++)m.face([crown[i],[x+rx*.08,y+h,z-rz*.12],crown[(i+1)%n]],i%3?color:mix(color,'#c0c575',.10));
}
function arch(m,x,y,z,w,h,color){
  const r=w/2,pts=[[x-r,y,z],[x+r,y,z],[x+r,y+h-r,z]];
  for(let i=1;i<=8;i++){const a=i*Math.PI/8;pts.push([x+Math.cos(a)*r,y+h-r+Math.sin(a)*r,z]);}m.face(pts,color,false);
}
function archFrame(m,x,y,z,w,h,width,color){
  const r=w/2,ri=r-width,base=y+h-r;
  for(let i=0;i<8;i++){const a=i*Math.PI/8,b=(i+1)*Math.PI/8;
    m.face([[x+Math.cos(a)*r,base+Math.sin(a)*r,z],[x+Math.cos(b)*r,base+Math.sin(b)*r,z],[x+Math.cos(b)*ri,base+Math.sin(b)*ri,z],[x+Math.cos(a)*ri,base+Math.sin(a)*ri,z]],color,false);
  }
  m.face([[x-r,y,z],[x-r+width,y,z],[x-r+width,base,z],[x-r,base,z]],color,false);
  m.face([[x+r-width,y,z],[x+r,y,z],[x+r,base,z],[x+r-width,base,z]],color,false);
}
function roof(m,x,z,w,d,eave,ridge,color,hash){
  const rows=4,cols=8;
  for(const side of [-1,1])for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const xa=x-w/2+col*w/cols,xb=xa+w/cols,za=z+side*d/2*row/rows,zb=z+side*d/2*(row+1)/rows;
    const ya=ridge-(ridge-eave)*row/rows,yb=ridge-(ridge-eave)*(row+1)/rows;
    const pts=[[xa,ya,za],[xb,ya,za],[xb,yb,zb],[xa,yb,zb]];if(side===1)pts.reverse();
    m.face(pts,mix(color,'#c29665',(hash('roof'+side+row+col)%4)*.045));
  }
  m.face([[x-w/2,eave,z-d/2],[x-w/2,eave,z+d/2],[x-w/2,ridge,z]],'#ad9670');
  m.face([[x+w/2,eave,z+d/2],[x+w/2,eave,z-d/2],[x+w/2,ridge,z]],'#ad9670');
  m.box(x,ridge-.03,z,w+.1,.12,.18,'#79513b');
}
function chest(m,x,z){
  m.box(x,.10,z,1.55,.68,.87,'#775332');
  loft(m,rectRing(x,.78,z,1.62,.92),rectRing(x,1.03,z,1.42,.54),'#936b37');
  for(const dx of [-.49,.49]){
    m.face([[x+dx-.045,.14,z+.44],[x+dx+.045,.14,z+.44],[x+dx+.045,.78,z+.44],[x+dx-.045,.78,z+.44]],'#b39753',false);
    m.face([[x+dx-.045,.78,z+.465],[x+dx+.045,.78,z+.465],[x+dx+.045,1.04,z+.275],[x+dx-.045,1.04,z+.275]],'#c4aa64',false);
  }
  m.box(x,.50,z+.465,.14,.20,.045,'#c4aa64');
}
function barrel(m,x,z){
  loft(m,ring(x,.04,z,.35,.35,7),ring(x,.40,z,.45,.45,7),'#815b34',false);
  loft(m,ring(x,.40,z,.45,.45,7),ring(x,.9,z,.35,.35,7),'#987047');
  for(const y of [.22,.70])m.cone(x,y,z,.416,.065,'#4d5149',7,.416);
}

// Extend the landscape past the walkable map. Height begins outside the river
// and town, so the bank, crossings and every existing navigation point stay level.
function countryside(mesh, hash) {
  const extent = 78, spacing = 6;
  const riverX=z=>-16+Math.sin(Math.max(0,Math.abs(z)-22)*.075)*Math.min(4,Math.max(0,Math.abs(z)-22)*.15);
  const height = (x,z) => {
    const distance = Math.max(Math.abs(x), Math.abs(z));
    if(distance <= 26) return -.15;
    const rise = Math.min(1, (distance-26)/20);
    const ridge = 2.2 + 2*Math.sin(x*.14+z*.04) + 1.9*Math.sin(z*.16-x*.07);
    const bank=Math.min(1,Math.max(0,(Math.abs(x-riverX(z))-2.1)/8));
    return -.15 + rise*bank*Math.max(.3,ridge);
  };
  for(let x=-extent;x<extent;x+=spacing)for(let z=-extent;z<extent;z+=spacing) {
    if(x>=-18 && x<18 && z>=-18 && z<18)continue;
    const points=[[x,z],[x,z+spacing],[x+spacing,z+spacing],[x+spacing,z]]
      .map(([px,pz])=>[px,height(px,pz),pz]);
    const noise = hash(x+'field'+z)%4;
    const edge = Math.max(Math.abs(x),Math.abs(z));
    const field=mix('#687e43','#899e79',Math.max(0,Math.min(1,(edge-23)/42)));
    const color=mix(field,'#80916c',noise*.055);
    mesh.face([points[0],points[1],points[2]],color,false);
    mesh.face([points[0],points[2],points[3]],mix(color,'#819267',.08),false);
  }
  for(let i=0;i<50;i++) {
    const angle=i*TAU/50, radius=30+hash('ridge'+i)%20;
    const x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
    if((Math.abs(x)<22&&Math.abs(z)<22)||Math.abs(x-riverX(z))<3.2)continue;
    const y=height(x,z),h=2.2+(hash('pine'+i)%230)/100;
    mesh.cone(x,y,z,.20,h*.64,'#716149',5,.13);
    mesh.cone(x,y+h*.24,z,1.35,h*.66,'#536f4f',6,.06,i);
    mesh.cone(x,y+h*.54,z,1.0,h*.58,'#698666',6,0,i);
  }
  // Keep the river and trails continuous as the camera turns toward the countryside.
  for(const side of [-1,1]){
    for(let d=22;d<extent;d+=2){
      const z=side*d,next=z+side*2,x=riverX(z),nx=riverX(next);
      const points=[[x-1.9,.04,z],[nx-1.9,.04,next],[nx+1.9,.04,next],[x+1.9,.04,z]];
      mesh.face(side>0?points:points.reverse(),'#427f88',false);
    }
  }
  for(const branch of ['east','south','west']){
    const east=branch==='east',west=branch==='west';
    for(let i=0;i<13;i++){
      function station(step){
        if(east||west){
          const x=east?14.48+step*2.8:-18.65-step*2.8;
          return [x,3+Math.sin(step*.25)*step*.23,Math.max(.62,1.4-step*.058)];
        }
        return [Math.sin(step*.24)*step*.24,19.48+step*2.8,Math.max(.72,1.8-step*.09)];
      }
      const strip=station=>{
        const [x,z,r]=station;
        return east||west?[[x,height(x,z-r)+.16,z-r],[x,height(x,z+r)+.16,z+r]]:
          [[x-r,height(x-r,z)+.16,z],[x+r,height(x+r,z)+.16,z]];
      };
      const [l,r]=strip(station(i)),[nl,nr]=strip(station(i+1));
      const points=[l,r,nr,nl];
      if((r[2]-l[2])*(nr[0]-l[0])-(r[0]-l[0])*(nr[2]-l[2])<0)points.reverse();
      mesh.face(points,mix(east||west?'#ae9d70':'#a79465','#8a8c60',i/17),false);
    }
  }
}

function townDetails(mesh,hash) {
  // A mason's stone walkway crosses the green, then gives way to the worn trail.
  for(let row=0;row<11;row++)for(let col=0;col<6;col++) {
    const x=-1.62+col*.56+(row%2)*.15,z=-7.9+row*.38;
    const worn=hash('flagstone'+row+','+col);
    if((worn%5===0&&row>5)||worn%19===0)continue;
    const w=.40+(worn%11)*.009,d=.23+(worn%7)*.012,y=.045;
    const block=[[x-w/2,y,z-d/2],[x-w/2-.025,y,z+d*.36],[x-w*.30,y,z+d/2],
      [x+w/2,y,z+d/2],[x+w/2+.025,y,z-d*.35],[x+w*.30,y,z-d/2]];
    mesh.face(block,['#a5a186','#9d9b80','#b1aa8b','#b7b095'][worn%4],false);
  }
  // The bank's sign carries three gold coins visible above the doorway.
  for(const [x,y] of [[-.31,3.13],[.31,3.13],[0,3.23]]){
    const points=Array.from({length:8},(_,i)=>[x+Math.cos(i*TAU/8)*.12,y+Math.sin(i*TAU/8)*.12,-8.17]);
    mesh.face(points,'#d9ad49',false);
    frontQuad(mesh,x-.032,y-.065,-8.163,.034,.13,'#f3d77a');
  }
  // Tin lanterns and their warm glass panes flank the entrance.
  for(const x of [-1.18,1.18]){
    mesh.rod([x,2.43,-8.53],[x,2.43,-8.15],.035,'#4c4b3c');
    mesh.rod([x,2.44,-8.15],[x,2.18,-8.15],.023,'#494939');
    mesh.cone(x,2.06,-8.15,.19,.15,'#62614c',4,.018,Math.PI/4);
    loft(mesh,rectRing(x,1.80,-8.15,.20,.21),rectRing(x,2.06,-8.15,.25,.24),'#ffd97e');
    mesh.box(x,1.755,-8.15,.24,.055,.24,'#555545');
    for(const dx of [-.104,.104])mesh.rod([x+dx,1.79,-8.036],[x+dx*1.13,2.06,-8.026],.012,'#5e5840');
  }
  // Small visible wares keep the stall from reading as an empty shed.
  for(let i=0;i<9;i++){
    const x=-7.90+i%3*.19,z=7.68+Math.floor(i/3)*.18;
    blob(mesh,x,1.09,z,.105,.16,.10,i%3?'#be6145':'#cdb152',i,5);
  }
  for(const x of [-6.76,-6.42]){
    mesh.cone(x,1.09,7.9,.11,.28,'#ba8256',6,.17);
    mesh.cone(x,1.37,7.9,.17,.14,'#bc8359',6,.078);
    mesh.cone(x,1.51,7.9,.078,.075,'#8a5b38',6,.085);
  }
  // Apron of broken stones and charcoal around the furnace.
  for(let i=0;i<25;i++){
    const x=8.35+(hash('cinderx'+i)%560)/100,z=6.68+(hash('cinderz'+i)%365)/100;
    plane(mesh,x,z,.10+(hash('ash'+i)%4)*.04,.06,i%3?'#716c59':'#59594f',.077);
  }
  // Distinct tufts and buttercups, grouped along the sunny eastern riverbank.
  for(let i=0;i<34;i++){
    const x=-13.35+(hash('forbX'+i)%145)/100,z=-16+(hash('forbZ'+i)%3120)/100;
    if(Math.abs(z-3)<2.4)continue;
    for(let j=0;j<3;j++) {
      const px=x+j*.11,pz=z+(j%2)*.10,h=.17+((i+j)%3)*.045;
      mesh.face([[px,.01,pz],[px+.09,h,pz+.055],[px+.05,.01,pz]],'#7c9b4d');
      if(j===0||i%4===0)mesh.cone(px+.08,h-.04,pz+.055,.055,.04,'#e9cd66',5,.061);
    }
  }
}

export function buildWorldArt(Mesh,hash){
  const m=new Mesh(),obstacles=[],rect=(x,z,w,d)=>obstacles.push({x,z,w,d});
  countryside(m,hash);
  // Broad hand-colored terrain facets, with small flat grass flecks instead of a checkerboard.
  const greens=['#667d40','#6b8145','#647b3e','#61773d','#6d8246','#657c42'];
  for(let x=-22;x<22;x+=4)for(let z=-22;z<22;z+=4){
    const k=hash('meadow'+x+':'+z),c=greens[k%greens.length];
    m.face([[x,0,z],[x,0,z+4],[x+4,0,z+4]],c,false);
    m.face([[x,0,z],[x+4,0,z+4],[x+4,0,z]],mix(c,'#7b8b4e',.10),false);
  }
  plane(m,0,5,3.6,29,'#a79465',.012);plane(m,0,3,29,2.8,'#ae9d70',.018);
  m.disc(0,3,7.15,'#8e8760',.035,24);m.disc(0,3,6.93,'#b3a477',.042,24);
  for(let i=0;i<36;i++){
    const a=i*TAU/36,x=Math.cos(a)*7.02,z=3+Math.sin(a)*7.02;
    const stone=new Mesh();loft(stone,rectRing(0,.055,0,.46,.32),rectRing(0,.15,0,.36,.27),i%3?'#9e9777':'#b4ac8b');m.transformed(stone,x,z,-a);
  }
  for(let i=0;i<85;i++){
    const x=(hash('path-x'+i)%1300)/100-6.5,z=(hash('path-z'+i)%1300)/100-3.5;
    if(Math.hypot(x,z-3)<6.55)m.face([[x-.08,.05,z],[x+.11,.05,z+.07],[x+.19,.05,z-.04]],i%3?'#a3956c':'#c0af80',false);
  }
  // Cool blue river with pale stones, reeds, and narrow hand-drawn water highlights.
  plane(m,-16,0,3.8,44,'#3d7885',.023);
  for(let z=-22;z<22;z+=2){
    plane(m,-16,z+1,3.7,2,z%4?'#3d7885':'#40808b',.024);
    for(const x of [-18.15,-13.85]){
      const bank=mix('#8d967a','#b5b293',(hash(x+':'+z)%4)/10);
      const a=rectRing(x,.03,z+.9,.61,1.93),b=rectRing(x,.20,z+.9,.42,1.72);
      for(const i of [1,3])m.face([a[i],b[i],b[(i+1)%4],a[(i+1)%4]],bank);m.face([...b].reverse(),bank);
    }
    if(Math.abs(z-3)>2){
      const x=-16+(hash('ripple'+z)%160)/100-.8;
      plane(m,x,z+.3,.75,.035,'#83aba7',.029);plane(m,x+.55,z+.8,.40,.025,'#679b9f',.029);
    }
  }
  for(let z of [-16,-10,-4,8,15])for(let i=0;i<3;i++){
    const x=-13.65+i*.14;m.face([[x,.10,z],[x+.04,.85+i*.13,z+.11],[x+.09,.10,z+.13]],'#858a47');
  }
  shadow(m,-15.5,2.3,3.4,1.1,0,'#315b5a',.031);
  for(let x=-18.4;x<-13.3;x+=.45){m.box(x,.27,3,.42,.16,2.6,hash('plank'+x)%2?'#947347':'#a5804f');plane(m,x,3,.025,2.5,'#644a30',.438);}
  for(const z of [1.7,4.3]){m.rod([-18.6,.95,z],[-13.3,.95,z],.055,'#705235');for(const x of [-18.6,-16,-13.3]){m.box(x,.1,z,.15,1.12,.15,'#725436');m.cone(x,1.22,z,.12,.1,'#a08758',4,0,Math.PI/4);}}
  // Bank: squared ashlar at the base, plaster-and-timber hall, round corner towers.
  shadow(m,1.8,-12.6,7.5,3.8,-.18,'#4f6338');
  m.box(0,0,-11,9.4,.48,5.4,'#9e9c83');m.box(0,.48,-11,8.9,3.05,4.8,'#c3af87');
  for(const y of [.64,1.32,2.0])for(let i=0;i<9;i++){
    const x=-4.35+i*.97+(y===1.32?.35:0);if(x>4.25)continue;
    m.face([[x,y,-8.588],[Math.min(4.3,x+.89),y,-8.588],[Math.min(4.3,x+.89),y+.022,-8.588],[x,y+.022,-8.588]],'#9b8d70',false);
  }
  for(const x of [-4.3,-1.6,1.6,4.3])m.box(x,.46,-8.54,.16,3.08,.17,'#695033');
  m.box(0,2.9,-8.50,8.85,.16,.18,'#715337');m.box(0,3.45,-8.50,9.0,.15,.18,'#60472f');
  // Door and windows are shallow polygons, not dozens of tiny boxes.
  arch(m,0,.48,-8.43,1.80,2.48,'#453a2a');arch(m,0,.5,-8.414,1.43,2.20,'#765334');archFrame(m,0,.46,-8.40,2.03,2.65,.15,'#d3bd8e');
  for(const x of [-.45,-.15,.15,.45])m.face([[x,.53,-8.39],[x+.025,.53,-8.39],[x+.025,2.22,-8.39],[x,2.22,-8.39]],'#573e2b',false);
  for(const y of [1.0,1.95])m.box(0,y,-8.38,1.36,.09,.035,'#403f32');m.box(.42,1.3,-8.33,.09,.14,.05,'#c3aa61');
  for(const x of [-2.8,2.8]){
    arch(m,x,1.45,-8.40,1.10,1.50,'#344b4d');archFrame(m,x,1.40,-8.37,1.37,1.77,.14,'#d0b98b');
    m.face([[x-.36,1.55,-8.36],[x-.03,1.55,-8.36],[x-.03,2.55,-8.36],[x-.36,2.30,-8.36]],'#67827b',false);
    m.box(x,1.47,-8.32,.075,1.30,.05,'#a08c63');m.box(x,2.05,-8.32,.94,.075,.05,'#a08c63');
    m.box(x,1.35,-8.29,1.5,.13,.3,'#aaa487');
  }
  roof(m,0,-11,10,5.5,3.53,5.4,'#995b40',hash);
  for(const x of [-5.5,5.5]){
    m.cone(x,0,-11,1.36,4.58,'#a7a58c',8,1.25,Math.PI/8);
    for(const y of [1.45,2.8,4.5])m.cone(x,y,-11,y===4.5?1.45:1.31,.13,'#8b8f7c',8,y===4.5?1.45:1.31,Math.PI/8);
    m.cone(x,4.63,-11,1.46,.30,'#c0baa0',8,1.46,Math.PI/8);
    for(let i=0;i<8;i++){const a=i*TAU/8;m.box(x+Math.cos(a)*1.20,4.93,-11+Math.sin(a)*1.20,.47,.46,.47,'#aaa78e');}
    m.box(x,4.95,-11,.065,2.15,.065,'#806038');
    m.face([[x,7.10,-11],[x+1.27,6.95,-11],[x+1.06,6.47,-11],[x,6.61,-11]],x<0?'#8f9d4f':'#6f8d9b',false);
    m.face([[x,6.61,-11],[x+1.06,6.47,-11],[x+1.27,6.95,-11],[x,7.10,-11]],x<0?'#8f9d4f':'#6f8d9b',false);
    arch(m,x,2.0,-9.73,.40,1.25,'#484e46');
  }
  rect(0,-11,12.9,5.6);
  m.box(0,2.97,-8.27,2.72,.43,.13,'#59432d');m.box(0,3.01,-8.19,2.50,.055,.02,'#c0a368');
  for(const [x,c] of [[-4.06,'#637b4b'],[4.06,'#5d7c90']]){
    m.face([[x-.29,2.85,-8.32],[x+.29,2.85,-8.32],[x+.29,1.85,-8.32],[x,1.61,-8.32],[x-.29,1.85,-8.32]].reverse(),c,false);
    m.face([[x-.09,2.65,-8.30],[x+.09,2.65,-8.30],[x+.09,2.03,-8.30],[x-.09,2.03,-8.30]].reverse(),'#c7b978',false);
  }
  for(const x of [-3.4,3.4]){shadow(m,x+.4,-6.85,1.1,.65,0,'#626b42');chest(m,x,-6.6);rect(x,-6.6,1.9,1.2);}
  for(const [x,z,yaw] of [[-4.8,3,Math.PI/2],[4.8,3,Math.PI/2],[0,8.8,0]]){
    const b=new Mesh();b.box(0,.5,0,2,.14,.66,'#8c6b42');b.box(0,.52,0,2.04,.055,.05,'#b0925b');
    for(const bx of [-.74,.74])b.box(bx,.03,0,.16,.50,.50,'#624a30');m.transformed(b,x,z,yaw);rect(x,z,yaw?1:2.3,yaw?2.3:1);
    shadow(m,x+.35,z-.2,yaw?.55:1.25,yaw?1.25:.55,0,'#89835a');
  }
  // The hearth is a circle of uneven stones over charred earth; animated flames are separate.
  m.disc(0,3,.98,'#6b6248',.07,14);m.disc(0,3,.63,'#3d3a2c',.075,10);
  for(let i=0;i<9;i++){const a=i*TAU/9;blob(m,Math.cos(a)*.85,.06,3+Math.sin(a)*.85,.23,.27,.21,i%3?'#a09c83':'#bab193',i,5);}
  for(const [a,z] of [[-.55,2.86],[.28,3.15]]){m.rod([a,.16,z-.37],[-a,.29,z+.37],.13,'#60452d');}
  rect(0,3,1.7,1.7);
  // Oaks have asymmetric leaf clusters and branching trunks; highland trees remain pointed.
  TREES.forEach(([x,z],i)=>{
    const oak=i%3!==1,h=3.8+(i%3)*.38;shadow(m,x+.7,z-.45,oak?1.8:1.3,oak?1.35:1.0,-.25);
    m.cone(x,0,z,oak?.30:.24,h*.62,'#745131',6,oak?.18:.12,.2);rect(x,z,.8,.8);
    if(oak){
      m.rod([x,h*.37,z],[x-.65,h*.70,z+.1],.10,'#81603a');m.rod([x,h*.47,z],[x+.7,h*.76,z-.3],.10,'#705032');
      blob(m,x,h*.50,z,1.43,1.85,1.34,i%2?'#496f36':'#557a3c',i,7,true);
      blob(m,x-.87,h*.46,z+.24,.91,1.27,.96,'#52773a',i+3,5,true);
    }else{
      m.cone(x,h*.25,z,1.27,h*.54,'#365f38',7,.03,i*.31);
      m.cone(x,h*.47,z,1.03,h*.47,'#446e3c',7,.02,i*.31+.16);
      m.cone(x,h*.68,z,.70,h*.37,'#537a40',6,0,i*.31);
    }
  });
  // Bare earth and six recognizable copper/tin outcrops, with angular ore seams.
  m.disc(11,-7,5.25,'#85856a',.028,15);
  ROCKS.forEach(([x,z],i)=>{
    shadow(m,x+.25,z-.25,1.36,.98,-.2,'#676e58');
    const a=ring(x,.02,z,1.08,.90,5,i*.47),b=ring(x-.15,.75+i%2*.24,z+.08,.73,.56,5,i*.47+.12);
    loft(m,a,b,'#858c85',false);for(let k=0;k<5;k++)m.face([b[k],[x+.10,1.45+(i%2)*.24,z-.08],b[(k+1)%5]],k%2?'#a4aaa0':'#8f978f');
    const metal=i%2?'#c4c4a7':'#ba8d50';m.face([[x-.62,.65,z+.61],[x-.29,1.10,z+.41],[x-.04,.9,z+.48],[x-.29,.61,z+.66]],metal,false);
    m.face([[x+.24,.70,z+.58],[x+.42,1.13,z+.30],[x+.60,.74,z+.52]],mix(metal,'#ece0a8',.25),false);rect(x,z,1.7,1.7);
  });
  // Open smithy: work surfaces stay in front of the roof, where companions remain visible.
  plane(m,11,8,7,5,'#979177',.046);shadow(m,12.0,8.5,3.4,2.6,0,'#6e7454');
  m.box(11,.1,9.5,2.0,2.30,1.8,'#8d8270');m.box(11,2.40,9.5,1.05,2.48,1.05,'#a19880');
  for(const y of [.6,1.2,1.8,2.5,3.1,3.7,4.3])m.box(11,y,10.03,y>2.4?1.07:2.02,.035,.025,'#726d5e');
  arch(m,11,.27,8.57,1.25,1.53,'#3a3024');arch(m,11,.30,8.55,.95,1.17,'#a14e2d');
  plane(m,11,8.65,1.10,.55,'#d0863e',.12);m.box(11,.34,8.52,.65,.32,.10,'#e3b65a');rect(11,9.5,2.5,2.1);
  for(const [x,z] of [[9,5.2],[12,5.2],[14,7]]){
    m.cone(x,0,z,.43,.64,'#80603b',6,.36);m.box(x,.63,z,.62,.12,.50,'#5c6764');
    loft(m,rectRing(x,.75,z,.38,.31),rectRing(x,.98,z,.84,.46),'#77817c');m.box(x,1.00,z,1.12,.12,.53,'#a0aaa0');
    m.box(x+.02,1.12,z+.045,.38,.055,.135,'#ce7842');
    frontQuad(m,x+.1,1.128,z+.114,.13,.031,'#e7ab5c');
    m.face([[x-.56,1.01,z-.22],[x-.97,1.07,z],[x-.56,1.12,z+.22]],'#a0aaa0');rect(x,z,1.15,.9);
  }
  for(const x of [7.7,14.3])m.box(x,.10,10.5,.16,3.20,.16,'#6c4e32');
  // Compact lean-to rather than a roof covering the smiths' entire work area.
  m.face([[7.30,3.30,11.0],[14.70,3.30,11.0],[14.70,3.03,8.85],[7.30,3.03,8.85]],'#895c3d');
  for(let i=0;i<9;i++)m.rod([7.45+i*.8,3.31,11],[7.45+i*.8,3.04,8.85],.025,'#ae7d4c');
  // Low rear rail and open frontage give farmers room to draw a hoe through the beds.
  for(let x=7;x<=15;x+=2){
    m.box(x,0,17.35,.15,.94,.15,'#7d603a');
    if(x<15){m.rod([x,.42,17.35],[x+2,.42,17.35],.052,'#a08350');m.rod([x,.76,17.35],[x+2,.76,17.35],.05,'#927346');}
  }
  rect(11,17.35,8.1,.16);
  for(const [index,x] of [8.2,10.7,13.2].entries()){
    plane(m,x,15.55,1.90,1.96,'#866540',.046);
    rect(x,15.55,1.54,1.30);
    for(let i=0;i<5;i++){
      const xc=x+(i-2)*.345;
      const base=rectRing(xc,.046,15.55,.31,1.85),ridge=rectRing(xc,.107,15.55,.12,1.74);
      loft(m,base,ridge,i%2?'#6d5537':'#795a39');
      for(let j=0;j<3;j++){
        const z=15.05+j*.52,leaf='#789954',dark='#4b713e',px=xc+Math.sin(i+j)*.028;
        for(let k=0;k<3;k++){
          const a=(i+j+k*2)*1.1,dx=Math.sin(a)*.15,dz=Math.cos(a)*.15,h=.22+(k%2)*.09;
          const leafMesh=[[px,.10,z],[px+dx*.4-dz*.24,.10+h*.67,z+dz*.4+dx*.24],[px+dx,.10+h,z+dz],[px+dx*.4+dz*.24,.10+h*.67,z+dz*.4-dx*.24]];
          m.face(leafMesh,k%2?dark:leaf,false);m.face([...leafMesh].reverse(),k%2?dark:leaf,false);
        }
        if(index===2&&j%2===0)m.cone(px,.104,z,.059,.066,'#ca9a53',5,.035);
      }
    }
  }
  // Market stall, barrels and a modest trail marker.
  shadow(m,-6.4,7.5,2.0,1.2,0);m.box(-7,.12,8,2.4,.85,1.2,'#86613a');m.box(-7,.97,8,2.7,.12,1.4,'#b39058');
  for(const x of [-8.2,-5.8])m.box(x,.1,8.4,.11,2.7,.11,'#6f5033');
  for(let i=0;i<5;i++){
    m.face([[-8.4+i*.56,2.8,8.8],[-7.84+i*.56,2.8,8.8],[-7.84+i*.56,2.35,7.2],[-8.4+i*.56,2.35,7.2]],i%2?'#c9b986':'#9c5a42');
    m.face([[-8.4+i*.56,2.35,7.2],[-7.84+i*.56,2.35,7.2],[-7.84+i*.56,2.12,7.2],[-8.4+i*.56,2.12,7.2]].reverse(),i%2?'#b7a776':'#8d513b');
  }
  rect(-7,8,3,1.8);for(const [x,z] of [[-9,8],[-9.5,9],[6.9,-6.4]]){barrel(m,x,z);rect(x,z,.9,.9);}
  m.box(2.7,0,11,.11,2.1,.11,'#705337');m.box(2.7,1.60,11,1.5,.31,.10,'#9c7b49');
  // Sparse little ground accents produce age and scale at very little render cost.
  for(let i=0;i<140;i++){
    const x=(hash('gx'+i)%400)/10-20,z=(hash('gz'+i)%400)/10-20;
    if(Math.hypot(x,z-3)<7.6||Math.abs(x)<2.2||Math.abs(z-3)<1.8||x<-13.2||x>6&&x<16&&z<-2)continue;
    const c=i%8===0?'#c2b975':i%8===1?'#a5b1a0':'#71874a';
    m.face([[x-.14,.008,z],[x+.05,.008,z+.13],[x+.20,.008,z-.08]],c,false);
    if(i%5===0)m.face([[x-.06,.008,z],[x,.27,z+.01],[x+.05,.008,z+.03]],'#8c9a53');
  }
  townDetails(m,hash);
  return{mesh:m,obstacles};
}

function limb(m,a,b,r1,r2,c,n=4){
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],l=Math.hypot(dx,dy,dz)||1,axis=[dx/l,dy/l,dz/l];
  let u=Math.abs(axis[1])>.9?[1,0,0]:[axis[2],0,-axis[0]],ul=Math.hypot(...u)||1;u=u.map(v=>v/ul);
  const v=[axis[1]*u[2]-axis[2]*u[1],axis[2]*u[0]-axis[0]*u[2],axis[0]*u[1]-axis[1]*u[0]];
  const points=(p,r)=>Array.from({length:n},(_,i)=>{const t=i*TAU/n+Math.PI/4;return p.map((k,j)=>k+(u[j]*Math.cos(t)+v[j]*Math.sin(t))*r);});
  const p=points(a,r1),q=points(b,r2);for(let i=0;i<n;i++){const j=(i+1)%n;m.face([p[i],p[j],q[j],q[i]],c);}m.face(q,c);
}
function frontQuad(m,x,y,z,w,h,color){m.face([[x-w/2,y,z],[x+w/2,y,z],[x+w/2,y+h,z],[x-w/2,y+h,z]],color,false);}

export function classFor(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'codex': return 'Mage';
    case 'claude': return 'Ranger';
    case 'opencode': return 'Warrior';
    case 'hermes': return 'Guildmaster';
    default: return 'Adventurer';
  }
}

const LIVERIES = {
  Mage: ['#4d67ad', '#56549b', '#4f71a8'],
  Ranger: ['#4c713c', '#5e753a', '#447345'],
  Warrior: ['#889cad', '#9dabb2', '#81a0a4'],
  Guildmaster: ['#8f416e', '#8f416e', '#8f416e'],
  Adventurer: ['#ad8b51', '#ad8b51', '#ad8b51'],
};

function gem(mesh, x, y, z, radius, height, color) {
  mesh.cone(x, y, z, radius * .35, height * .38, color, 5, radius);
  mesh.cone(x, y + height * .38, z, radius, height * .62, color, 5);
}

function mageGear(mesh, bob, robe, rightHand, working) {
  const waist = 1.04 + bob;
  // Fluted hem, contrasting silk facings and a crooked peaked felt hat.
  loft(mesh, ring(0, .26 + bob, .02, .34, .26, 8), ring(0, waist, 0, .23, .17, 8), robe, false);
  loft(mesh, ring(0, .25 + bob, .02, .35, .27, 8), ring(0, .31 + bob, .02, .34, .26, 8), '#ccb776', false);
  mesh.face([[-.07,.29+bob,.28],[.07,.29+bob,.28],[.04,waist,.18],[-.04,waist,.18]], '#abbada', false);
  mesh.cone(0, 1.76 + bob, -.01, .365, .065, robe, 9, .31, .12);
  const base = ring(0, 1.81 + bob, -.01, .255, .225, 8);
  const bend = ring(-.045, 2.11 + bob, -.03, .13, .125, 8);
  loft(mesh, base, bend, robe, false);
  for (let i = 0; i < bend.length; i++) {
    mesh.face([bend[i], [-.20, 2.39 + bob, -.09], bend[(i + 1) % bend.length]], robe);
  }
  mesh.cone(0, 1.835 + bob, -.012, .251, .06, '#c5ac62', 8, .23);
  // A working mage carries the staff in a sling to free both hands.
  const hand = working ? [-.28, 1.0, -.22] : rightHand;
  const foot = [hand[0] + .03, .14, hand[2] - .03];
  const crown = [hand[0] - (working ? .30 : .055), 2.17 + bob, hand[2] + .04];
  limb(mesh, foot, crown, .034, .048, '#6f4b32', 5);
  for (const side of [-1, 1]) {
    limb(mesh, crown, [crown[0]+side*.11,crown[1]+.12,crown[2]], .042, .015, '#b49c61', 4);
  }
  gem(mesh, crown[0], crown[1] + .035, crown[2], .10, .19, '#86dadb');
}

function rangerGear(mesh, bob, rightHand, working) {
  const green = '#49643a';
  // The pointed leather hood frames the face and the quiver clears the cape.
  loft(mesh, ring(0,1.72+bob,-.03,.223,.19,7),ring(0,1.94+bob,-.08,.16,.15,7),green);
  mesh.cone(0,1.93+bob,-.09,.16,.11,green,7,.05);
  for (const side of [-1,1]) {
    limb(mesh, [side*.18,1.75+bob,-.005], [side*.18,1.47+bob,-.02], .075,.085,green,4);
  }
  mesh.face([[-.245,1.35+bob,.175],[-.18,1.37+bob,.176],[.22,1.02+bob,.17],[.15,1.0+bob,.17]].reverse(),'#9b7647',false);
  const base=[-.12,.63+bob,-.30], mouth=[.24,1.54+bob,-.31];
  limb(mesh,base,mouth,.073,.119,'#975e39',6);
  limb(mesh,[.213,1.47+bob,-.31],mouth,.12,.122,'#c6a568',6);
  for (let i=0;i<3;i++) {
    const x=.17+i*.06, tip=[x+.13,1.86+bob-(i%2)*.06,-.31+i*.027];
    limb(mesh,[x,1.47+bob,-.31+i*.027],tip,.013,.013,'#a7894b',3);
    limb(mesh,[tip[0]-.025,tip[1]-.085,tip[2]],tip,.035,.012,'#dccb9e',3);
  }
  const origin = working ? [-.38,1.17+bob,-.30] : rightHand;
  const curve = [[0,-.68,.01],[-.09,-.46,.10],[-.065,-.19,.17],[0,0,.19],
    [.04,.23,.17],[.02,.47,.10],[-.06,.70,.01]].map(([x,y,z])=>
      [origin[0]+x,origin[1]+y,origin[2]+z-(working?0:.19)]);
  for(let i=1;i<curve.length;i++)limb(mesh,curve[i-1],curve[i],.028,.025,'#ad7841',4);
  limb(mesh,curve[0],curve.at(-1),.009,.009,'#d1bf8c',3);
}

function warriorGear(mesh,bob,rightHand,leftHand,working) {
  const steel='#9aaab9', shade='#536c7c';
  loft(mesh,ring(0,1.65+bob,-.015,.214,.195,8),ring(0,1.91+bob,-.024,.175,.155,8),steel);
  mesh.cone(0,1.91+bob,-.025,.171,.11,steel,8,.055);
  mesh.box(0,1.66+bob,.162,.38,.12,.07,shade);
  frontQuad(mesh,0,1.685+bob,.202,.275,.036,'#252f38');
  frontQuad(mesh,0,1.53+bob,.196,.045,.19,steel);
  for(const side of [-1,1]){
    const cx=side*.285;
    loft(mesh,ring(cx,1.19+bob,0,.174,.19,6),ring(cx,1.42+bob,0,.105,.13,6),steel);
  }
  const sx=working?-.25:leftHand[0]+.08, sy=working?1.13+bob:leftHand[1]+.04, sz=working?-.40:leftHand[2]+.10;
  const shield=[[-.245,.24],[.24,.24],[.22,-.12],[0,-.43],[-.22,-.12]];
  const panel = shield.map(([x,y])=>[x+sx,y+sy,sz]);
  mesh.face(panel,shade); mesh.face([...panel].reverse(),shade);
  const rim=shield.map(([x,y])=>[x*.84+sx,y*.86+sy,sz+.03]);
  const boss=[sx,sy+.03,sz+.12];
  for(let i=0;i<rim.length;i++)mesh.face([rim[i],boss,rim[(i+1)%rim.length]],i%2?'#56778b':'#7896a6');
  gem(mesh,sx,sy,sz+.12,.05,.08,'#d6be78');
  const hand=working?[.27,1.04,-.28]:rightHand, x=hand[0], y=hand[1], z=hand[2];
  limb(mesh,[x,y-.10,z],[x,y+.16,z],.034,.035,'#6d4c35');
  mesh.box(x,y+.15,z,.31,.05,.065,'#bea15e');
  const tip=[x+(working?.25:-.25),y+.99,z+.01], edge1=[x-.045,y+.23,z],edge2=[x+.075,y+.22,z],spine=[x+.012,y+.34,z+.044];
  mesh.face([edge1,spine,tip],'#abbfc9');mesh.face([spine,edge2,tip],'#d1dce2');
  mesh.face([tip,edge2,edge1],'#8398a3');
}

function guildmasterGear(mesh,bob) {
  const velvet='#883f66',gold='#ddbd6c';
  loft(mesh,ring(0,.33+bob,.01,.33,.255,8),ring(0,1.03+bob,0,.22,.17,8),velvet);
  loft(mesh,ring(0,1.15+bob,0,.42,.27,8),ring(0,1.39+bob,0,.23,.18,8),'#cbbfa2',false);
  mesh.cone(0,1.79+bob,0,.214,.10,gold,8,.22);
  for(let i=0;i<8;i++){
    const a=i*TAU/8, x=Math.cos(a)*.185, z=Math.sin(a)*.185;
    mesh.cone(x,1.88+bob,z,.063,i%2?.12:.19,gold,4,.015);
  }
  gem(mesh,0,1.8+bob,.212,.042,.074,'#9e4146');
  limb(mesh,[-.27,.28,-.30],[-.48,2.51+bob,-.39],.027,.027,'#775336',4);
  mesh.rod([-.51,2.47+bob,-.39],[.08,2.47+bob,-.39],.026,gold);
  const pennon=[[-.45,2.43+bob,-.39],[.045,2.43+bob,-.39],[.045,2.10+bob,-.39],[-.20,1.96+bob,-.39],[-.45,2.10+bob,-.39]];
  mesh.face(pennon,velvet,false);mesh.face([...pennon].reverse(),velvet,false);
  frontQuad(mesh,-.20,2.08+bob,-.385,.065,.29,gold);
  frontQuad(mesh,-.20,2.24+bob,-.382,.23,.055,gold);
}

// Seconds per complete movement, shared with the baked Metal poses.
export const WORK_CYCLES={idle:1,walk:TAU/10,wood:1.85,mine:2.05,smith:1.5,fish:4.8,farm:2.3};

// Phase, lower grip (x,y,z), shaft elevation, sideways angle, crouch, forward
// lean and shoulder turn. The hit sits on an exact baked frame in each swing.
const STROKES={
  wood:[
    [0,.21,1.11,.34,.64,-.16,.02,.06,.00],
    [.25,.33,1.42,.02,1.24,1.88,.01,-.06,.43],
    [.375,.37,1.48,-.07,1.36,2.19,.00,-.11,.49],
    [.50,.09,1.00,.31,-.04,-.06,.13,.23,-.26],
    [.5625,-.01,.96,.30,-.11,-.20,.13,.25,-.32],
    [.69,.04,1.01,.32,-.04,-.11,.10,.20,-.24],
    [.88,.20,1.09,.35,.42,-.11,.03,.08,-.04],
  ],
  mine:[
    [0,.17,1.03,.32,.50,-.12,.05,.15,.00],
    [.19,.22,1.36,.20,1.42,-.18,.01,.02,-.03],
    [.375,.22,1.63,.07,2.12,.04,.00,-.11,.08],
    [.50,.075,1.20,.23,-.09,-.06,.13,.25,-.10],
    [.5625,.07,1.18,.23,-.12,-.07,.14,.26,-.12],
    [.69,.10,1.11,.31,.12,-.03,.10,.20,-.08],
    [.88,.16,1.04,.34,.45,-.09,.06,.15,.00],
  ],
  smith:[
    [0,.18,1.10,.37,.62,-.16,.035,.12,-.01],
    [.25,.28,1.46,.17,1.54,-.05,.00,-.01,.10],
    [.375,.28,1.55,.11,1.88,.01,.00,-.06,.14],
    [.50,.10,1.27,.41,-.01,-.14,.07,.19,-.13],
    [.5625,.11,1.29,.40,.09,-.13,.07,.18,-.12],
    [.75,.20,1.28,.31,.51,-.14,.035,.11,-.02],
  ],
  farm:[
    [0,.16,1.00,.25,.13,-.16,.06,.16,.10],
    [.19,.17,1.20,.39,.41,-.09,.03,.08,.17],
    [.30,.11,1.06,.47,-.29,-.03,.10,.20,.05],
    [.375,.06,.94,.44,-.61,.00,.14,.28,-.06],
    [.50,.04,.96,.33,-.66,.00,.15,.30,-.12],
    [.6875,.04,1.00,.12,-.74,-.03,.14,.25,-.16],
    [.8125,.10,1.08,.09,-.30,-.10,.07,.11,.02],
  ],
  fish:[
    [0,.19,1.16,.27,.98,-.12,.02,.04,.00],
    [.125,.26,1.41,.06,1.94,.46,.00,-.08,.18],
    [.208,.15,1.18,.36,.38,.02,.09,.20,-.12],
    [.333,.15,1.14,.36,.26,-.02,.055,.16,-.08],
    [.50,.15,1.12,.34,.28,-.02,.045,.12,-.05],
    [.625,.14,1.11,.34,.24,-.01,.06,.16,-.08],
    [.6875,.12,1.04,.35,.06,.01,.10,.26,-.12],
    [.75,.18,1.25,.20,1.12,.01,.04,-.05,.02],
    [.875,.18,1.27,.20,.99,-.07,.035,.04,.02],
  ],
};
const TOOL_LENGTH={wood:.74,mine:.80,smith:.58,fish:1.46,farm:1.13};
function tweenFrames(frames,t){
  let i=1;while(i<frames.length&&t>frames[i][0])i++;
  const a=frames[i-1],b=i===frames.length?frames[0]:frames[i],end=i===frames.length?1:b[0];
  const u=(t-a[0])/(end-a[0]),s=u*u*(3-2*u);
  return a.slice(1).map((v,j)=>v+(b[j+1]-v)*s);
}

function playerShoulder(side){return [side*.252,1.355,0];}
function equippedWrist(side,bob=0,swing=0){
  return side<0 ? [-.34,.90+bob,.085-swing*.70] : [.34,.95+bob,.138+swing*.60];
}
// The pre-HD default Dance repeats five raised-arm accents over each leg.
// Both elbows stay up as the forearms fold, reach forward, and fold again.
// The first foot flicks back; the second kicks diagonally out in front.
function danceEase(value){
  const u=Math.max(0,Math.min(1,value));
  return u*u*(3-2*u);
}
export function playerDancePose(phase){
  const progress=((phase%1)+1)%1, phrase=progress*2%1, kickingSide=progress<.5?1:-1;
  const open=danceEase(phrase/.05)*danceEase((1-phrase)/.09);
  // A brief hold on either end of each swing keeps the silhouette legible.
  const reach=danceEase((1-Math.cos(TAU*(phrase-.05)/.20))*.5);
  const weight=-kickingSide*(.069+.019*reach)*open;
  const bob=(-.031+.022*reach)*open;
  const turn=(-.04-.30*reach)*open;
  const roll=-kickingSide*(.058-.043*reach)*open;
  const cy=Math.cos(turn),sy=Math.sin(turn),cr=Math.cos(roll),sr=Math.sin(roll);
  function torso([x,y,z]){
    const across=cy*x+sy*z,height=y-.87;
    return [weight+cr*across-sr*height,.87+bob+sr*across+cr*height,cy*z-sy*x];
  }
  const elbows=[],wrists=[],legs=[];
  for(const side of [-1,1]){
    // The face looks down +Z: the anatomical right is the -X side.
    const restHand=equippedWrist(side);
    const restElbow=equippedElbow(playerShoulder(side),restHand,side);
    const elbow=[side*(.56+.012*reach),1.38-.027*reach-side*.023*(1-reach),.015+.08*reach];
    const wrist=[elbow[0]+side*(.12+.024*reach)-.135*reach,
      elbow[1]+.345*(1-reach)+.008*reach,elbow[2]+.028+.247*reach];
    elbows.push(torso(interp(restElbow,elbow,open)));
    wrists.push(torso(interp(restHand,wrist,open)));
    const hip=torso([side*.135,.87,0]),ankle=[side*.135,.14,0];
    let toeTurn=0;
    if(side===kickingSide && open>0){
      const forward=side<0;
      ankle[0]+=side*open*(forward?.285+.126*reach:.25+.105*reach);
      ankle[1]+=open*(forward?.216+.045*reach:.18-.095*reach);
      ankle[2]+=open*(forward?.18+.105*reach:-.205+.09*reach);
      toeTurn=side*open*(.18+.14*reach);
    }
    const knee=interp(hip,ankle,(.87-.47)/(.87-.14));
    // The upturned rear heel folds underneath its knee. On the forward
    // kicks the shin unbends as the boot reaches its outermost position.
    const bend=side===kickingSide?(side>0?.19-.12*reach:.12-.09*reach):.035;
    knee[2]+=open*bend;
    legs.push({hip,knee,ankle,yaw:toeTurn});
  }
  return {bob,torso,right:wrists[0],left:wrists[1],elbows,legs};
}
const along=(p,v,k)=>[p[0]+v[0]*k,p[1]+v[1]*k,p[2]+v[2]*k];
const interp=(a,b,k)=>a.map((v,i)=>v+(b[i]-v)*k);
export function workPoseAt(activity,phase){
  if(!STROKES[activity])return null;
  const t=((phase%1)+1)%1;
  const [x,y,z,e,a,crouch,lean,twist]=tweenFrames(STROKES[activity],t);
  const dir=[Math.cos(e)*Math.sin(a),Math.sin(e),Math.cos(e)*Math.cos(a)];
  const lateral=[Math.cos(a),0,-Math.sin(a)],up=[-Math.sin(e)*Math.sin(a),Math.cos(e),-Math.sin(e)*Math.cos(a)];
  const right=[x,y,z],left=along(right,dir,activity==='smith'?.17:activity==='fish'?.23:.31);
  if(activity==='fish'){
    const reel=Math.max(0,Math.min(1,(t-.71875)/.20))*TAU*1.5;
    const grip=along(along(along(right,dir,.18+.059*Math.cos(reel)),up,-.10+.055*Math.sin(reel)),lateral,-.14);
    left.splice(0,3,...grip);
  }
  if(activity==='smith'){left[0]=-.22;left[1]=1.08;left[2]=.42;}
  return {activity,t,right,left,dir,lateral,up,head:along(right,dir,TOOL_LENGTH[activity]),crouch,lean,twist};
}

function leanPoint(p,bob,pose){
  if(!pose)return p;
  const pivot=.82+bob,dy=p[1]-pivot,blend=Math.max(0,Math.min(1,dy/.54)),turn=pose.twist*blend,pitch=pose.lean*blend;
  const x=p[0]*Math.cos(turn)+p[2]*Math.sin(turn),z=p[2]*Math.cos(turn)-p[0]*Math.sin(turn);
  return [x,pivot+dy*Math.cos(pitch)-z*Math.sin(pitch),z*Math.cos(pitch)+dy*Math.sin(pitch)];
}
function headPoint(p,a,b,c) {return along(along(along(p.head,p.lateral,a),p.up,b),p.dir,c);}
function wedge(m,p,outline,half,color,bevel){
  const side=n=>outline.map(([a,b,c])=>headPoint(p,a+n*half,b,c));
  const left=side(-1),right=side(1);m.face(left,color);m.face([...right].reverse(),color);
  for(let i=0;i<left.length;i++){
    const j=(i+1)%left.length;m.face([left[i],left[j],right[j],right[i]],i===1?bevel:color);
  }
}
function impactFlakes(m,p,origin,color,contact,life){
  const age=(p.t-contact)/life,visible=age>=0&&age<1,k=visible?age:0;
  for(let i=0;i<3;i++){
    const x=origin[0]+(i-1)*(.050+k*.35),z=origin[2]-(.03+i*.035)-k*(.13+i*.1);
    const y=visible?origin[1]+k*(1-k)*.9+k*(.07-i*.08):-1;
    const r=visible?.037*(1-k)+.005:.001;
    m.face([[x-r,y,z],[x+r,y+.02,z-.03],[x,y+r*1.7,z+.02]],color,false);
    m.face([[x,y+r*1.7,z+.02],[x+r,y+.02,z-.03],[x-r,y,z]],color,false);
  }
}

const FLOAT_PATH=[
  [0,.18,.88,1.01],[.125,.34,1.24,-.29],[.20,.13,1.8,1.42],[.25,.07,1.40,2.16],
  [.333,.05,.095,2.80],[.50,.05,.084,2.81],[.625,.04,.10,2.78],[.6875,.04,.05,2.8],
  [.75,.08,.19,2.45],[.8125,.10,.42,1.98],[.875,.14,.73,1.51],
];
const rodBends=[[0,-.13],[.125,-.24],[.20,.22],[.27,-.20],[.333,-.09],[.625,-.10],[.6875,-.39],[.75,-.22],[.875,-.11]];
function fishingTackle(m,p){
  const bend=tweenFrames(rodBends,p.t)[0];
  const rod=part=>along(along(p.right,p.dir,.20+TOOL_LENGTH.fish*part),p.up,bend*part*part);
  const grip=along(p.right,p.dir,-.15);limb(m,grip,rod(0),.046,.039,'#8b663d',5);
  const spool=along(along(p.right,p.dir,.18),p.up,-.10),crank=along(spool,p.lateral,-.14);
  limb(m,along(spool,p.lateral,.025),along(spool,p.lateral,-.088),.068,.068,'#bca76b',6);
  limb(m,along(spool,p.lateral,-.087),crank,.026,.019,'#656955',4);
  limb(m,crank,p.left,.017,.018,'#b09a61',4);
  for(let i=0;i<4;i++)limb(m,rod(i/4),rod((i+1)/4),.036-i*.006,.030-i*.006,'#ac8550',4);
  const tip=rod(1),float=tweenFrames(FLOAT_PATH,p.t);
  const middle=interp(tip,float,.48);
  // During the cast the line unfurls in the air. A hooked float takes up the slack.
  middle[1]-=p.t>.14&&p.t<.33?.24:.065;
  limb(m,tip,middle,.010,.009,'#eadab1',3);limb(m,middle,float,.009,.010,'#eadab1',3);
  m.cone(float[0],float[1]-.06,float[2],.045,.085,'#eee3bd',6,.075);
  m.cone(float[0],float[1]+.025,float[2],.075,.075,'#d8623c',6,.024);
  const rippleAge=(p.t-.333)/.19,show=rippleAge>=0&&rippleAge<1,rad=show?.10+rippleAge*.29:.02;
  const cy=show?.036:-.16;
  for(let i=0;i<8;i++){
    const at=i*TAU/8,next=at+TAU/8*.68;
    const v=(q,r)=>[.05+Math.cos(q)*r,cy,2.80+Math.sin(q)*r];
    m.face([v(at,rad),v(next,rad),v(next,rad+.025),v(at,rad+.025)],'#90b8af',false);
  }
}
function craftTools(m,p){
  if(p.activity==='fish'){fishingTackle(m,p);return;}
  const butt=along(p.right,p.dir,-.14);
  limb(m,butt,p.head,p.activity==='smith'?.038:.045,.031,'#937044',5);
  limb(m,butt,p.right,.047,.044,'#624b35',5);
  const origin=p.head;
  if(p.activity==='wood'){
    // Thick socket, flared beard and thin cutting edge curve around the trunk.
    wedge(m,p,[[0,.09,-.10],[0,.24,.13],[0,.15,.22],[0,-.16,.19],[0,-.20,.05],[0,-.055,-.05]],.074,'#8e9da0','#cdd5c9');
    const cheek=[[0,.22,.12],[0,.15,.22],[0,-.16,.19],[0,-.19,.09]].map(([a,b,c])=>headPoint(p,a+.077,b,c));
    m.face(cheek,'#cbd4ca',false);
    impactFlakes(m,p,[.03,.96,1.25],'#d3ae6d',.50,.17);
  }else if(p.activity==='mine'){
    // Adze and long, slightly down-curved pick lie in the plane of the blow.
    const collar=headPoint(p,0,.01,-.03),top=headPoint(p,0,.19,-.075),spike=headPoint(p,0,-.10,.12),point=headPoint(p,0,-.335,.19);
    limb(m,top,collar,.033,.065,'#9daaaa',4);limb(m,collar,spike,.065,.041,'#a4afab',4);
    limb(m,spike,point,.040,.004,'#d4dbcc',4);impactFlakes(m,p,[.05,.91,1.13],'#d2c59c',.50,.15);
  }else if(p.activity==='smith'){
    // The full square face of the hammer reaches the glowing billet; tongs hold it.
    wedge(m,p,[[0,-.125,-.10],[0,-.125,.105],[0,.095,.13],[0,.17,-.065],[0,.08,-.11]],.108,'#82918e','#b8c4b9');
    const jaw=[-.028,1.175,.99],hinge=[-.15,1.16,.67];
    for(const side of [-1,1]){
      limb(m,[p.left[0]+side*.027,p.left[1],p.left[2]],hinge,.022,.018,'#616663',4);
      limb(m,hinge,[jaw[0]+side*.063,jaw[1],jaw[2]],.017,.016,'#555d57',4);
    }
    impactFlakes(m,p,[.06,1.20,.98],'#ffbd5c',.50,.19);
  }else if(p.activity==='farm'){
    const bar=headPoint(p,0,-.05,.015);
    limb(m,along(bar,p.lateral,-.19),along(bar,p.lateral,.19),.033,.03,'#89918b',4);
    for(const dx of [-.15,-.05,.05,.15]){
      const root=along(bar,p.lateral,dx);
      limb(m,root,along(root,p.up,-.20),.025,.012,'#b7beb0',4);
    }
    impactFlakes(m,p,[.04,.12,1.18],'#93704c',.375,.25);
  }
}

const PARTYHAT_PAPER={
  'blue-partyhat':['#191ca7','#3439f2','#161990','#262ccd'],
  'white-partyhat':['#c0bec1','#fcf9f2','#a6a4ab','#dedbd6'],
  'red-partyhat':['#841d10','#bf2c19','#72190d','#a52315'],
  'purple-partyhat':['#8e21ac','#cb30f6','#741893','#a925d0'],
  'green-partyhat':['#1d9f28','#27ee32','#168321','#21c82c'],
  'yellow-partyhat':['#b4b622','#f5f333','#95951b','#d3d52b'],
};
function partyhat(m,paper){
  // A single blue paper strip. The cuts rise directly out of the folded band.
  const sides=16,folds=ring(0,1.765,-.014,.162,.154,sides,.16);
  const top=folds.map(([x,y,z],i)=>[x*1.01,i%2?1.849:1.975,z]);
  for(let i=0;i<sides;i++){
    const j=(i+1)%sides;
    const light=.5+.5*Math.cos(TAU*i/sides-1.05);
    const outside=mix(paper[0],paper[1],light),inside=mix(paper[2],paper[3],1-light);
    m.face([folds[i],top[i],top[j],folds[j]],outside,false);
    const inner=p=>[p[0]*.978,p[1],p[2]*.978];
    m.face([inner(folds[j]),inner(top[j]),inner(top[i]),inner(folds[i])],inside,false);
  }
}

function santaHat(m){
  const brim=ring(0,1.715,-.012,.177,.169,9,.14);
  const cuff=ring(0,1.773,-.012,.181,.172,9,.14).map(([x,y,z])=>[x,y+.043*x,z]);
  loft(m,brim,cuff,'#f0e9db',false);
  const crown=ring(-.014,1.911,-.029,.141,.132,9,.14);
  loft(m,cuff,crown,'#b22a22',false);
  loft(m,crown,ring(.043,1.955,-.055,.065,.075,9,.14),'#c62d23');
  // The folded tip hangs to one side. Its pompon sits beside the brim.
  limb(m,[.042,1.94,-.055],[.136,1.877,-.068],.071,.077,'#af211c',6);
  limb(m,[.136,1.877,-.068],[.174,1.784,-.064],.078,.048,'#b02420',6);
  const bottom=ring(.174,1.728,-.066,.034,.032,7);
  const middle=ring(.174,1.767,-.066,.066,.058,7);
  loft(m,bottom,middle,'#e4dece',false);
  loft(m,middle,ring(.174,1.810,-.067,.033,.033,7),'#fff9ed');
}

const HALLOWEEN_HIDE={
  'red-halloween-mask':'#ae2b22','green-halloween-mask':'#187122','blue-halloween-mask':'#232895',
};
function halloweenMask(m,hide){
  const jaw=playerSection(1.440,.029,.119,.139),cheek=playerSection(1.606,0,.171,.169);
  const brow=playerSection(1.764,-.009,.168,.168);
  loft(m,jaw,cheek,hide,false);loft(m,cheek,brow,hide,false);
  loft(m,brow,playerSection(1.856,-.012,.098,.115),hide);
  for(const s of [-1,1]){
    limb(m,[s*.108,1.803,-.028],[s*.219,2.035,-.060],.061,.003,'#e1d6cf',5);
    playerFront(m,[[s*.018,1.710,.164],[s*.106,1.731,.163],[s*.120,1.697,.167],[s*.066,1.674,.169],[s*.018,1.681,.170]],'#211b1b');
    playerFront(m,[[0,1.677,.169],[s*.041,1.619,.173],[0,1.610,.216]],mix(hide,s<0?'#421c1a':'#e6b79c',s<0?.16:.12));
  }
  playerFront(m,[[-.096,1.572,.173],[.096,1.572,.173],[.079,1.455,.175],[-.078,1.455,.175]],'#341e1c');
  for(const s of [-1,1]){
    playerFront(m,[[s*.093,1.576,.176],[s*.003,1.576,.177],[s*.059,1.439,.187]],'#ede6d6');
    playerFront(m,[[s*.076,1.453,.179],[s*.003,1.453,.180],[s*.028,1.510,.183]],'#d4caba');
  }
}

function playerHeadgear(m,id){
  if(PARTYHAT_PAPER[id])partyhat(m,PARTYHAT_PAPER[id]);
  else if(HALLOWEEN_HIDE[id])halloweenMask(m,HALLOWEEN_HIDE[id]);
  else if(id==='santa-hat')santaHat(m);
}

// Cut corners leave a broad, flat front for the woven chest and the face.
function playerSection(y,z,rx,rz){
  return [[1,.48],[.68,1],[-.68,1],[-1,.48],[-1,-.48],[-.68,-1],[.68,-1],[1,-.48]]
    .map(([u,v])=>[u*rx,y,z+v*rz]);
}

// The software renderer culls by each polygon's leading triangle. Give
// mirrored badges, facial features and fringe a consistent front winding.
function playerFront(m,points,color){
  const [a,b,c]=points;
  const z=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  m.face(z<0?points.reverse():points,color,false);
}

function dragonMail(m){
  const hem=playerSection(.972,.001,.211,.143),shoulders=playerSection(1.352,0,.255,.164);
  loft(m,hem,shoulders,'#b13827',false);
  loft(m,shoulders,playerSection(1.404,-.002,.159,.113),'#a92f20');
  // Raised lozenges tile the shirt, including its side facets. The large
  // black dragon at the sternum remains legible after the mail resolves to pixels.
  for(let panel=0;panel<8;panel++){
    const next=(panel+1)%8,count=panel%4===1?4:1;
    const point=(across,height)=>{
      const p=interp(interp(hem[panel],shoulders[panel],height),interp(hem[next],shoulders[next],height),across);
      return [p[0]*1.009,p[1],p[2]*1.009];
    };
    for(let row=0;row<3;row++)for(let k=0;k<count;k++){
      const y=(row+.5)/3,x=(k+.5)/count;
      const top=point(x,y+.144),bottom=point(x,y-.144);
      m.face([bottom,point(x-.48/count,y),top],'#84251e',false);
      m.face([point(x+.48/count,y),bottom,top],'#a53c2c',false);
    }
  }
  const crest=(outline,ink)=>playerFront(m,outline.map(([x,y])=>[x*.9,y,.151+(y-.972)*.054]),ink);
  for(const side of [-1,1]){
    const wing=[[.025,1.285],[.151,1.310],[.188,1.287],[.133,1.222],[.146,1.196],[.083,1.168],[.084,1.141],[.043,1.132]];
    crest(wing.map(([x,y])=>[x*side,y]),'#2e1917');
  }
  crest([[-.034,1.312],[-.013,1.281],[.013,1.281],[.035,1.313],[.043,1.244],[.007,1.131],[-.036,1.239]],'#201918');
}

function bandosChestplate(m,skin){
  const shoulders=playerSection(1.355,0,.259,.160);
  loft(m,playerSection(.970,0,.206,.143),shoulders,skin,false);
  loft(m,shoulders,playerSection(1.403,-.003,.139,.103),skin);
  const hem=playerSection(.972,.002,.221,.153),chest=playerSection(1.187,.003,.244,.167);
  loft(m,hem,chest,'#625760',false);
  loft(m,chest,playerSection(1.215,.003,.246,.169),'#79696e');
  const edge=playerSection(.948,.003,.219,.152);
  loft(m,edge,hem,'#4c393b',false);
  // Dark harness straps and brass loops cross the exposed upper chest.
  for(const side of [-1,1]){
    playerFront(m,[[side*.215,1.364,.135],[side*.144,1.383,.164],[side*.042,1.250,.175],[side*.094,1.226,.175]],'#4c4449');
    limb(m,[side*.173,1.375,.145],[side*.174,1.377,-.114],.038,.041,'#564b50',4);
    limb(m,[side*.174,1.372,-.108],[side*.088,1.206,-.167],.040,.032,'#55494e',4);
    limb(m,[side*.041,1.259,.173],[side*.070,1.246,.177],.026,.024,'#a5935c',5);
    limb(m,[side*.069,1.248,.176],[side*.093,1.194,.173],.024,.021,'#97875b',5);
  }
  const glyph=[
    [[-.049,1.154],[-.024,1.170],[.031,1.143],[.096,1.132],[.069,1.112],[.026,1.124]],
    [[-.079,1.122],[-.053,1.143],[-.009,1.113],[-.025,1.101]],
    [[-.032,1.101],[-.007,1.115],[.016,1.085],[.052,1.095],[.033,1.073],[-.004,1.070]],
    [[-.017,1.065],[.009,1.080],[.029,1.049],[.001,1.015],[.003,1.044]],
  ];
  for(const mark of glyph)playerFront(m,mark.map(([x,y])=>[x,y,.158+(y-.97)*.068]),'#b0a479');
}

function dragonPlatebody(m){
  // The 2008 plate has a smooth ridged cuirass and pointed flared waist.
  const waist=playerSection(1.043,0,.192,.141),ribs=playerSection(1.277,.006,.260,.182);
  const shoulder=playerSection(1.368,-.002,.260,.153),neck=playerSection(1.414,-.008,.141,.115);
  loft(m,waist,ribs,'#aa2c21',false);loft(m,ribs,shoulder,'#bd3726',false);loft(m,shoulder,neck,'#a92c20');
  const fauld=playerSection(.957,.004,.229,.166);
  const pointed=fauld.map(([x,y,z])=>[x,y-.061*(1-Math.abs(x)/.229),z]);
  loft(m,pointed,waist,'#99291e',false);
  loft(m,waist,playerSection(1.068,.001,.197,.146),'#69221d',false);
  for(const side of [-1,1]){
    playerFront(m,[[0,1.301,.202],[side*.163,1.332,.177],[side*.206,1.265,.174],[side*.158,1.160,.164],[0,1.120,.158]],
      side<0?'#a22b21':'#ad2f23');
    const wing=[
      [[.027,1.285],[.149,1.309],[.182,1.283],[.115,1.234],[.036,1.222]],
      [[.036,1.240],[.115,1.234],[.148,1.205],[.082,1.179],[.037,1.148]],
    ];
    for(const panel of wing)playerFront(m,panel.map(([x,y])=>[side*x,y,.176+.22*(y-1.12)-.075*x]),'#271c19');
  }
  playerFront(m,[[-.030,1.31,.200],[-.010,1.285,.199],[.011,1.285,.199],[.030,1.31,.200],[.025,1.240,.189],[0,1.153,.171],[-.025,1.240,.189]],'#211916');
}

const TUNIC='#637b65';
function playerTorso(m,id,skin){
  if(id==='dragon-chainbody'){dragonMail(m);return;}
  if(id==='bandos-chestplate'){bandosChestplate(m,skin);return;}
  if(id==='dragon-platebody'){dragonPlatebody(m);return;}
  const shoulder=playerSection(1.354,0,.240,.151);
  loft(m,playerSection(.96,0,.206,.14),shoulder,TUNIC,false);
  loft(m,shoulder,playerSection(1.393,-.008,.137,.103),TUNIC);
}

function playerHead(m,skin,hair){
  limb(m,[0,1.38,-.008],[0,1.51,.003],.090,.075,skin,6);
  const chin=playerSection(1.474,.025,.079,.078),jaw=playerSection(1.533,.015,.126,.111);
  const cheek=playerSection(1.644,.005,.144,.127),temple=playerSection(1.748,-.006,.143,.132);
  loft(m,chin,jaw,skin,false);loft(m,jaw,cheek,skin,false);loft(m,cheek,temple,skin);
  const ridge=[0,1.662,.135],tip=[.003,1.583,.169],base=[0,1.57,.129];
  for(const side of [-1,1]){
    playerFront(m,[ridge,[side*.026,1.586,.132],tip],side<0?mix(skin,'#765740',.19):skin);
    playerFront(m,[tip,[side*.026,1.586,.132],base],mix(skin,'#8d684d',.20));
    playerFront(m,[[side*.030,1.647,.134],[side*.079,1.656,.134],[side*.069,1.642,.135]],'#544336');
  }
  const hairline=playerSection(1.688,-.009,.151,.138);
  const templeHair=playerSection(1.741,-.010,.148,.136);
  const underHat=playerSection(1.759,-.013,.130,.113);
  loft(m,hairline,templeHair,hair,false);
  loft(m,templeHair,underHat,hair,false);
  loft(m,underHat,playerSection(1.808,-.020,.085,.073),hair);
  for(const [x,tipX,tipY] of [[-.086,-.114,1.615],[-.036,-.058,1.657],[.036,.008,1.641],[.084,.105,1.617]]){
    playerFront(m,[[x-.027,1.704,.132],[x+.03,1.705,.132],[tipX,tipY,.137]],hair);
  }
  for(const side of [-1,1]){
    m.face([[side*.144,1.71,.068],[side*.153,1.71,-.085],[side*.13,1.584,-.02]],hair,false);
  }
}

function playerArm(m,shoulder,elbow,hand,side,skin,torsoId='dragon-chainbody'){
  const upper=t=>interp(shoulder,elbow,t),fore=t=>interp(elbow,hand,t);
  limb(m,upper(.08),upper(.61),.098,.104,skin,6);
  limb(m,upper(.61),elbow,.104,.069,skin,6);
  limb(m,elbow,fore(.30),.072,.085,skin,6);
  limb(m,fore(.30),hand,.085,.051,skin,6);
  if(torsoId==='dragon-chainbody'){
    limb(m,fore(.55),fore(.96),.081,.059,'#85848c',6);
    limb(m,upper(-.11),upper(.19),.086,.139,'#b43526',6);
    limb(m,upper(.19),upper(.48),.139,.129,'#a62b20',6);
    limb(m,upper(.45),upper(.51),.131,.123,'#4c2522',6);
    const base=upper(.07),tip=[base[0]+side*.128,base[1]+.130,base[2]-.023];
    limb(m,[base[0]+side*.062,base[1]+.047,base[2]],tip,.051,.002,'#d1cfd6',4);
  }else if(torsoId==='bandos-chestplate'){
    // Bandos armour has one heavy left pauldron and three overlapping wrist plates.
    for(let i=0;i<3;i++){
      const t=.08+i*.26;
      limb(m,fore(t),fore(t+.33),.087-i*.008,.136-i*.008,'#676669',6);
    }
    if(side>0){
      for(let i=0;i<2;i++){
        const start=-.17+i*.29,end=.27+i*.29;
        limb(m,upper(start),upper(end),.131-i*.006,.201-i*.016,'#666167',6);
        limb(m,upper(end-.045),upper(end),.203-i*.016,.203-i*.016,'#a29b76',6);
      }
      for(const [t,dy,dz] of [[-.05,.142,.004],[.12,.055,.082],[.31,.040,-.072],[.43,.018,.044]]){
        const [x,y,z]=upper(t);
        limb(m,[x+.104,y+.044,z+dz],[x+.222,y+.05+dy,z+dz+.015],.052,.002,'#b5ac80',5);
      }
    }
  }else if(torsoId==='dragon-platebody'){
    limb(m,upper(-.18),upper(.25),.112,.173,'#b93526',5);
    limb(m,upper(.22),upper(.49),.174,.130,'#9d2a20',5);
    limb(m,upper(.48),upper(.65),.100,.094,'#a82e22',6);
    limb(m,fore(.14),fore(.64),.093,.082,'#a32b20',6);
    limb(m,fore(.60),fore(.98),.085,.059,'#7b7780',6);
    const [x,y,z]=upper(.08);
    limb(m,[x+side*.055,y+.055,z-.027],[x+side*.147,y+.253,z-.062],.064,.002,'#b63124',4);
    limb(m,[x+side*.113,y+.008,z+.022],[x+side*.171,y+.129,z+.068],.040,.002,'#d6d2ca',4);
  }else{
    limb(m,upper(-.06),upper(.42),.105,.115,TUNIC,6);
  }
  const fistEnd=[hand[0]+side*.008,hand[1]-.079,hand[2]+.039];
  limb(m,hand,fistEnd,.061,.071,skin,5);
  limb(m,fistEnd,[fistEnd[0]-side*.016,fistEnd[1]-.032,fistEnd[2]+.008],.071,.039,skin,5);
}

const CAPE_EMBERS=Array.from({length:44},(_,i)=>{
  const jitter=n=>n-Math.floor(n);
  return [.11+.78*jitter(Math.sin(i*73.4+1.7)*1747),.11+.78*jitter(Math.sin(i*59.2+6.1)*2171)];
});
function fireCape(m,phase,motion,classicDetail){
  const beat=TAU*phase;
  const point=(u,v,depth=0)=>{
    const hem=Math.max(0,(v-.77)/.23);
    const x=u*(.194+.128*v)+motion*v*v*Math.sin(beat-v*2.2)*.055;
    const y=1.385-v*1.18+hem*(.071*Math.abs(u)+.037*Math.cos(3*Math.PI*u+.55));
    const z=-.19-.047*(1-Math.abs(u))-.179*v-.034*Math.cos(2*Math.PI*u+.3)*v
            -motion*v*v*(.037+.032*Math.cos(beat-v))-depth;
    return [x,y,z];
  };
  // Distance to the nearest two drifting embers gives us molten channels
  // between rust-red islands. Repeat the seed rows so the clip loops cleanly.
  const ember=(col,row)=>CAPE_EMBERS[((row%4+4)%4)*11+(col%11+11)%11];
  const lava=(u,v)=>{
    const y=v*7.1-phase*4;
    const x=u*(1.56+.65*v)+.24*Math.sin(4.1*v+u)+.19*Math.cos(TAU*y/4+u);
    const z=y+.13*Math.sin(3.2*x+.4*Math.cos(TAU*y/4));
    let first=Infinity,second=Infinity;
    const cx=Math.floor(x),cz=Math.floor(z);
    for(let j=cz-1;j<=cz+1;j++)for(let i=cx-1;i<=cx+1;i++){
      const [du,dv]=ember(i,j),dx=x-i-du,dz=z-j-dv,d=dx*dx+dz*dz;
      if(d<first){second=first;first=d;}else if(d<second)second=d;
    }
    const edge=Math.sqrt(second)-Math.sqrt(first);
    const t=Math.min(1,Math.max(0,(edge-.035)/.46));
    const heat=t*t*(3-2*t),fold=.5+.5*Math.cos(u*5.1+.3);
    return mix(mix('#bd9141','#ddb058',fold),mix('#93421f','#b25b29',fold),heat);
  };
  const cols=classicDetail?7:16,rows=classicDetail?12:26;
  const grid=Array.from({length:rows+1},(_,r)=>Array.from({length:cols+1},(_,c)=>{
    const u=2*c/cols-1,v=r/rows;
    return {p:point(u,v),color:lava(u,v)};
  }));
  const tile=(a,b,c)=>{
    const avg=mix(mix(a.color,b.color,.5),c.color,1/3);
    if(classicDetail){
      // GPUI batches flat triangles with equal paint into the same path.
      const heat=Math.max(0,Math.min(8,Math.round((parseInt(avg.slice(3,5),16)-66)/13)));
      m.face([a.p,b.p,c.p],mix('#964625','#dbab52',heat/8),false);
    }else{
      m.face([a.p,b.p,c.p],avg,false);
      m.faces[m.faces.length-1].vertexColors=[a.color,b.color,c.color];
    }
  };
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const a=grid[r][c],b=grid[r][c+1],d=grid[r+1][c],e=grid[r+1][c+1];
    if((r+c)%2){tile(a,b,d);tile(b,e,d);}else{tile(a,b,e);tile(a,e,d);}
  }
  // A simpler inner lining reads at either side of the legs in the front view.
  for(let r=0;r<4;r++)for(let c=0;c<6;c++){
    const u=c/3-1,v=r/4,nextU=(c+1)/3-1,nextV=(r+1)/4;
    m.face([point(u,v,-.012),point(u,nextV,-.012),point(nextU,nextV,-.012),point(nextU,v,-.012)],'#bf7938',false);
  }
  // A plain leather loop fastens the narrow top to the neck.
  for(const s of [-1,1]){
    limb(m,[s*.14,1.38,-.19],[s*.16,1.413,.06],.016,.018,'#825b2c');
    limb(m,[s*.16,1.413,.06],[0,1.37,.14],.018,.016,'#93682c');
  }
}

function playerCape(m,id,phase,motion,classicDetail){
  if(id==='fire-cape'){fireCape(m,phase,motion,classicDetail);return;}
  if(id!=='slayer-cape-t'&&id!=='cape-of-legends')return;
  const slayer=id==='slayer-cape-t';
  // u runs to the wearer's right. Each fold has an outer cloth surface and a lining.
  const point=(u,v,depth=0)=>{
    const width=(slayer?.180:.124)+v*(slayer?.166:.207);
    const hem=slayer?.045*u*u:.16*Math.abs(u)+.069*Math.cos(u*Math.PI*2);
    const x=-u*width+motion*v*v*.048*Math.sin(phase*TAU-1.8*v);
    const y=1.374-v*1.15+v*v*v*hem;
    const z=-.200-.178*v-.045*(1-Math.abs(u))-(slayer?.017:.044)*Math.cos(2*Math.PI*u)*v
      -motion*v*v*.027*(1+Math.cos(phase*TAU-v))-depth;
    return [x,y,z];
  };
  const rear=(points,ink)=>{ // Keep the rear face visible with GPUI backface culling.
    const [a,b,c]=points;
    const det=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    m.face(det>0?points.reverse():points,ink,false);
  };
  const us=slayer?[-1,-.76,-.44,0,.44,.76,1]:[-1,-.72,-.44,-.22,0,.22,.44,.72,1];
  const vs=[0,.27,.56,.86,.966,1];
  const legends=['#c5c0c5','#ded8d7','#bbb8be','#eee6e2','#d9d4d3','#bdb8bb','#e6e0de','#c5bfc2'];
  for(let row=0;row<vs.length-1;row++)for(let col=0;col<us.length-1;col++){
    const l=us[col],r=us[col+1],t=vs[row],b=vs[row+1];
    const patch=depth=>[point(l,t,depth),point(r,t,depth),point(r,b,depth),point(l,b,depth)];
    const trim=col===0||col===us.length-2||row===vs.length-2;
    const ink=slayer?(trim?(col===0?'#a12b24':'#87251f'):(col<3?'#302b30':'#252127')):legends[col];
    rear(patch(0),ink);
    playerFront(m,patch(-.011),slayer?(trim?'#792720':'#3d3437'):'#c4c0bb');
  }
  if(!slayer){
    for(const s of [-1,1]){
      limb(m,[s*.102,1.352,-.201],[s*.138,1.421,-.020],.026,.026,'#e4deda',4);
      limb(m,[s*.138,1.421,-.020],[s*.10,1.374,.112],.026,.021,'#dad4cf',4);
    }
    return;
  }
  // The trimmed Slayer cape bears a grey skull pierced by a gold-hilted sword.
  const emblem=(coordinates,color,depth=.019)=>{
    const points=coordinates.map(([u,v])=>point(u,v,depth));
    for(let i=1;i<points.length-1;i++)rear([points[0],points[i],points[i+1]],color);
  };
  emblem([[-.47,.499],[-.41,.425],[-.25,.372],[.084,.363],[.260,.397],[.345,.471],[.145,.543],[-.154,.529],[-.356,.528]],'#a39b9f');
  emblem([[.040,.480],[.345,.471],[.536,.500],[.530,.551],[.402,.570],[.249,.551],[.145,.543]],'#a39b9f');
  emblem([[-.149,.496],[.19,.518],[.209,.570],[.059,.552],[-.090,.558]],'#a39b9f');
  emblem([[-.47,.499],[-.41,.425],[-.254,.390],[-.302,.461],[-.208,.523],[-.356,.528]],'#827b82',.024);
  emblem([[-.046,.453],[.047,.432],[.130,.463],[.076,.488],[-.036,.477]],'#30272b',.029);
  emblem([[.212,.443],[.280,.442],[.325,.473],[.245,.480]],'#332a2d',.029);
  emblem([[.142,.483],[.227,.518],[.148,.518]],'#43363a',.029);
  emblem([[-.15,.474],[.273,.328],[.328,.338],[-.015,.460]],'#8c8786',.027);
  emblem([[.201,.320],[.239,.300],[.478,.358],[.433,.380]],'#ceac47',.035);
  emblem([[.290,.319],[.462,.253],[.532,.265],[.383,.343]],'#80623b',.036);
  // The hood rests in a dark crescent between the raised scarlet shoulder flaps.
  emblem([[-1,.000],[-.62,.026],[0,.056],[.63,.026],[1,0],[.73,.092],[.26,.133],[-.27,.133],[-.74,.093]],'#5f575b',.024);
  for(const s of [-1,1]){
    const flap=[[s*.107,1.316,-.180],[s*.168,1.379,-.048],[s*.294,1.508,-.103],[s*.274,1.482,-.207],[s*.178,1.364,-.237]];
    rear(flap.slice(),'#3b353a');
    const inset=flap.map(([x,y,z])=>[x-s*.008,y+.002,z-.009]);
    rear(inset,'#a53328');
    playerFront(m,flap.map(([x,y,z])=>[x,y,z+.005]),'#94271f');
  }
}

function bandosTassets(m,rig){
  // Split gunmetal plates frame one unbroken flax-coloured front panel.
  const waist=playerSection(.973,0,.215,.158),rim=playerSection(1.005,0,.209,.149);
  const drape=(x,y,z,leg,weight)=>{
    const root=rig.torso([x,y,z]),{hip,knee}=leg;
    return [root[0]+(knee[0]-hip[0])*weight,root[1]+(knee[1]-hip[1]+.40)*weight,
      root[2]+(knee[2]-hip[2])*weight];
  };
  for(let i=0;i<8;i++){
    const j=(i+1)%8;
    m.face([waist[i],rim[i],rim[j],waist[j]].map(rig.torso),'#62524d');
  }
  for(const side of [-1,1]){
    const at=(x,y,z,k)=>drape(x*side,y,z,rig.legs[side<0?0:1],k);
    const front=at(.081,.98,.156,0),hip=at(.219,.98,.087,0),back=at(.211,.98,-.097,0);
    const frontTip=at(.158,.664,.157,.49),sideTip=at(.249,.614,.051,.58),backTip=at(.238,.668,-.138,.50);
    const plate=(points,color)=>m.face(side>0?points.reverse():points,color,false);
    plate([front,hip,sideTip,frontTip],'#776e70');
    plate([hip,back,backTip,sideTip],'#615c61');
    plate([back,at(.060,.98,-.159,0),at(.086,.684,-.16,.49),backTip],'#58535a');
  }
  const panel=(width,topY,bottomY,z,inks)=>{
    const fold=(n,y,depth,weight)=>{
      const x=n*width*(weight?1:.78),v=depth+(n===0?.012:0);
      const a=drape(x,y,v,rig.legs[0],weight),b=drape(x,y,v,rig.legs[1],weight);
      return interp(a,b,(n+1)/2);
    };
    const upper=[-1,0,1].map(n=>fold(n,topY,z,0));
    const lower=[-1,0,1].map(n=>fold(n,bottomY+(n===0?.014:0),z+.048,.53));
    for(let i=0;i<2;i++)m.face([lower[i],lower[i+1],upper[i+1],upper[i]],inks[i],false);
  };
  panel(.132,.975,.608,.161,['#8a825d','#9b916b']);
  panel(.114,.966,.631,.165,['#b6aa81','#c2b68b']);
}

function playerLegwear(m,rig,skin,item){
  if(item==='bandos-tassets'){
    for(const {hip,knee,ankle} of rig.legs){
      limb(m,hip,knee,.111,.082,skin,6);
      limb(m,knee,ankle,.084,.058,skin,6);
      limb(m,interp(knee,ankle,.16),interp(knee,ankle,.78),.102,.070,'#565055',6);
    }
    bandosTassets(m,rig);
    return;
  }
  const dragon=item==='dragon-platelegs',silver=item==='third-age-platelegs';
  const hipColor=dragon?'#a42415':silver?'#20292a':'#665342';
  const waist=(y,rx,rz)=>playerSection(y,0,rx,rz).map(rig.torso);
  loft(m,waist(.789,.204,.145),waist(.968,.213,.151),hipColor,false);
  loft(m,waist(.958,.214,.152),waist(.994,.206,.15),dragon?'#631b17':silver?'#17262a':'#4f4135');
  for(const leg of rig.legs){
    const {hip,knee,ankle}=leg;
    if(!dragon&&!silver){
      limb(m,hip,knee,.135,.092,'#715c46',7);
      limb(m,knee,ankle,.096,.059,'#695540',7);
      continue;
    }
    const section=(a,b,t,w,d,reach=0)=>{
      const [x,y,z]=interp(a,b,t);
      return playerSection(y,z+reach,w,d).map(([u,v,h])=>[x+u,v,h]);
    };
    const upper=(t,w,d)=>section(hip,knee,t,w,d);
    const shin=(t,w,d,z=0)=>section(knee,ankle,t,w,d,z);
    const thigh=dragon?'#b32a17':'#d4d1d4';
    limb(m,interp(hip,knee,.73),knee,.103,.091,dragon?'#7b211b':'#777782',7);
    const top=upper(-.08,.140,.142),mid=upper(.41,.143,.143),low=upper(.93,.108,.108);
    loft(m,mid,top,thigh,false);loft(m,low,mid,thigh,false);
    if(dragon){
      for(const t of [.37,.70]){
        const w=.149-Math.max(0,t-.40)*.063;
        loft(m,upper(t+.049,w-.003,w),upper(t,w,w+.002),'#812017',false);
      }
    }else{
      // Ceremonial silver plates fan out below the black V at the hips.
      const bottom=upper(.84,.112,.121),crease=upper(.06,.141,.148);
      const relief=point=>[point[0],point[1],point[2]+.011];
      playerFront(m,[bottom[1],bottom[2],crease[2]].map(relief),'#d1ced0');
      playerFront(m,[bottom[1],crease[2],crease[1]].map(relief),'#b4b2b7');
      const s=Math.sign(hip[0]),p=(x,y,z)=>rig.torso([s*x,y,z]);
      playerFront(m,[p(.205,.972,.139),p(.200,.922,.165),p(.030,.820,.183),p(.001,.841,.186)],'#d6d3d2');
    }
    limb(m,knee,ankle,dragon?.097:.088,.058,dragon?'#771c15':'#686a72',6);
    const guard=shin(dragon?.22:.19,dragon?.127:.115,.117,.012);
    const rim=shin(.10,.090,.096,.005),tip=shin(.97,.061,.066,.014);
    loft(m,guard,rim,dragon?'#a52717':'#adb0b7',false);
    loft(m,tip,guard,dragon?'#bf361f':'#e3dfe0',false);
    if(silver){
      // A faceted knee cup sits in the gap between thigh and greave.
      const upperLip=upper(.84,.090,.107),cup=upper(.94,.111,.130),lowerLip=shin(.10,.089,.095);
      loft(m,cup,upperLip,'#c7c3ca',false);loft(m,lowerLip,cup,'#aba6af',false);
    }
  }
}

function playerFootwear(m,Mesh,leg,item){
  const {ankle,knee,yaw}=leg,boot=new Mesh();
  // The foot stays level while the upper cuff follows the angled shin on a kick.
  const rise=Math.max(.10,knee[1]-ankle[1]),dx=(knee[0]-ankle[0])/rise,dz=(knee[2]-ankle[2])/rise;
  const leanX=Math.max(-1.2,Math.min(1.2,Math.cos(yaw)*dx-Math.sin(yaw)*dz));
  const leanZ=Math.max(-1.2,Math.min(1.2,Math.sin(yaw)*dx+Math.cos(yaw)*dz));
  const section=(y,z,w,d)=>[[1,.65],[.76,1],[-.76,1],[-1,.65],[-1,-.64],[-.7,-1],[.7,-1],[1,-.64]]
    .map(([x,v])=>[x*w+Math.max(0,y)*leanX,y,z+v*d+Math.max(0,y)*leanZ]);
  const sole=section(-.135,.050,.096,.131),toe=section(-.108,.055,.099,.138);
  const vamp=section(-.043,.050,.096,.128),ankleRing=section(.023,-.003,.081,.088);
  if(item==='dragon-boots'){
    // A single pale instep spike, with a flared red cuff above a squared toe.
    const cuff=section(.120,-.007,.111,.105),rim=section(.152,-.007,.105,.101);
    loft(boot,sole,toe,'#62251e',false);loft(boot,toe,vamp,'#a82e20',false);
    loft(boot,vamp,ankleRing,'#b83826',false);loft(boot,ankleRing,cuff,'#a22c20',false);
    loft(boot,cuff,rim,'#95251d');
    const peak=[0,.042,.098],left=[-.04,-.042,.177],right=[.04,-.042,.177],tip=[0,-.024,.191];
    boot.face([left,tip,peak],'#e0dce2',false);boot.face([tip,right,peak],'#bab7c4',false);
    boot.face([left,right,tip],'#95919c',false);
  }else{
    const ranger=item==='ranger-boots',mage=item==='infinity-boots';
    const leather=ranger?'#627c23':mage?'#424166':'#674b35';
    loft(boot,sole,toe,ranger?'#41581e':mage?'#34324e':'#473729',false);
    loft(boot,toe,vamp,leather,false);loft(boot,vamp,ankleRing,leather,false);
    if(mage||ranger){
      const shaft=section(.094,-.010,.085,.088),cuff=section(.157,-.010,.120,.121);
      // Rangers wear turned-down green leather. Infinity boots have a yellow fold over a red gaiter.
      for(const p of cuff)p[1]+=.19*p[0]-.12*p[2];
      loft(boot,ankleRing,shaft,mage?'#b3433d':'#657f24',false);
      loft(boot,shaft,cuff,mage?'#f3d330':'#4b691a',false);
      const inside=cuff.map(([x,y,z])=>[x*.76,y-.018,z*.76]);
      boot.face([...inside].reverse(),mage?'#463e48':'#394821',false);
      for(let k=0;k<cuff.length;k++){
        const j=(k+1)%cuff.length;
        boot.face([cuff[k],inside[k],inside[j],cuff[j]],mage?'#e9c138':'#426022');
      }
    }else{
      loft(boot,ankleRing,section(.054,-.007,.081,.085),'#593f30');
    }
  }
  m.transformed(boot,ankle[0],ankle[2],yaw,1,ankle[1]);
}

function spiritShield(m,hand,divine=false){
  // The Elysian's swept points and open notches frame the forearm. Local u runs
  // rearward along the guard, while positive depth faces out from the left arm.
  const center=[hand[0]+.113,hand[1]+.038,hand[2]+.035];
  const project=([u,v],depth)=>[center[0]+.76*u+.65*depth,center[1]+v,center[2]-.65*u+.76*depth];
  const facets=[
    [[-.50,.39],[-.20,.295],[-.135,.204],[-.36,.245]],
    [[-.36,.245],[-.135,.204],[-.10,.03],[-.31,-.075]],
    [[-.36,.245],[-.31,-.075],[-.46,-.35],[-.395,-.32],[-.274,-.106]],
    [[-.31,-.075],[-.10,.03],[-.045,-.08],[-.205,-.105],[-.274,-.106]],
    [[-.205,-.105],[-.045,-.08],[-.085,-.31],[-.27,-.39],[-.19,-.243]],
    [[-.20,.295],[.10,.235],[.24,.114],[-.10,.03],[-.135,.204]],
    [[-.10,.03],[.24,.114],[.29,-.012],[.16,-.064],[-.045,-.08]],
    [[.24,.114],[.43,-.128],[.56,-.385],[.397,-.24],[.29,-.012]],
    [[.16,-.064],[.29,-.012],[.397,-.24],[.289,-.136]],
  ];
  const ridges=p=>.079-.094*Math.abs(p[0]+.035)-.055*Math.abs(p[1]-.018);
  const tones=divine?['#80ad669f','#7ca96298','#759e589e','#87b367a1','#77a36098','#96bc749f','#7da55c97','#82ac679f','#789f5e98']:['#58bdd098','#57a8be9c','#4d99b4a0','#65bacc99','#48a2bf96','#63c4d69a','#42a3bf9b','#53b6d29a','#4da7c19a'];
  function sheet(points,frontColor,backColor,relief=0){
    for(let j=1;j+1<points.length;j++){
      const a=points[0],b=points[j],c=points[j+1];
      const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const triangle=area<0?[a,c,b]:[a,b,c];
      m.face([...triangle].reverse().map(p=>project(p,ridges(p)-.015-relief)),backColor,false);
      m.face(triangle.map(p=>project(p,ridges(p)+relief)),frontColor,false);
    }
  }
  for(let i=0;i<facets.length;i++)sheet(facets[i],tones[i],divine?'#78965f78':'#66a6bc68');
  if(divine){
    const spires=[
      [[-.215,-.025],[-.13,-.040],[-.030,.006],[.050,.072],[.075,.045],[.034,-.027],[-.045,-.066],[-.155,-.071]],
      [[-.103,-.032],[-.158,.018],[-.175,.097],[-.142,.138],[-.137,.070],[-.103,.026],[-.042,.043],[-.010,.109],[.038,.131],[.020,.056],[-.013,.004]],
      [[.014,.019],[.070,.127],[.106,.230],[.232,.345],[.273,.368],[.230,.273],[.154,.175],[.110,.083],[.230,.232],[.196,.144],[.117,.054],[.209,.008],[.113,.027],[.073,.002]],
    ];
    for(const p of spires)sheet(p,'#e1d8be','#acae91',.012);
    return;
  }
  // Angular silver sigil: two swept antlers, an open centre, and three upper tines.
  const sigil=[
    [[-.270,.211],[-.172,.152],[-.07,.151],[-.109,.080],[-.213,.085]],
    [[-.216,.095],[-.108,.105],[-.074,.039],[-.002,-.005],[-.116,.017]],
    [[-.185,.061],[-.152,.098],[-.094,.075],[-.028,.013],[-.13,.046]],
    [[-.116,.107],[-.115,.161],[-.006,.237],[.040,.206],[-.060,.120],[-.069,.058]],
    [[-.024,.209],[-.042,.302],[-.004,.271],[.014,.362],[.031,.266],[.123,.372],[.076,.243]],
    [[.014,.232],[.141,.309],[.087,.216],[.088,.146],[.043,.130]],
    [[.088,.166],[.135,.075],[.184,.05],[.251,.092],[.163,-.003],[.054,-.022],[-.01,-.003],[.054,.051]],
  ];
  for(let i=0;i<sigil.length;i++)
    sheet(sigil[i],i%3?'#b8bcc2':'#d5d0ce','#90a5aa',.012);
}

function abyssalWhip(m,hand,phase,motion){
  // A short oxblood grip feeds an almost vertical, alternating dark lash.
  // The carried silhouette has a small forked hook just above the ground.
  const point=(x,y,z)=>[hand[0]-x,hand[1]+y,hand[2]+z];
  const butt=point(-.015,-.042,-.11),hilt=point(.031,.063,.135);
  limb(m,butt,hilt,.031,.037,'#833c37',5);
  const curve=[[.031,.063,.135],[.082,.08,.254],[.146,.025,.337],[.187,-.142,.375],
    [.209,-.321,.335],[.226,-.49,.273],[.225,-.665,.28],[.207,-.779,.335],[.181,-.781,.382]];
  const lift=Math.min(1,Math.max(.20,(hand[1]-.11)/.80));
  const at=(x,y,z,t)=>{
    const lag=motion*t*Math.sin(TAU*phase-t*2.75);
    return point(x+.070*lag,y*lift,z+.12*lag);
  };
  const joints=curve.map(([x,y,z],i)=>at(x,y,z,i/(curve.length-1)));
  for(let i=1;i<joints.length;i++){
    const radius=.039-i*.00185;
    limb(m,joints[i-1],joints[i],radius+.003,radius,i%2?'#34262a':'#873e39',5);
  }
  const end=joints[joints.length-1];
  const barb=[at(.164,-.71,.389,1),at(.152,-.733,.404,1),at(.150,-.694,.414,1),at(.175,-.789,.403,1),end];
  m.face(barb,'#6e302e',false);
  m.face([...barb].reverse().map(([x,y,z])=>[x-.011,y,z]),'#512729',false);
}

// Sword coordinates follow the grip along v. The ridge faces the camera from
// either side, so a narrow edge and the fuller remain visible when orbiting.
function swordFrame(origin,direction){
  const n=Math.hypot(...direction),axis=direction.map(v=>v/n);
  const projection=Math.hypot(axis[0],axis[1]);
  const width=[axis[1]/projection,-axis[0]/projection,0];
  const depth=[width[1]*axis[2],-width[0]*axis[2],width[0]*axis[1]-width[1]*axis[0]];
  return (u,v,d=0)=>origin.map((x,i)=>x+u*width[i]+v*axis[i]+d*depth[i]);
}
function forgedBlade(m,at,stations,light,dark){
  const faces=stations.map(([v,left,ridge,right,thickness])=>
    [at(left,v),at(ridge,v,thickness),at(right,v),at(ridge,v,-thickness)]);
  for(let i=1;i<faces.length;i++){
    const a=faces[i-1],b=faces[i];
    for(let k=0;k<4;k++){
      const j=(k+1)%4;
      m.face([a[k],a[j],b[j],b[k]],k%2?dark:light,false);
    }
  }
}
function metalRibbon(m,at,spine,front,back,depth=.025){
  // Each row describes the centreline and half-width, giving ornate guards
  // real holes instead of filling concave silhouettes with a triangle fan.
  const sections=spine.map(([x,y,width],i)=>{
    const prev=spine[Math.max(0,i-1)],next=spine[Math.min(i+1,spine.length-1)];
    const dx=next[0]-prev[0],dy=next[1]-prev[1],length=Math.hypot(dx,dy)||1;
    const a=x-dy/length*width,b=y+dx/length*width,c=2*x-a,d=2*y-b;
    return [at(a,b),at(x,y,depth),at(c,d),at(x,y,-depth)];
  });
  for(let i=1;i<sections.length;i++){
    const a=sections[i-1],b=sections[i];
    for(let k=0;k<4;k++){
      const j=(k+1)%4;
      m.face([a[k],a[j],b[j],b[k]],k%2?back:front,false);
    }
  }
}
function playerWeapon(m,rig,phase,motion,item){
  if(item==='abyssal-whip'){abyssalWhip(m,rig.right,phase,motion);return;}
  if(item==='dragon-scimitar'){
    const at=swordFrame(rig.right,[-.38,.83,.40]);
    limb(m,at(-.02,-.15,-.02),at(0,.10),.028,.034,'#57505a',6);
    metalRibbon(m,at,[[-.132,.062,.007],[-.123,.110,.018],[-.060,.130,.024],[.010,.107,.032],[.075,.085,.026],[.124,.098,.018],[.130,.13,.005]],'#777077','#48424b');
    metalRibbon(m,at,[[-.035,-.175,.027],[.031,-.166,.027],[.036,-.14,.008]],'#716970','#4e4951');
    // Three breaks in the cutting edge give the dragon scimitar its distinctive hooked tip.
    forgedBlade(m,at,[[.13,-.024,.009,.038,.016],[.32,-.015,.014,.065,.019],
      [.525,-.011,.032,.099,.024],[.536,-.007,.034,.135,.024],
      [.702,.024,.071,.158,.023],[.715,.028,.075,.208,.022],
      [.833,.077,.110,.208,.017],[1.00,.192,.193,.195,.001]],'#ba321e','#8c2018');
    return;
  }
  if(item!=='armadyl-godsword')return;
  // During the two-handed stance the support hand sits lower on the hilt.
  // Sling the sword diagonally during Dance to free both hands for the emote.
  const sling=swordFrame([.17,.98,-.445],[-.47,.86,-.10]);
  const at=rig.dancing?(x,y,z=0)=>rig.torso(sling(x,y,z)):
    swordFrame(rig.right,rig.right.map((v,i)=>v-rig.left[i]));
  limb(m,at(0,-.26),at(0,.105),.036,.046,'#655687',7);
  for(const y of [-.255,.083])limb(m,at(0,y),at(0,y+.029),.053,.054,'#9394ac',7);
  const steel='#c4c7d2',shadow='#8b8d9f';
  // The silver blade has staggered backward-facing teeth and one long spur at its upper third.
  forgedBlade(m,at,[[.13,-.041,0,.040,.020],[.27,-.064,0,.056,.027],[.31,-.122,0,.066,.031],
    [.337,-.076,.005,.072,.032],[.375,-.082,.006,.126,.031],[.403,-.087,.006,.073,.032],
    [.49,-.140,.007,.083,.037],[.522,-.085,.007,.087,.037],[.927,-.068,0,.066,.030],
    [1.053,-.036,0,.045,.022],[1.211,-.002,0,.001,.001]],steel,shadow);
  for(const s of [-1,1]){
    const branch=(pts,hi,lo,thick)=>metalRibbon(m,at,pts.map(([u,v,w])=>[u*s,v,w]),hi,lo,thick);
    // Wide curled talons at the crossguard and small feathers pointing back toward the grip.
    branch([[.013,.146,.051],[.111,.115,.043],[.198,.083,.031],[.254,.112,.025],[.248,.178,.020],[.201,.202,.012],[.172,.176,.002]],'#9395a6','#6b6d80',.030);
    branch([[.121,.102,.020],[.166,.058,.018],[.173,.030,.002]],'#8e909e','#717381',.014);
    branch([[.186,.089,.018],[.223,.045,.015],[.233,.018,.002]],'#9293a2','#717381',.014);
    branch([[.063,.674,.015],[.128,.686,.017],[.185,.665,.017],[.211,.608,.010],[.209,.559,.001]],steel,shadow,.015);
    branch([[.016,-.269,.045],[.073,-.295,.029],[.121,-.273,.005]],'#8e89a4','#74718e',.021);
    branch([[.016,-.275,.036],[.094,-.333,.025],[.112,-.377,.002]],'#86829c','#646579',.023);
  }
  forgedBlade(m,at,[[-.475,-.002,0,.002,.001],[-.414,-.065,0,.065,.026],[-.32,-.024,0,.024,.025],[-.26,-.052,0,.052,.022]],'#87839e','#63627d');
}

function dragonfireShield(m,hand){
  const center=[hand[0]+.118,hand[1]+.035,hand[2]+.055];
  // The shield is buckled along the forearm, its jaws pointing back toward the elbow.
  const at=(u,v,depth)=>{
    const across=1.28*(.43*u-.90*v),height=1.28*(.90*u+.43*v);
    return [center[0]+.56*across+.83*depth,center[1]+height,center[2]-.83*across+.56*depth];
  };
  const rim=[[-.232,.34],[-.026,.368],[.235,.327],[.241,.109],[.200,-.191],[.135,-.318],[-.161,-.337],[-.245,-.170]];
  const outer=rim.map(([x,y])=>at(x,y,.015)),inner=rim.map(([x,y])=>at(.83*x,.88*y,.065));
  const back=rim.map(([x,y])=>at(.95*x,.95*y,-.035));
  for(let i=0;i<rim.length;i++){
    const j=(i+1)%rim.length;
    m.face([outer[j],outer[i],inner[i],inner[j]],i%3?'#777175':'#999297',false);
    m.face([inner[j],inner[i],at(0,0,.083)],i%2?'#814525':'#9a5328',false);
    m.face([back[i],outer[i],outer[j],back[j]],'#4a474c',false);
    m.face([back[i],back[j],at(0,0,-.047)],'#514b49',false);
  }
  // The bolted draconic visage projects from the panel, with a long jaw,
  // paired horns, red eyes and pale fangs enclosing the dark mouth.
  const crest=(u,v,d,w,h,t,col)=>{
    const a=at(u-w,v,d),b=at(u+w,v,d),c=at(u,v+h,d),e=at(u,v-h,d),p=at(u,v,d+t);
    m.face([a,e,p],col,false);m.face([e,b,p],mix(col,'#29282d',.25),false);
    m.face([b,c,p],mix(col,'#1c1b20',.44),false);m.face([c,a,p],mix(col,'#aaa5a8',.18),false);
  };
  const horn=(a,b,r,t,col)=>limb(m,at(...a),at(...b),r,t,col,5);
  crest(0,.105,.094,.169,.176,.094,'#504c52');
  crest(0,-.095,.121,.103,.164,.044,'#554348');
  crest(0,-.082,.166,.065,.091,.009,'#332d31');
  for(const s of [-1,1]){
    horn([s*.085,.168,.102],[s*.160,.270,.127],.041,.002,'#3f3c43');
    horn([s*.089,.145,.143],[s*.155,.110,.128],.030,.003,'#67646b');
    horn([s*.119,.104,.151],[s*.115,-.009,.168],.039,.002,'#b6a9ab');
    horn([s*.105,.093,.166],[s*.086,-.033,.193],.029,.002,'#c4b5b6');
    horn([s*.099,-.037,.138],[s*.090,-.136,.156],.026,.002,'#6c6063');
    m.face([at(s*.032,.148,.191),at(s*.098,.161,.172),at(s*.087,.132,.183)],'#d7462a',false);
    m.face([at(s*.087,.132,.183),at(s*.098,.161,.172),at(s*.032,.148,.191)],'#d7462a',false);
    horn([s*.062,.047,.175],[s*.050,-.015,.198],.026,.001,'#b9afb0');
    horn([s*.058,-.198,.153],[s*.077,-.148,.188],.028,.003,'#c5bdbd');
  }
  crest(0,.018,.158,.093,.079,.061,'#686166');
  crest(0,-.209,.115,.074,.042,.047,'#a2999b');
}
function playerShield(m,rig,item){
  if(item==='elysian-spirit-shield'||item==='divine-spirit-shield'){
    spiritShield(m,rig.left,item==='divine-spirit-shield');return;
  }
  if(item==='dragonfire-shield'){dragonfireShield(m,rig.left);return;}
  if(item!=='rune-defender')return;
  // A short rune parrying blade lies along the left forearm, with flared square quillons.
  const at=swordFrame(rig.left,[.28,.17,.94]);
  limb(m,at(0,-.084),at(0,.09),.031,.029,'#446377',5);
  for(const s of [-1,1]){
    metalRibbon(m,at,[[0,.068,.026],[s*.073,.073,.015],[s*.137,.073,.035]],'#638094','#354e60',.016);
  }
  forgedBlade(m,at,[[.064,-.040,0,.04,.015],[.119,-.068,0,.056,.022],
    [.157,-.051,.003,.046,.023],[.474,-.002,0,.001,.001]],'#7292a3','#405e73');
  forgedBlade(m,at,[[-.102,-.032,0,.033,.013],[-.071,-.051,0,.050,.019],[0,-.022,0,.023,.014]],'#55778b','#3b576c');
}

function playerFigure(Mesh,seed,person,phase){
  const moving=!!person.moving,dancing=!moving&&person.activity==='dance';
  const swing=moving?Math.sin(TAU*phase)*.25:0;
  const bob=Math.abs(swing)*.14;
  const rig=dancing?playerDancePose(phase):{
    torso:([x,y,z])=>[x,y+bob,z],
    right:equippedWrist(-1,bob,swing),left:equippedWrist(1,bob,swing),
    legs:[-1,1].map(side=>({hip:[side*.135,.87+bob,0],knee:[side*.135,.47+bob*.43,swing*side*.56],
      ankle:[side*.135,.14,swing*side],yaw:0})),
  };
  const gear=normalizeLoadout(person.loadout),part=person.equipmentPart;
  const includes=slot=>part===undefined||part===slot;
  rig.dancing=dancing;
  if(!dancing&&gear.weapon==='armadyl-godsword'){
    rig.right=rig.torso([-.055,1.09,.24]);
    rig.left=rig.torso([-.097,.925,.219]);
  }
  const m=new Mesh(),body=new Mesh();
  const skin=['#cea67e','#ba8a62','#e0bc91','#a77954'][seed%4],hair=['#5a402a','#9a7847','#b7a167','#493b31'][seed%4];
  if(includes('legs'))playerLegwear(m,rig,skin,gear.legs);
  if(includes('boots'))for(const leg of rig.legs)playerFootwear(m,Mesh,leg,gear.boots);
  if(includes('torso'))playerTorso(body,gear.torso,skin);
  if(includes('cape'))playerCape(body,gear.cape,phase,dancing?1:moving?.5:0,person.classicDetail);
  if(includes('head')){
    if(!person.itemOnly)playerHead(body,skin,hair);
    playerHeadgear(body,gear.head);
  }
  for(const f of body.faces){
    m.face(f.points.map(p=>rig.torso(p)),f.color,false);
    if(f.vertexColors)m.faces[m.faces.length-1].vertexColors=f.vertexColors;
  }
  if(includes('torso'))for(const [side,hand] of [[-1,rig.right],[1,rig.left]]){
    const shoulder=rig.torso(playerShoulder(side));
    const elbow=rig.elbows?rig.elbows[side<0?0:1]:equippedElbow(shoulder,hand,side);
    playerArm(m,shoulder,elbow,hand,side,skin,gear.torso);
  }
  if(includes('weapon'))playerWeapon(m,rig,phase,dancing?1:moving?.7:0,gear.weapon);
  if(includes('shield'))playerShield(m,rig,gear.shield);
  return m;
}

function equippedElbow(shoulder,hand,side){
  return elbowFor(shoulder,hand,side,.276,[side*.42,-.42,-.82],.002);
}

function elbowFor(shoulder,hand,side,segment=.355,hinge=[side*.8,-.42,-.52],minBend=.008){
  const span=hand.map((v,i)=>v-shoulder[i]),distance=Math.hypot(...span)||1,axis=span.map(v=>v/distance);
  const alongArm=hinge.reduce((n,v,i)=>n+v*axis[i],0);
  const outward=hinge.map((v,i)=>v-alongArm*axis[i]),length=Math.hypot(...outward)||1;
  const bend=Math.sqrt(Math.max(minBend,segment*segment-distance*distance/4));
  return along(interp(shoulder,hand,.5),outward,bend/length);
}

export function buildCharacter(Mesh,hash,person,time){
  const figure=new Mesh(),seed=hash(person.key||'player'),moving=person.moving,work=person.activity;
  const phase=Number.isFinite(person.posePhase)?person.posePhase:time/(WORK_CYCLES[moving?'walk':work]||1)+(seed%997)/997;
  if(person.player)return playerFigure(Mesh,seed,person,phase);
  const pose=moving?null:workPoseAt(work,phase),stowed=!!pose||moving;
  const gait=moving?Math.sin(phase*TAU)*.27:0,bob=pose?-pose.crouch:moving?Math.abs(Math.sin(phase*TAU))*.035:0;
  let m=figure;
  const skin=['#cea67e','#ba8a62','#e0bc91','#a77954'][seed%4],hair=['#5a402a','#9a7847','#b7a167','#493b31'][seed%4];
  const cape=ART_PALETTE[person.host]||'#79815c';
  const job=classFor(person.kind);
  const cloth=LIVERIES[job][seed%3],leather='#655034',pants=['#6d674a','#6c5b43','#626b5a'][seed%3];
  // A seven-head silhouette: shaped shoulders, narrow waist, long articulated legs.
  for(const side of [-1,1]){
    const stance=pose?(side<0?.12:-.10):0,x=side*(pose?.17:.135),swing=gait*side+stance;
    const hip=[side*.135,.87+bob,0],knee=[x,.47+bob*.43,swing*.56+(pose?pose.crouch*.80:0)],ankle=[x,.14,swing];
    limb(m,hip,knee,.125,.10,pants);limb(m,knee,ankle,.095,.075,pants);
    loft(m,rectRing(x,.015,swing+.07,.19,.30),rectRing(x,.20,swing+.035,.16,.22),leather);
  }
  if(pose)m=new Mesh();
  loft(m,rectRing(0,.82+bob,0,.43,.29),rectRing(0,1.35+bob,0,.57,.33),cloth);
  loft(m,rectRing(0,.78+bob,0,.46,.31),rectRing(0,1.04+bob,0,.40,.28),mix(cloth,'#574831',.08));
  // Belt, collar and a brass clasp are flat details rather than extra solids.
  frontQuad(m,0,.99+bob,.166,.43,.075,leather);frontQuad(m,.02,1.003+bob,.170,.095,.055,'#c5a45e');
  m.face([[-.12,1.36+bob,.17],[0,1.18+bob,.18],[.12,1.36+bob,.17]],'#dbc598',false);
  limb(m,[0,1.35+bob,0],[0,1.50+bob,0],.095,.087,skin,4);
  const lower=ring(0,1.48+bob,.018,.135,.115,6,Math.PI/6),upper=ring(0,1.77+bob,0,.172,.15,6,Math.PI/6);
  loft(m,lower,upper,skin);loft(m,ring(0,1.74+bob,-.008,.176,.156,6,Math.PI/6),ring(0,1.88+bob,-.018,.10,.10,6,Math.PI/6),hair);
  frontQuad(m,-.065,1.665+bob,.151,.032,.026,'#3c3b30');frontQuad(m,.065,1.665+bob,.151,.032,.026,'#3c3b30');
  m.face([[-.035,1.64+bob,.148],[.035,1.64+bob,.148],[0,1.59+bob,.205]],mix(skin,'#d0a16a',.10));
  // The cape is a folded, tapered cloth silhouette; its lining appears from the front.
  const capeTop=[[-.24,1.34+bob,-.19],[0,1.37+bob,-.22],[.24,1.34+bob,-.19]],capeBottom=[[-.28,.54+bob,-.28],[0,.48+bob,-.37],[.28,.54+bob,-.28]];
  for(let i=0;i<2;i++){
    const p=[capeTop[i],capeBottom[i],capeBottom[i+1],capeTop[i+1]];m.face(p,i?cape:mix(cape,'#263629',.16));m.face([...p].reverse(),mix(cape,'#e3cf93',.10));
  }
  // Work poses store the tool's two grips in local X order. The avatar faces +Z.
  const hands=pose?[pose.left,pose.right]:[[-.35,.94+bob,gait*.65],[.35,.94+bob,-gait*.65]];
  const [rightHand,leftHand]=hands;
  if(job==='Mage')mageGear(m,bob,cloth,rightHand,stowed);
  if(job==='Ranger')rangerGear(m,bob,rightHand,stowed);
  if(job==='Warrior')warriorGear(m,bob,rightHand,leftHand,stowed);
  if(job==='Guildmaster')guildmasterGear(m,bob);
  if(pose){
    // Rotate the torso, head and stowed equipment together around the hips.
    for(const face of m.faces)figure.face(face.points.map(vertex=>leanPoint(vertex,bob,pose)),face.color,false);
  }
  for(const [side,hand] of [[-1,rightHand],[1,leftHand]]){
    const shoulder=leanPoint([side*.27,1.32+bob,0],bob,pose),elbow=elbowFor(shoulder,hand,side);
    limb(figure,shoulder,elbow,.115,.09,cloth,4);limb(figure,elbow,hand,.075,.058,skin,4);
    const end=pose?along(hand,pose.dir,-.085):[hand[0],hand[1]-.10,hand[2]+.025];
    limb(figure,hand,end,.070,.058,skin,4);
  }
  if(pose)craftTools(figure,pose);
  return figure;
}
