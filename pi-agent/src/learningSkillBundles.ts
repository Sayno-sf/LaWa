import {LearningSkillPreferences} from "./learningSkillPreferences.js";
import {LearningSkillLibrary} from "./learningSkillLibrary.js";
import {LearningSkillRuntime,type LearningSkillAdapter} from "./learningSkills.js";
type Surface="WEB"|"CLI";
type Role="TEACHER"|"ASSISTANT";

/** 只有应用注册的目录参与发现；宿主适配与通用读取机制分开，不扫描机器上的个人技能或扩展。 */
export function createBundledLearningSkills(surface:Surface,role:Role,library=new LearningSkillLibrary(),preferences=new LearningSkillPreferences()):LearningSkillRuntime {
  return new LearningSkillRuntime({
    enabled:surface==="WEB"?(name)=>preferences.enabled(name):undefined,
    roots:[library.bundledRoot],additionalRoots:()=>library.additionalRoots(),installed:name=>library.installed(name),surface,role,
    adapters:{"lawa-illustrated-lesson":{
        description:role==="ASSISTANT"?"解释当前插画、可调示意的读数或讲解动画停下的那一刻。":"在正文中插入书籍插画、可调示意或按时间播放的讲解动画。适合让学习者看见对象怎样变化、传递或相互影响。",
        hostInstructions:role==="TEACHER"&&surface==="WEB"?"prepare_lesson_figures 既能制作正文插图，也能制作带同步字幕的讲解动画。学习者想按一次播放跟着讲解时，读 references/motion.md，使用 motion 编排。读者想先在图里猜时，按需读取 references/prediction.md。根据回执里的实际类型向学习者介绍作品。":"当前角色可阅读画法和解释已呈现的图。",
        requiredResourcesByTool:{prepare_lesson_figures:["SKILL.md"]},
      }},
  });
}
