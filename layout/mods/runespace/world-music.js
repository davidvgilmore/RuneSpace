import {View,div} from 'gpui-kit';
import {h_flex,Slider,SliderState,SliderTrack,SliderIndicator,SliderThumb} from 'gpui-base';
import {appHome,exec,shared,setShared} from 'herdr';

const tracks=[
  {id:'lanterns',title:'Lanterns at the Commons',mood:'Flute, harp & warm strings'},
  {id:'banners',title:'Banners at Dawn',mood:'Horns, strings & bright harp'},
  {id:'willow',title:'The Willow Road',mood:'Lute, flute & dancing harp'},
];
const V=()=>div().flex().flex_col().items_stretch().justify_start();
const text=(value,size=12,color='#e1d6b2')=>div().text_size(size).text_color(color).child(value);
const button=(id,label,fn,on=false)=>h_flex().id(id).h(27).px(8).items_center().justify_center().cursor_pointer()
  .bg(on?'#4d5937':'#403e30').border(1).border_color('#83744f').hover(e=>e.bg('#5a5c3e'))
  .on_click(fn).child(text(label,11,on?'#ffe28b':'#e3d5ac'));

// The header owns playback so switching from the world block to a terminal keeps the same player alive.
export class GuildSoundtrack {
  pulse(cx) {
    if (this.busy) return;
    const mode = shared('runespace.mode');
    const active = ['conversation','world','metal','play','sound','inventory'].includes(mode);
    const saved = shared('runespace.music') || {};
    const settings = [active, saved.playing ?? true, saved.volume ?? .30, saved.track || 'lanterns'];
    const signature = JSON.stringify(settings);
    if (signature === this.signature && (!active || Date.now() - this.lastPulse < 4500)) return;
    this.signature = signature;
    this.lastPulse = Date.now();
    this.busy = true;
    cx.spawn(async () => {
      let error = '';
      try {
        const [,playing,volume,track] = settings;
        const result = await exec('/usr/bin/python3', [appHome()+'/mods/runespace/music/control.py','update',
          '--active',String(active),'--playing',String(playing),'--volume',String(volume),'--track',track], {timeout:65000});
        const state = JSON.parse(result.stdout);
        if (result.code !== 0 || !state.ok) throw Error(state.error || 'Music could not start');
      } catch (e) {
        error = String(e);
      } finally {
        this.busy = false;
        if ((shared('runespace.musicError') || '') !== error) setShared('runespace.musicError',error);
      }
    });
  }
}

export default class GuildMusic extends View {
  init(_props,cx){
    const saved=shared('runespace.music')||{};
    this.playing=saved.playing??true;this.volume=saved.volume??.30;this.track=saved.track||'lanterns';
    this.restoreVolume=.30;
    this.slider=SliderState.new({min:0,max:100,step:5,value:Math.round(this.volume*100)});
    this.slider.on('change',(v,cx)=>{this.volume=Number(v)/100;cx.notify();});
    this.slider.on('release',(_v,cx)=>this.change(cx));
  }
  change(cx){setShared('runespace.music',{playing:this.playing,volume:this.volume,track:this.track});cx.notify();}
  render(){
    const error=shared('runespace.musicError');
    const track=tracks.find(t=>t.id===this.track)||tracks[0];
    return V().absolute().top(292).right(18).w(178).p(9).gap(8).bg('#292c22f2').border(2).border_color('#8a7b55')
      .child(text('♫  SONGS OF THE GUILD',12,'#f1d278'))
      .child(text(track.title,15,'#f1dca4').font_family('Georgia'))
      .child(text(track.mood,10,'#bfb99b').font_family('Geist'))
      .child(h_flex().gap(5).children(tracks.map((t,i)=>button('score-'+t.id,['I','II','III'][i],(_e,cx)=>{this.track=t.id;this.change(cx);},this.track===t.id))))
      .child(h_flex().gap(5)
        .child(button('music-play',this.playing?'Ⅱ Pause':'▶ Play',(_e,cx)=>{this.playing=!this.playing;this.change(cx);},this.playing))
        .child(button('music-mute',this.volume===0?'Unmute':'Mute',(_e,cx)=>{if(this.volume){this.restoreVolume=this.volume;this.volume=0;}else this.volume=this.restoreVolume;this.slider.set_value(this.volume*100);this.change(cx);},this.volume===0)))
      .child(h_flex().justify_between().child(text('Volume',10,'#c3b994')).child(text(Math.round(this.volume*100)+'%',10,'#e5d3a2')))
      .child(Slider.new(this.slider).child(SliderTrack.new(this.slider).flex().items_center().h(18).w_full()
        .child(SliderIndicator.new(this.slider).relative().w_full().h(5).bg('#776e49').range_style(s=>s.bg('#d1b768'))
          .child(SliderThumb.new(this.slider).w(9).h(15).ml(-4).bg('#eed28a').border(1).border_color('#4e452b')))))
      .when(!!error,e=>e.child(text(error,10,'#e7ae7a')));
  }
}
