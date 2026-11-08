import {crc32} from "node:zlib";
/** 测试构造标准无压缩 ZIP，真正经过上传解包器，不绕过 ZIP 校验。 */
export function skillZip(files:Array<{name:string;body:string|Buffer;mode?:number;declaredSize?:number}>):Buffer {
  const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),body=Buffer.from(file.body),size=file.declaredSize??body.length;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt32LE(crc32(body),14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(size,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);
    central.writeUInt32LE(crc32(body),16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);
    central.writeUInt32LE(((file.mode??0o100600)<<16)>>>0,38);central.writeUInt32LE(offset,42);
    locals.push(local,name,body);centrals.push(central,name);offset+=local.length+name.length+body.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
export const skillEntry=(name="comparison-guide",body="METHOD_BODY_A")=>`---\nname: ${name}\ndescription: 把两个容易混淆的概念并排比较。\nmetadata:\n  display_name: 对照讲解\n  short_description: 用同一个例子比较相似概念。\n---\n${body}\n`;
