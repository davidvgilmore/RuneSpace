// Personal-mod audio player. No network listener, system-volume changes, or Herdr patches.
import Foundation
import AVFoundation
import Darwin

struct Control:Decodable {
    var playing:Bool=false;var active:Bool=false;var volume:Double=0.30
    var track:String="lanterns";var heartbeat:Double=0;var quit:Bool=false
}
struct Track:Decodable {let id:String;let title:String;let audio:String}
struct Manifest:Decodable {let tracks:[Track]}
let args=CommandLine.arguments
if args.count != 3 {exit(2)}
let state=URL(fileURLWithPath:args[1],isDirectory:true),assets=URL(fileURLWithPath:args[2],isDirectory:true)
let lock=open(state.appendingPathComponent("player.lock").path,O_CREAT|O_RDWR,0o600)
guard lock>=0,flock(lock,LOCK_EX|LOCK_NB)==0 else {exit(0)}
defer {flock(lock,LOCK_UN);close(lock)}
let manifest=try JSONDecoder().decode(Manifest.self,from:Data(contentsOf:assets.appendingPathComponent("manifest.json")))
let statusURL=state.appendingPathComponent("status.json"),controlURL=state.appendingPathComponent("control.json")
var resume:[String:Double]=[:]
if let data=try? Data(contentsOf:statusURL),let old=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let track=old["track"] as? String,let position=old["position"] as? Double {resume[track]=position}
var player:AVAudioPlayer?,track="",title="",error:String?=nil,lastStatus:Double=0,idleSince:Double?=nil
var requested=Control(),reason="paused"
func writeStatus(){
    let data:[String:Any]=["pid":getpid(),"track":track,"title":title,"playing":player?.isPlaying ?? false,"requestedPlaying":requested.playing,"active":requested.active,"volume":requested.volume,"position":player?.currentTime ?? 0,"duration":player?.duration ?? 0,"updated":Date().timeIntervalSince1970,"reason":reason,"error":error as Any? ?? NSNull()]
    if let blob=try? JSONSerialization.data(withJSONObject:data,options:[.sortedKeys]) {try? blob.write(to:statusURL,options:.atomic)}
}
while true {
    let now=Date().timeIntervalSince1970
    guard let data=try? Data(contentsOf:controlURL),let control=try? JSONDecoder().decode(Control.self,from:data) else {reason="missing-control";writeStatus();break}
    requested=control
    if control.quit || now-control.heartbeat>14 {player?.pause();reason=control.quit ? "stopped":"heartbeat-expired";writeStatus();break}
    let shouldPlay=control.playing && control.active
    if shouldPlay && track != control.track {
        if let p=player {resume[track]=p.currentTime;p.stop()}
        if let item=manifest.tracks.first(where:{$0.id==control.track}) {
            do {
                let p=try AVAudioPlayer(contentsOf:assets.appendingPathComponent(item.audio))
                p.numberOfLoops = -1;p.volume=Float(max(0,min(1,control.volume)))
                p.prepareToPlay();p.currentTime=min(resume[item.id] ?? 0,max(0,p.duration-0.05))
                player=p;track=item.id;title=item.title;error=nil
            }catch let problem {error=problem.localizedDescription;player=nil}
        }else {error="Unknown track";player=nil}
    }
    player?.volume=Float(max(0,min(1,control.volume)))
    if shouldPlay {
        if player?.isPlaying==false {player?.play()}
        idleSince=nil;reason=error==nil ? "playing":"error"
    }else {
        player?.pause();reason=control.active ? "paused":"world-hidden"
        if idleSince==nil {idleSince=now}
        if now-(idleSince ?? now)>15 {writeStatus();break}
    }
    if now-lastStatus>=1 {writeStatus();lastStatus=now}
    RunLoop.current.run(until:Date(timeIntervalSinceNow:0.2))
}
player?.stop()
