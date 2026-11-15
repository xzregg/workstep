/** Local energy gate, not speaker identification. Sound never cancels an assistant turn. */
export class DialogueTurnDetector{
 private last=-1;private finished=false;private voicedMs=0
 reset(){this.last=-1;this.finished=false;this.voicedMs=0}
 frame(level:number,now:number,durationMs=500):void{
  if(this.finished)return
  if(level>.035){if(!this.hasSpeech&&this.last>=0&&now-this.last>250)this.voicedMs=0;this.last=now;this.voicedMs+=durationMs}
 }
 observe(samples:Int16Array,now:number){
  // Judge 20ms windows rather than treating a half-second batch's final peak as speech.
  for(let offset=0;offset<samples.length;offset+=320){
   const end=Math.min(samples.length,offset+320);let sum=0
   for(let i=offset;i<end;i++)sum+=(samples[i]/32768)**2
   const level=Math.sqrt(sum/Math.max(1,end-offset))*5
   this.frame(level,now-(samples.length-end)/16,(end-offset)/16)
  }
 }
 get hasSpeech(){return this.voicedMs>=320}
 accepts(text:string){return this.hasSpeech&&/[\p{L}\p{N}]/u.test(text)}
 tick(now:number):'finish'|'none'{
  if(!this.finished&&this.hasSpeech&&this.last>=0&&now-this.last>=900){this.finished=true;return 'finish'}
  return 'none'
 }
}
