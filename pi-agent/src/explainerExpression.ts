/** 有界数学语法，不借助eval/Function，不允许属性、赋值或任意标识符。 */
export function sampleExplainerExpression(source:string,range:[number,number],count:number):Array<[number,number]> {
  if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]>=range[1]||!Number.isInteger(count)||count<2||count>129)throw new Error("fn采样范围或数量无效。");
  if(typeof source!=="string"||source.length>160)throw new Error("fn表达式过长。");
  const matches=source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[+*/^(),-]|\S/g)??[];
  if(!matches.length||matches.length>128)throw new Error("fn表达式为空或过长。");
  let at=0,depth=0;type Fn=(x:number)=>number;
  const bounded=(v:number)=>{if(!Number.isFinite(v)||Math.abs(v)>1e12)throw new Error("fn中间值无效或超界。");return v;};
  const take=()=>matches[at++],peek=()=>matches[at];
  const functions:Record<string,{min:number;max:number;fn:(...v:number[])=>number}>={
    sin:{min:1,max:1,fn:Math.sin},cos:{min:1,max:1,fn:Math.cos},tan:{min:1,max:1,fn:Math.tan},
    exp:{min:1,max:1,fn:Math.exp},log:{min:1,max:1,fn:Math.log},sqrt:{min:1,max:1,fn:Math.sqrt},abs:{min:1,max:1,fn:Math.abs},
    min:{min:2,max:4,fn:Math.min},max:{min:2,max:4,fn:Math.max},pow:{min:2,max:2,fn:Math.pow},
  };
  const primary=():Fn=>{
    if(++depth>16)throw new Error("fn嵌套过深。");
    const token=take();let result:Fn;
    if(token==="("){result=sum();if(take()!==")")throw new Error("fn括号不匹配。");}
    else if(token==="x")result=x=>x;
    else if(token==="pi")result=()=>Math.PI;
    else if(token==="e")result=()=>Math.E;
    else if(token&&/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(token)){const n=bounded(Number(token));result=()=>n;}
    else if(token&&Object.hasOwn(functions,token)){
      const f=functions[token]!;if(take()!=="(")throw new Error("fn函数需要括号。");const args:Fn[]=[];
      if(peek()!==")"){args.push(sum());while(peek()===","){take();args.push(sum());if(args.length>4)throw new Error("fn参数过多。");}}
      if(take()!==")"||args.length<f.min||args.length>f.max)throw new Error("fn函数参数数量无效。");result=x=>bounded(f.fn(...args.map(a=>a(x))));
    }else throw new Error("fn含未支持语法或标识符。");
    depth--;return result;
  };
  const power=():Fn=>{const left=primary();if(peek()!=="^")return left;take();const right=unary();return x=>bounded(Math.pow(left(x),right(x)));};
  const unary=():Fn=>{if(peek()==="+"||peek()==="-"){if(++depth>16)throw new Error("fn嵌套过深。");const sign=take(),value=unary();depth--;return x=>sign==="-"?-value(x):value(x);}return power();};
  const product=():Fn=>{let left=unary();while(peek()==="*"||peek()==="/"){const op=take(),a=left,b=unary();left=x=>bounded(op==="*"?a(x)*b(x):a(x)/b(x));}return left;};
  const sum=():Fn=>{let left=product();while(peek()==="+"||peek()==="-"){const op=take(),a=left,b=product();left=x=>bounded(op==="+"?a(x)+b(x):a(x)-b(x));}return left;};
  const fn=sum();if(at!==matches.length)throw new Error("fn含未支持语法。");
  const points:Array<[number,number]>=[];
  for(let i=0;i<count;i++){const x=range[0]+(range[1]-range[0])*i/(count-1),y=fn(x);if(!Number.isFinite(y)||Math.abs(y)>1e12)throw new Error("fn采样值无效或超界。");points.push([x,y]);}
  return points;
}
