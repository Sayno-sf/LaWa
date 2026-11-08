export interface GuideContext {
  ready: boolean;
  hasHistory: boolean;
  hasGoal: boolean;
  classroom: boolean;
  busy: boolean;
  hasCards: boolean;
  voice: boolean;
  purpose: string | null;
  questionCount: number;
  view: string;
}

export interface GuideTip {
  id: string;
  title: string;
  where: string;
  text: string;
  target: string;
  group: "开始与课堂" | "资料与复习" | "反馈与设置";
  trigger: "auto" | "interest";
  eligible: (context: GuideContext) => boolean;
}

const classroom = (c: GuideContext) => c.classroom && c.view === "learn";
const learning = (c: GuideContext) => c.hasGoal && c.view === "learn";
export const guideTips: readonly GuideTip[] = [
  {id:"start",group:"开始与课堂",title:"开始一个学习目标",where:"顶栏 · 开始新目标",text:"想学什么，从这里开始。可以说一个主题，也可以描述你希望做到的事；已有目标会保留。",target:"#new-goal-button",trigger:"auto",eligible:c=>!c.hasGoal && c.view==="learn"},
  {id:"chat",group:"开始与课堂",title:"和老师交流",where:"课堂底部 · 与老师对话",text:"这里可以回答、提问，也可以告诉老师：讲慢一点、换个例子，或者我想先试试。",target:"#message-input",trigger:"auto",eligible:classroom},
  {id:"assistant",group:"开始与课堂",title:"单独问问助教",where:"课堂右上方 · 助教",text:"某个细节还没弄懂？打开助教，围绕当前内容继续追问。主课堂会保留在原处，问完可以回来继续。",target:"#assistant-entry",trigger:"auto",eligible:classroom},
  {id:"route",group:"开始与课堂",title:"查看学习路线",where:"课堂页头 · 路线 / 左侧刻度带",text:"展开路线，看看当前目标有哪些阶段、现在学到哪里。细刻度带也可以点击展开；阶段位置不代表掌握比例。",target:"#route-toggle, .route-position",trigger:"auto",eligible:learning},
  {id:"library",group:"开始与课堂",title:"找回之前的学习",where:"左侧导航 · 学习库",text:"学习目标、路线和已保存的记录都在这里。以后可以从学习库继续原来的学习。",target:"#learning-library-button",trigger:"auto",eligible:c=>c.hasGoal},
  {id:"upload",group:"资料与复习",title:"带着自己的资料学",where:"输入框左侧 · ＋",text:"点这里上传文档或图片，也可以在输入框粘贴图片。上传后，可在路线底部的「学习资料」查看和管理。",target:"#materials-button",trigger:"interest",eligible:c=>c.view==="learn"},
  {id:"materials",group:"资料与复习",title:"查看资料和出处",where:"路线底部 · 学习资料",text:"已上传资料在这里管理。可以查看原文和出处，再回到课堂；删除资料也在资料页操作。",target:"[data-materials-open], #materials-page-title",trigger:"auto",eligible:c=>c.hasGoal},
  {id:"cards",group:"资料与复习",title:"用知识卡片回顾",where:"课堂页签 · 知识卡片",text:"这里整理本节已有的关键知识。可以先回想，再展开答案，也可以切换为逐张复习。",target:"#task-focus-toggle",trigger:"auto",eligible:c=>learning(c)&&c.hasCards},
  {id:"note",group:"资料与复习",title:"记下自己的理解",where:"知识卡片 · 添加我的笔记",text:"把你的理解和疑问写在卡片上，点击保存。之后从左侧「笔记」集中回看，也能返回对应卡片。",target:'[data-card-action="edit-note"]',trigger:"auto",eligible:c=>c.hasCards},
  {id:"notes",group:"资料与复习",title:"集中回看笔记",where:"左侧导航 · 笔记",text:"这里汇总你保存的笔记。新笔记从知识卡片上的「添加我的笔记」开始，保存后会出现在这里。",target:"#notes-page-title",trigger:"auto",eligible:c=>c.view==="notes"},
  {id:"voice",group:"开始与课堂",title:"用语音表达",where:"输入框右侧 · 麦克风",text:"语音会先转成可编辑文字，核对后再发送。需要先在设置里的「语音」完成配置。",target:"#voice-input-button",trigger:"interest",eligible:c=>classroom(c)&&c.voice},
  {id:"practice",group:"反馈与设置",title:"答案在题卡里提交",where:"课堂题卡 · 提交回答",text:"答案填写在题卡内，点击提交才发送本次作答。底部对话仍然可以提问、交流或调整学习节奏。",target:"#learner-questions [data-question-submit]",trigger:"auto",eligible:c=>classroom(c)&&c.purpose==="CHECK"&&c.questionCount===1},
  {id:"practice-set",group:"反馈与设置",title:"完成后统一提交",where:"课堂题组 · 上一题 / 下一题 / 提交整组答案",text:"上一题、下一题用于切换并保留草稿；最后点击「提交整组答案」才发送。底部对话可以独立交流。",target:"#learner-questions [data-question-submit]",trigger:"auto",eligible:c=>classroom(c)&&(c.purpose==="PRACTICE_SET"||c.purpose==="CHECK")&&c.questionCount>1},
  {id:"assessment",group:"反馈与设置",title:"读懂本次作答反馈",where:"课堂 · 评分卡",text:"这里是本次回答的反馈，展开可看评分依据。以后也能在学习库回看；本题得分不代表整个知识点已经掌握。",target:"#messages .answer-assessment:last-of-type .assessment-heading",trigger:"auto",eligible:classroom},
  {id:"mastery",group:"反馈与设置",title:"由你确认掌握",where:"当前知识点页头 · 我确认已经掌握",text:"当你认为自己已经能做到时，再确认掌握。这是对当前知识点的独立确认，不是普通的「下一步」。",target:'[data-action="master"]',trigger:"interest",eligible:classroom},
  {id:"proposal",group:"反馈与设置",title:"建议等你确认",where:"课堂 · 教学建议 / 计划修订",text:"这里是待确认的建议。可以接受、拒绝或补充想法；只有你明确确认后，相应调整才会应用。",target:".teaching-proposal h3, #learner-questions .learner-decision-actions",trigger:"auto",eligible:learning},
  {id:"teaching",group:"反馈与设置",title:"管理教学偏好",where:"左侧导航 · 教学偏好",text:"在这里管理希望老师采用的讲解和练习方式。已保存的方法可以查看、调整或停用。",target:"#teaching-page-title",trigger:"auto",eligible:c=>c.view==="teaching"},
  {id:"observation",group:"反馈与设置",title:"可选的学习观察",where:"课堂页头 · 学习观察",text:"可自愿开启摄像头观察与计时。画面只在设备内处理，不上传、不保存；观察状态和时间会同步，可能误判，时间不代表掌握。",target:".study-observer-trigger",trigger:"interest",eligible:classroom},
  {id:"introduction",group:"开始与课堂",title:"了解当前知识点",where:"当前知识点页头 · 查看介绍",text:"这里说明当前学习内容。展开阅读后可以收起，不会切换你的学习任务。",target:'[data-action="toggle-focused-introduction"]',trigger:"interest",eligible:learning},
  {id:"activity",group:"反馈与设置",title:"查看老师正在做什么",where:"顶栏 · 活动图标",text:"查看老师当前的工具活动，例如读取资料。这里展示处理状态，不是学习完成进度。",target:"#activity-button",trigger:"interest",eligible:()=>true},
  {id:"conversations",group:"开始与课堂",title:"整理和切换对话",where:"左侧 · 最近对话 / 顶栏 … → 管理对话",text:"最近对话常驻展开，可在左侧滚动查看全部对话；右上角「…」里的「管理对话」用于整理。切换时会恢复对应的学习内容。",target:"#conversation-library-menu-button",trigger:"interest",eligible:()=>true},
  {id:"settings",group:"反馈与设置",title:"连接与功能设置",where:"左侧导航 · 设置",text:"教学模型、语音和资料检索在这里配置。连接有问题时，可在教学模型页测试连接；改动后记得保存。",target:"#settings-page-title",trigger:"auto",eligible:c=>c.view==="settings"},
];

export const GUIDE_KEY = "learn-anything:feature-guide:v1";
export interface GuidePreference { mode: "active" | "off"; seen: string[]; }
export function parseGuidePreference(value: string | null): GuidePreference | null {
  try {
    const data = JSON.parse(value ?? "null");
    if (!data || !["active", "off"].includes(data.mode) || !Array.isArray(data.seen)) return null;
    return {mode:data.mode,seen:data.seen.filter((id: unknown): id is string => typeof id==="string"&&guideTips.some(t=>t.id===id))};
  } catch { return null; }
}
