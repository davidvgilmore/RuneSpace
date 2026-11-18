import {View, div, image} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {run, shared, setShared, theme} from 'herdr';
import {EQUIPMENT_ITEMS, EQUIPMENT_SLOTS, equipItem, normalizeLoadout, previewLayers} from './equipment.js';

const column=()=>div().flex().flex_col().items_stretch().justify_start();
const text=(value,size,color)=>div().text_size(size).text_color(color).child(value);
const itemsById=new Map(EQUIPMENT_ITEMS.map(item=>[item.id,item]));
const thumbnail=(item,size)=>image('mods/runespace/preview/'+item.id+'.png').w(size).h(size).flex_shrink_0();
const back=()=>run('runespace.inventory-back');

function action(id,title,callback,active=false){
  const t=theme();
  return h_flex().id(id).role('button').accessibility_label(title)
    .h(30).px(10).items_center().justify_center().bg(active?t.selected:t.raised)
    .border(1).border_color(active?t.accent:t.border).cursor_pointer().hover(s=>s.bg(t.hover)).on_click(callback)
    .child(text(title,12,active?t.accent:t.foreground));
}

export default class GuildInventory extends View {
  init(_p,cx){
    this.slot='all';
    this.examined=Object.values(normalizeLoadout(shared('runespace.loadout'))).find(id=>id!=='none') || EQUIPMENT_ITEMS[0].id;
    this.direction='front';
    this.width=1000;
    this.height=700;
    this.focus=cx.focus_handle();
    this.receipt='';
  }
  chooseSlot(id,cx){
    this.slot=id;
    if(id!=='all')this.examined=normalizeLoadout(shared('runespace.loadout'))[id];
    this.receipt='';
    this.focus.focus();
    cx.notify();
  }
  wear(id,cx){
    // Read at activation so a second copy editing another slot cannot be overwritten.
    const before=normalizeLoadout(shared('runespace.loadout'));
    const slot=id==='none'?this.slot:itemsById.get(id)?.slot;
    const after=equipItem(before,slot,id);
    this.examined=id;
    this.receipt='';
    if(before[slot]!==after[slot]){
      const displaced=EQUIPMENT_SLOTS.find(s=>s.id!==slot && before[s.id]!=='none' && after[s.id]==='none');
      const old=displaced && itemsById.get(before[displaced.id]);
      if(old)this.receipt=old.name+' was stowed.';
      setShared('runespace.loadout',after);
    }
    this.focus.focus();
    cx.notify();
  }
  slotButton(slot,item,small){
    const t=theme(),active=slot.id===this.slot, name=item?.name||'Empty';
    const size=small?25:38;
    const tile=h_flex().w(size).h(size).flex_shrink_0().items_center().justify_center();
    if(item)tile.child(thumbnail(item,size));
    else tile.child(text('◇',size*.5,t.dim));
    return h_flex().id('inventory-slot-'+slot.id).role('button').accessibility_label(slot.label+', '+name)
      .w_full().h(small?36:58).flex_shrink_0().items_center().gap(small?4:10).px(small?3:8)
      .bg(active?t.selected:t.surface).border(1).border_color(active?t.accent:t.border)
      .cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>this.chooseSlot(slot.id,cx))
      .child(tile).child(column().flex_1().min_w(0)
        .child(text(slot.label,small?10:11,active?t.accent:t.muted).truncate())
        .child(text(name,small?11:14,t.foreground).truncate()));
  }
  paperDoll(loadout,width){
    const t=theme(),height=Math.round(width*290/216);
    const model=div().relative().w(width).h(height).flex_shrink_0()
      .accessibility_label('Your character wearing the selected equipment, '+this.direction+' view');
    // Each transparent layer uses the same full-character camera and frame.
    // Placing them on the same pixel rectangle preserves the 3D anchors.
    for(const asset of previewLayers(loadout,this.direction)){
      model.child(image(asset).absolute().left(0).top(0).w(width).h(height));
    }
    const directionButton=(view,title)=>action('inventory-view-'+view,title,(_e,cx)=>{
      this.direction=view;this.focus.focus();cx.notify();
    },this.direction===view);
    return column().min_w(0).flex_1().items_center().justify_center().gap(9).py(7)
      .bg('#2b2b23').border(1).border_color(t.border)
      .child(model)
      .child(h_flex().items_center().justify_center().gap(3)
        .child(directionButton('front','Front')).child(directionButton('back','Rear')));
  }
  itemButton(item,active,width,small){
    const t=theme(),size=small?48:68;
    return column().id('inventory-item-'+item.id).role('button')
      .accessibility_label((active?'Equipped, ':'Equip ')+item.name)
      .w(width).min_w(0).h(small?99:128).flex_shrink_0().px(5).py(5).items_center().justify_center()
      .bg(active?t.selected:t.background).border(active?2:1).border_color(active?t.accent:t.border)
      .cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>this.wear(item.id,cx))
      .child(thumbnail(item,size))
      .child(text(item.name,small?12:14,active?t.accent:t.foreground).text_center().line_height(1.15))
      .when(active,e=>e.child(text('Equipped',10,t.working)));
  }
  collection(loadout,width,small,scroll){
    const t=theme(),slot=EQUIPMENT_SLOTS.find(s=>s.id===this.slot);
    const items=slot?EQUIPMENT_ITEMS.filter(item=>item.slot===slot.id):EQUIPMENT_ITEMS;
    const equipped=slot && itemsById.get(loadout[slot.id]);
    const examined=itemsById.get(this.examined);
    const gap=6,gridWidth=Math.max(80,width-24);
    const columns=Math.max(1,Math.min(7,Math.floor((gridWidth+gap)/(small?103:132))));
    const tileWidth=Math.floor((gridWidth-(columns-1)*gap)/columns);
    const bank=column().w_full().min_w(0).min_h(0).bg(t.popover).border(1).border_color(t.border);
    const top=h_flex().px(11).h(45).flex_shrink_0().gap(7).items_center().bg(t.surface);
    top.child(text(slot?slot.label:'Item collection',small?17:20,t.accent).font_family('Georgia').flex_1());
    if(slot){
      top.child(action('inventory-all','All items',(_e,cx)=>this.chooseSlot('all',cx)));
      if(equipped)top.child(action('inventory-remove','Unequip',(_e,cx)=>this.wear('none',cx)));
    }else top.child(text(items.length+' items',12,t.muted));
    bank.child(top);
    const cards=column().id('inventory-grid-'+this.slot).min_h(0).p(9)
      .child(h_flex().w_full().flex_wrap().gap(gap).items_start()
        .children(items.map(item=>this.itemButton(item,loadout[item.slot]===item.id,tileWidth,small))));
    if(scroll){
      // Only long collections scroll. Short slot lists keep their examine text beside the cards.
      const rows=Math.ceil(items.length/columns),natural=rows*(small?99:128)+(rows-1)*gap+18;
      cards.h(Math.min(natural,Math.max(140,this.height-222))).overflow_y_scrollbar();
    }
    bank.child(cards);
    const examine=column().px(12).py(10).gap(4).bg(t.surface).border_t(1).border_color(t.border);
    if(examined){
      examine.child(text(examined.name+'  ·  '+examined.year,16,t.accent).font_family('Georgia'));
      examine.child(text(examined.detail,13,t.foreground).font_family('Geist'));
    }else{
      examine.child(text('Nothing equipped',14,t.muted));
      if(this.slot==='shield' && itemsById.get(loadout.weapon)?.twoHanded)
        examine.child(text('Equipping a shield stows your two-handed weapon.',12,t.foreground));
    }
    if(this.receipt)examine.child(text(this.receipt,12,t.muted));
    return bank.child(examine);
  }
  render(){
    const t=theme(),loadout=normalizeLoadout(shared('runespace.loadout'));
    const pad=this.width<620?9:20,gap=this.width<620?8:14;
    const width=Math.max(185,Math.min(1570,this.width-2*pad-12));
    const stacked=width<830,small=width<560;
    const wearWidth=stacked?width:Math.min(580,Math.floor(width*.44));
    const sideWidth=Math.min(216,Math.floor(wearWidth*.435));
    const artWidth=Math.max(82,Math.min(296,wearWidth-sideWidth-39));
    const panel=column().id('runespace-inventory').size_full().min_h(0).items_center().bg(t.canvas).p(pad)
      .track_focus(this.focus).key_context('GuildInventory')
      .on_size_change((size,cx)=>{
        this.width=size.width;this.height=size.height;
        this.focus.focus();cx.notify();
      })
      .on_key_down((e,cx)=>{
        if(e.modifiers.platform||e.modifiers.control||e.modifiers.alt)return;
        if(['escape','i'].includes(e.key.toLowerCase())){
          cx.stop_propagation();
          if(!e.is_held)back();
        }
      });
    const shell=column().w(width).min_w(0).flex_1().min_h(0).gap(gap);
    const closeLabel=['world','play','metal'].includes(shared('runespace.inventoryOrigin'))?'Return to world':'Back';
    shell.child(h_flex().h(small?39:49).flex_shrink_0().items_center().gap(12)
      .child(text('Inventory',small?25:32,t.accent).font_family('Georgia').flex_1())
      .child(action('inventory-close','← '+closeLabel,back)));
    const slots=column().w(sideWidth).flex_shrink_0().gap(small?2:4)
      .children(EQUIPMENT_SLOTS.map(s=>this.slotButton(s,itemsById.get(loadout[s.id]),small)));
    const wearing=column().w(wearWidth).flex_shrink_0().bg(t.popover).border(1).border_color(t.border)
      .child(h_flex().h(45).px(11).items_center().bg(t.surface)
        .child(text('Worn equipment',small?17:20,t.accent).font_family('Georgia')))
      .child(h_flex().p(small?5:8).gap(small?5:8).items_stretch()
        .child(this.paperDoll(loadout,artWidth)).child(slots));
    const bankWidth=stacked?width:width-wearWidth-gap;
    const bank=this.collection(loadout,bankWidth,small,!stacked);
    const panes=stacked?column().gap(gap).child(wearing).child(bank):
      h_flex().w_full().gap(gap).items_start().child(wearing).child(column().w(bankWidth).min_w(0).child(bank));
    shell.child(column().id('inventory-scroll').flex_1().min_h(0).overflow_y_scrollbar().child(panes));
    return panel.child(shell);
  }
}
