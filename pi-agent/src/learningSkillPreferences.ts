import {readFileSync,writeFileSync,mkdirSync,renameSync} from "node:fs";
import {dirname,join} from "node:path";
import {skillSessionDirectory} from "./learningSkillLibrary.js";
export class LearningSkillPreferences {
  constructor(readonly path=join(skillSessionDirectory(),"learning-skills.json")) {}
  private read():Record<string,boolean> {
    try {const value:unknown=JSON.parse(readFileSync(this.path,"utf8"));
      if(!value||typeof value!=="object"||Array.isArray(value)||Object.values(value).some(v=>typeof v!=="boolean"))throw new Error("技能设置损坏");
      return value as Record<string,boolean>;
    } catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return {};throw error;}
  }
  enabled(name:string):boolean {return this.read()[name]!==false;}
  set(name:string,enabled:boolean):void {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||typeof enabled!=="boolean")throw new Error("技能设置无效");
    const value=this.read();value[name]=enabled;mkdirSync(dirname(this.path),{recursive:true});
    const temporary=this.path+".tmp";writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,this.path);
  }
}
