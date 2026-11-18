// One header owns the embedded game's key state. Publish transitions immediately
// and renew held keys while focused so a retired view cannot leave a key down.
const heldKeys=new Set(['w','a','s','d','q','e','r','f','up','down','left','right']);
const actions={g:'dance',i:'inventory',m:'music',n:'names',h:'home',enter:'nearest',return:'nearest',escape:'cancel'};

export class GameKeys {
  constructor(read,write){
    this.read=read;this.write=write;
    this.keys=new Set();this.presses={};this.actions=[];this.entry=0;this.seq=0;this.at=0;
    this.writing=false;this.cached=undefined;this.pending=null;
  }
  begin(entry){
    if(this.entry===entry)return;
    this.entry=entry;this.keys.clear();this.presses={};this.actions=[];
    this.publish();
  }
  update(event,down){
    const key=event.key.toLowerCase();
    if(!down){
      if(this.keys.delete(key)){this.publish();return true;}
      return false;
    }
    if(event.modifiers.platform||event.modifiers.control||event.modifiers.alt)return false;
    if(heldKeys.has(key)){
      if(!this.keys.has(key)){
        this.keys.add(key);this.presses[key]=(this.presses[key]||0)+1;this.publish();
      }
      return true;
    }
    let kind=actions[key],delta;
    if(key==='-'||key==='='||key==='+'){kind='zoom';delta=key==='-'?-.12:.12;}
    if(!kind)return false;
    if(!event.is_held){
      const seq=Math.max(Date.now()*1000,this.seq+1);
      this.actions=[...this.actions.slice(-11),{seq,at:Date.now(),kind,delta}];this.publish();
    }
    return true;
  }
  clear(){
    if(this.keys.size){this.keys.clear();this.publish();}
  }
  heartbeat(){
    if(this.keys.size&&Date.now()-this.at>=100)this.publish();
  }
  publish(){
    this.at=Date.now();this.seq=Math.max(this.at*1000,this.seq+1);
    this.pending={entry:this.entry,seq:this.seq,at:this.at,keys:[...this.keys],presses:{...this.presses},actions:this.actions};
  }
  async flush(){
    if(this.writing||!this.pending)return;
    this.writing=true;
    try{
      while(this.pending){
        if(this.cached===undefined)this.cached=await this.read().catch(()=>null);
        const next=this.pending;this.pending=null;
        let previous;
        try{previous=this.cached&&JSON.parse(this.cached);}catch(_){}
        if(previous && (previous.entry>next.entry || previous.entry===next.entry&&previous.seq>=next.seq))continue;
        const text=JSON.stringify(next);
        try{await this.write(text,this.cached);this.cached=text;}
        catch(_){this.cached=undefined;if(!this.pending)this.pending=next;break;}
      }
    }finally{this.writing=false;}
  }
}
