import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readSpeechEvents} from './speechStream.js';

const frame=(bytes:number[])=>'data: '+JSON.stringify({output:{audio:{data:Buffer.from(bytes).toString('base64')}}})+'\n\n';
test('audio is delivered before EOF and final URL without being fetched again',async()=>{
  let feed!:ReadableStreamDefaultController<Uint8Array>;const chunks:Buffer[]=[];
  const body=new ReadableStream<Uint8Array>({start(controller){feed=controller;}});
  const pending=readSpeechEvents(new Response(body,{headers:{'Content-Type':'text/event-stream'}}),new AbortController().signal,pcm=>chunks.push(pcm));
  const wire=Buffer.from(frame([1,0,2,0]));feed.enqueue(wire.subarray(0,8));feed.enqueue(wire.subarray(8));
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(chunks.length,1);
  feed.enqueue(Buffer.from('data: {"output":{"finish_reason":"stop","audio":{"url":"https://unused.invalid"}}}\n\n'));feed.close();
  assert.equal((await pending).length,2);assert.deepEqual(chunks[0],Buffer.from([1,0,2,0]));
});
test('truncated streams reject instead of reporting a completed utterance',async()=>{
  await assert.rejects(readSpeechEvents(new Response(frame([1,0]),{headers:{'Content-Type':'text/event-stream'}}),new AbortController().signal,()=>{}),/incomplete/);
});

function wavHeader(length=0x7fffffff){
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(length>=0x7fff0000?0x7fffffff:length+36,4);
  h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);
  h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);
  h.write('data',36);h.writeUInt32LE(length,40);return h;
}
test('streaming WAV header and odd network boundaries never enter PCM output',async()=>{
  const source=Buffer.concat([wavHeader(),Buffer.from([1,0,2,0,3,0])]);const chunks:Buffer[]=[];
  const wire=[source.subarray(0,3),source.subarray(3,35),source.subarray(35,47),source.subarray(47)]
    .map(part=>frame([...part])).join('')+'data: [DONE]\n\n';
  await readSpeechEvents(new Response(wire,{headers:{'Content-Type':'text/event-stream'}}),new AbortController().signal,p=>chunks.push(p));
  assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,0,2,0,3,0]));
});
test('WAV format mismatch and truncated finite-length data reject',async()=>{
  const wrong=wavHeader();wrong.writeUInt32LE(16000,24);
  for(const bytes of [wrong,Buffer.concat([wavHeader(8),Buffer.from([1,0])])]){
    await assert.rejects(readSpeechEvents(new Response(frame([...bytes])+'data: [DONE]\n\n',
      {headers:{'Content-Type':'text/event-stream'}}),new AbortController().signal,()=>{}),/stream/);
  }
});
