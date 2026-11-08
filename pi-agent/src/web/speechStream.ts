// 复用 SpeechService 的 SSE/PCM 语义，但按到达次序处理事件，不等完整响应体。
export class SpeechStreamError extends Error {}

// 当前百炼既可能发裸 PCM，也可能先发 44 字节流式 WAV 头（长度占位）。
// 只接受已核对的 24kHz/单声道/s16 形状；头跨事件时先攒齐，绝不送入扬声器。
class StreamPcm {
  private pending:Buffer=Buffer.alloc(0);
  private mode:'unknown'|'wav'|'pcm'='unknown';
  private expected:number|undefined;
  private received=0;
  constructor(private emit:(pcm:Buffer)=>void){}
  push(bytes:Buffer){
    this.pending=Buffer.concat([this.pending,bytes]);
    if(this.mode==='unknown'){
      if(this.pending.length<4)return;
      this.mode=this.pending.subarray(0,4).toString()==='RIFF'?'wav':'pcm';
    }
    if(this.mode==='wav'){
      if(this.pending.length<44)return;
      const b=this.pending;
      if(b.toString('ascii',8,16)!=='WAVEfmt '||b.readUInt32LE(16)!==16||b.readUInt16LE(20)!==1||
         b.readUInt16LE(22)!==1||b.readUInt32LE(24)!==24000||b.readUInt32LE(28)!==48000||
         b.readUInt16LE(32)!==2||b.readUInt16LE(34)!==16||b.toString('ascii',36,40)!=='data')
        throw new SpeechStreamError('unsupported_stream_wav');
      const length=b.readUInt32LE(40);
      if(length<0x7fff0000){
        if(!length||length%2||b.readUInt32LE(4)!==length+36)throw new SpeechStreamError('invalid_stream_wav');
        this.expected=length;
      }
      this.pending=b.subarray(44);this.mode='pcm';
    }
    const size=this.pending.length-this.pending.length%2;
    if(size){
      this.received+=size;
      if(this.expected!==undefined&&this.received>this.expected)throw new SpeechStreamError('invalid_stream_wav');
      this.emit(this.pending.subarray(0,size));this.pending=this.pending.subarray(size);
    }
  }
  finish(){
    if(this.mode==='unknown'&&this.pending.length===2){this.mode='pcm';this.received=2;this.emit(this.pending);this.pending=Buffer.alloc(0);}
    if(this.mode!=='pcm'||this.pending.length||!this.received||
       (this.expected!==undefined&&this.received!==this.expected))throw new SpeechStreamError('incomplete_audio_stream');
  }
}
export async function readSpeechEvents(response:Response,signal:AbortSignal,onAudio:(pcm:Buffer)=>void):Promise<Record<string,unknown>[]> {
  if(!response.body||!response.headers.get("content-type")?.includes("text/event-stream"))throw new SpeechStreamError("streaming_audio_required");
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let pending="",total=0,audioBytes=0,complete=false;
  const events:Record<string,unknown>[]=[];
  const pcmStream=new StreamPcm(onAudio);
  try {
    while(true) {
      signal.throwIfAborted();const part=await reader.read();
      if(part.done)break;
      total+=part.value.length;if(total>12*1024*1024)throw new SpeechStreamError("stream_too_large");
      pending+=decoder.decode(part.value,{stream:true});
      let boundary:RegExpMatchArray|null;
      while((boundary=pending.match(/\r?\n\r?\n/))) {
        const at=boundary.index!;const event=pending.slice(0,at);pending=pending.slice(at+boundary[0].length);
        const data=event.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");
        if(!data)continue;if(data==="[DONE]"){complete=true;continue;}
        let value:Record<string,unknown>;
        try {value=JSON.parse(data) as Record<string,unknown>;} catch {throw new SpeechStreamError("invalid_stream_event");}
        if(!value||typeof value!=="object")throw new SpeechStreamError("invalid_stream_event");
        if(typeof value.status_code==="number"&&value.status_code!==200)throw new SpeechStreamError("stream_provider_error");
        const output=value.output as {finish_reason?:unknown;audio?:{data?:unknown}}|undefined;
        const encoded=output?.audio?.data;
        if(typeof encoded==="string"&&encoded){
          if(complete||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new SpeechStreamError("invalid_stream_pcm");
          const pcm=Buffer.from(encoded,"base64");audioBytes+=pcm.length;
          if(audioBytes>8*1024*1024)throw new SpeechStreamError("invalid_stream_pcm");
          pcmStream.push(pcm);
        }
        if(output?.finish_reason==="stop")complete=true;
        events.push(value);
      }
    }
    if(pending.trim()||!complete||!audioBytes)throw new SpeechStreamError("incomplete_audio_stream");
    pcmStream.finish();
    return events;
  }finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
