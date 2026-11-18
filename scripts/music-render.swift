// Offline General MIDI renderer. Uses the OS sound bank without redistributing it.
import Foundation
import AVFoundation
import AudioToolbox

struct Instrument:Decodable { let name:String; let program:UInt8; let pan:UInt8 }
struct Note:Decodable { let instrument:Int; let beat:Double; let pitch:UInt8; let duration:Double; let velocity:UInt8 }
struct Score:Decodable { let id:String; let bpm:Double; let duration:Double; let instruments:[Instrument]; let notes:[Note] }
struct Event {let sample:Int64;let instrument:Int;let pitch:UInt8;let velocity:UInt8;let on:Bool}
let args=CommandLine.arguments
if args.count != 3 {fputs("usage: music-render score.json output.wav\n",stderr);exit(2)}
let score=try JSONDecoder().decode(Score.self,from:Data(contentsOf:URL(fileURLWithPath:args[1])))
let rate=44100.0,engine=AVAudioEngine(),reverb=AVAudioUnitReverb()
engine.attach(reverb);reverb.loadFactoryPreset(.mediumHall);reverb.wetDryMix=15
let bus=AVAudioMixerNode();engine.attach(bus)
engine.connect(bus,to:reverb,format:nil);engine.connect(reverb,to:engine.mainMixerNode,format:nil)
engine.mainMixerNode.outputVolume=0.42
let bank=URL(fileURLWithPath:"/System/Library/Components/CoreAudio.component/Contents/Resources/gs_instruments.dls")
var samplers:[AVAudioUnitSampler]=[]
for inst in score.instruments {
  let sampler=AVAudioUnitSampler();engine.attach(sampler);engine.connect(sampler,to:bus,format:nil)
  try sampler.loadSoundBankInstrument(at:bank,program:inst.program,bankMSB:UInt8(kAUSampler_DefaultMelodicBankMSB),bankLSB:0)
  sampler.sendController(10,withValue:inst.pan,onChannel:0);sampler.sendController(7,withValue:100,onChannel:0)
  sampler.sendController(91,withValue:0,onChannel:0);samplers.append(sampler)
}
let format=AVAudioFormat(standardFormatWithSampleRate:rate,channels:2)!
try engine.enableManualRenderingMode(.offline,format:format,maximumFrameCount:2048)
try engine.start()
let settings:[String:Any]=[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:rate,AVNumberOfChannelsKey:2,AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsBigEndianKey:false,AVLinearPCMIsNonInterleaved:false]
var file:AVAudioFile?=try AVAudioFile(forWriting:URL(fileURLWithPath:args[2]),settings:settings)
let buffer=AVAudioPCMBuffer(pcmFormat:engine.manualRenderingFormat,frameCapacity:2048)!
var events:[Event]=[]
for n in score.notes {
  events.append(Event(sample:Int64(n.beat*60/score.bpm*rate),instrument:n.instrument,pitch:n.pitch,velocity:n.velocity,on:true))
  events.append(Event(sample:Int64((n.beat+n.duration)*60/score.bpm*rate),instrument:n.instrument,pitch:n.pitch,velocity:0,on:false))
}
events.sort {a,b in a.sample==b.sample ? (!a.on && b.on) : a.sample<b.sample}
let total=Int64(score.duration*rate);var offset:Int64=0,index=0;var peak:Float=0,sumSquares:Double=0,samples:Int64=0
while offset<total {
  while index<events.count && events[index].sample<=offset {let e=events[index];if e.on {samplers[e.instrument].startNote(e.pitch,withVelocity:e.velocity,onChannel:0)}else{samplers[e.instrument].stopNote(e.pitch,onChannel:0)};index+=1}
  let untilEvent=index<events.count ? events[index].sample-offset : total-offset
  let frames=AVAudioFrameCount(min(2048,min(total-offset,max(1,untilEvent))))
  let status=try engine.renderOffline(frames,to:buffer)
  if status == .cannotDoInCurrentContext {continue}
  if status == .error {throw NSError(domain:"render",code:1,userInfo:nil)}
  if let channels=buffer.floatChannelData {
    for ch in 0..<Int(buffer.format.channelCount) {for i in 0..<Int(buffer.frameLength) {
      let time=Double(offset+Int64(i))/rate
      let envelope=Float(min(1,time/0.35)*min(1,max(0,(score.duration-time)/2.0)))
      channels[ch][i] *= envelope * 7.0
      let v=channels[ch][i];peak=max(peak,abs(v));sumSquares+=Double(v*v);samples+=1
    }}
  }
  try file!.write(from:buffer);offset+=Int64(buffer.frameLength)
}
file=nil // Finalize the WAV header before a converter opens it.
engine.stop()
let rms=sqrt(sumSquares/Double(samples))
print("\(score.id): \(Double(offset)/rate)s; peak \(peak) (\(20*log10(Double(max(peak,1e-9)))) dBFS), RMS \(20*log10(max(rms,1e-9))) dBFS")
