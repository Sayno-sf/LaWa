import {icon} from "./icons";
import {skillStatusLabel, type SkillState} from "./skillStatus";
import "./learningRouteView.css";

export interface RouteSkill {
  id: string;
  name: string;
  description: string;
  status: SkillState;
}

export interface RouteMilestone {
  id: string;
  name: string;
  description: string;
  target_depth: string;
  skill_ids?: readonly string[];
}

export interface RouteOverview {
  learning_paths?: import("../../src/learningBranchTypes").LearningPaths;
  goal_profile?: {id: string} | null;
  imported_topics?: {goal_id: string; groups: readonly {id: string; name: string; skill_ids: readonly string[]}[]} | null;
  curriculum_spine: readonly RouteMilestone[];
  active_task: {status: string; related_skill_ids: readonly string[]} | null;
}

export interface RouteViewOptions {
  selectedSkillId?: string | null;
  currentTaskSkillId?: string | null;
}


type Section = readonly number[];
type SectionRange = {start: Section; end: Section};
type Stage = {milestone: RouteMilestone; index: number; skills: RouteSkill[]};

const htmlEntities: Record<string, string> = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => htmlEntities[character]!);

function depthLabel(value: string): string {
  return ({OVERVIEW: "了解概念", PRACTICAL: "能够应用", DEEP: "深入理解"} as Record<string, string>)[value] ?? value;
}

/** 只接受标题中明确的§定位；描述中可能是前置知识或对照章节，不能作为实际归属。 */
function sectionRanges(name: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const annotations = name.matchAll(/§\s*(\d+(?:\.\d+)*(?:\s*[-–—~～]\s*\d+(?:\.\d+)*)?(?:\s*[/、,，]\s*(?:§\s*)?\d+(?:\.\d+)*(?:\s*[-–—~～]\s*\d+(?:\.\d+)*)?)*)/g);
  for (const annotation of annotations) {
    for (const part of annotation[1]!.split(/[/、,，]/)) {
      const ends = part.replace(/§/g, "").trim().split(/\s*[-–—~～]\s*/);
      const start = ends[0]!.split(".").map(Number), end = (ends[1] ?? ends[0]!).split(".").map(Number);
      if (start.every(Number.isSafeInteger) && end.every(Number.isSafeInteger)) ranges.push({start, end});
    }
  }
  return ranges;
}

function compareSection(left: Section, right: Section): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

const withinSection = (child: Section, parent: Section): boolean => parent.every((part, index) => child[index] === part);
const containsRange = (parent: SectionRange, child: SectionRange): boolean =>
  compareSection(parent.start, parent.end) <= 0 && compareSection(child.start, child.end) <= 0 &&
  compareSection(child.start, parent.start) >= 0 &&
  (compareSection(child.end, parent.end) <= 0 || withinSection(child.end, parent.end));

/** 显式关系优先；旧账本仅在全部§定位都落入唯一阶段时作只读展示兼容，不写回Kernel。 */
function resolveStage(skill: RouteSkill, stages: readonly Stage[]): Stage | undefined {
  const declared = stages.filter(stage => stage.milestone.skill_ids?.includes(skill.id));
  if (declared.length) return declared.length === 1 ? declared[0] : undefined;
  const sameId = stages.filter(stage => stage.milestone.id === skill.id);
  if (sameId.length) return sameId.length === 1 ? sameId[0] : undefined;
  const locations = sectionRanges(skill.name);
  if (!locations.length) return;
  const candidates = stages.filter(stage => {
    const scope = sectionRanges(stage.milestone.name);
    return locations.every(location => scope.some(range => containsRange(range, location)));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 直接展示完整阶段树；只投影顺序、真实Skill状态，不推算阶段掌握或改变学习现场。 */
export function renderLearningRoute(overview: RouteOverview, goalSkills: readonly RouteSkill[],
  options: RouteViewOptions = {}): string {
  const stages: Stage[] = overview.curriculum_spine.map((milestone, index) => ({milestone, index, skills: []}));
  const unassigned: RouteSkill[] = [];
  const imported = overview.imported_topics?.goal_id === overview.goal_profile?.id ? overview.imported_topics?.groups ?? [] : [];
  const topics = imported.map(topic => ({...topic, skills: [] as RouteSkill[]}));
  const branches = overview.learning_paths?.branches ?? [];
  const exclusive = new Set(branches.flatMap(b => b.exclusive_skill_ids));
  for (const skill of goalSkills.filter(s => !exclusive.has(s.id))) {
    const stage = resolveStage(skill, stages);
    if (stage) stage.skills.push(skill);
    else {
      // 导入主题只负责目录归属；已有正式路线优先，不伪造课程阶段或学习进度。
      const topic = topics.find(group => group.skill_ids.includes(skill.id));
      if (topic) topic.skills.push(skill); else unassigned.push(skill);
    }
  }
  for (const topic of topics) {
    topic.skills.sort((left, right) => topic.skill_ids.indexOf(left.id) - topic.skill_ids.indexOf(right.id));
  }
  for (const stage of stages) {
    const order = stage.milestone.skill_ids ?? [];
    stage.skills.sort((left, right) => {
      const a = order.indexOf(left.id), b = order.indexOf(right.id);
      if (a >= 0 || b >= 0) return (a < 0 ? Infinity : a) - (b < 0 ? Infinity : b);
      const aSection = sectionRanges(left.name)[0], bSection = sectionRanges(right.name)[0];
      return aSection && bSection ? compareSection(aSection.start, bSection.start) : 0;
    });
  }
  const task = overview.active_task;
  const currentId = task?.status === "ACTIVE" && options.currentTaskSkillId &&
    task.related_skill_ids.includes(options.currentTaskSkillId) ? options.currentTaskSkillId : null;
  const currentStage = stages.find(stage => stage.skills.some(skill => skill.id === currentId));
  const selectedStage = stages.find(stage => stage.skills.some(skill => skill.id === options.selectedSkillId));
  const anchor = selectedStage ?? currentStage ?? stages.find(stage => stage.skills.some(skill => skill.status !== "MASTERED_BY_USER")) ?? stages[0];


  type Anchor = {kind: string; id: string};
  const branchMarkup = (anchors: Anchor[]): string => {
    const attached = branches.filter(b => anchors.some(a => b.anchor_kind === a.kind && b.anchor_id === a.id));
    if (!attached.length) return "";
    const purposes = [attached.some(b => b.purpose === "prerequisite") ? "补足" : "", attached.some(b => b.purpose === "extension") ? "拓展" : ""].filter(Boolean).join(" / ");
    return `<details class="route-side-branches" data-disclosure-key="route-side:${anchors.map(a => `${a.kind}:${escapeHtml(a.id)}`).join("|")}" ${attached.some(b => b.status === "ACTIVE") ? "open" : ""}>
      <summary aria-label="${purposes}分支，${attached.length} 项"><span class="route-branch-connector">${icon("arrowRight")}</span><span>${purposes}${attached.length > 1 ? ` · ${attached.length}` : ""}</span><span class="route-side-chevron">${icon("chevronDown")}</span></summary>
      <div class="route-branch-list">${attached.map(b => {
    const purpose = b.purpose === "prerequisite" ? "补足" : "拓展";
    const status = ({PROPOSED:"待选择",READY:"待学习",ACTIVE:"学习中",PAUSED:"已暂停",COMPLETED:"已完成"})[b.status];
    const branchSkills = b.skill_ids.map(id => goalSkills.find(s => s.id === id)).filter((s): s is RouteSkill => !!s);
    // 自动展开的同名知识点不重复标题，仍保留只读记录入口；进出路径才改变教学焦点。
    const sameTitle = branchSkills.length === 1 && branchSkills[0]!.name === b.title;
    const records = branchSkills.map(s => `<button type="button" class="text-button" data-select-skill="${escapeHtml(s.id)}" data-record-route="${escapeHtml(b.id)}">${sameTitle ? "查看学习记录" : escapeHtml(s.name)}</button>`).join("");
    return `<details class="learning-route-branch${b.status === "ACTIVE" ? " is-active" : ""}" data-disclosure-key="route-branch:${escapeHtml(b.id)}">
      <summary><span class="route-branch-chevron">${icon("chevronDown")}</span><span class="route-branch-title"><strong>${escapeHtml(b.title)}</strong><small>${purpose} · ${status}</small></span></summary>
      <div class="route-branch-content">
        ${records ? `<div class="route-branch-records">${records}</div>` : ""}
        ${b.status === "COMPLETED" ? "" : `<div class="route-branch-actions">${b.status === "ACTIVE"
          ? `<button type="button" class="text-button" data-route-branch="${escapeHtml(b.id)}" data-route-action="complete">完成并返回</button>`
          : `<button type="button" class="ghost-button" data-route-branch="${escapeHtml(b.id)}" data-route-action="enter">${b.status === "PAUSED" ? "继续学习" : `开始${purpose}`}</button>${b.status === "PROPOSED" ? `<button type="button" class="text-button" data-route-branch="${escapeHtml(b.id)}" data-route-action="accept">稍后再学</button>` : ""}`}</div>`}
      </div></details>`;
    }).join("")}</div></details>`;
  };
  const nodeMarkup = (main: string, anchors: Anchor[]): string => {
    const side = branchMarkup(anchors);
    return side ? `<div class="route-node-with-branches">${main}${side}</div>` : main;
  };
  const skillMarkup = (skill: RouteSkill, milestoneId?: string): string => {
    const selected = skill.id === options.selectedSkillId, current = skill.id === currentId;
    const mastered = skill.status === "MASTERED_BY_USER";
    const label = skill.status === "NOT_STARTED" && !current ? "" : skillStatusLabel(skill.status, current);
    const button = `<button type="button" class="learning-route-skill${selected ? " is-selected" : ""}${current ? " is-current" : ""}${mastered ? " is-mastered" : ""}" data-select-skill="${escapeHtml(skill.id)}" aria-pressed="${selected}" title="${escapeHtml([skill.name, skill.description].filter(Boolean).join("\n"))}"><span class="learning-route-skill-marker" aria-hidden="true">${mastered ? icon("check") : ""}</span><span class="learning-route-skill-copy"><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(label)}</small></span></button>`;
    return `<li>${nodeMarkup(button, [{kind: "skill", id: skill.id}, ...(milestoneId ? [{kind: "milestone", id: milestoneId}] : [])])}</li>`;
  };
  const stageMarkup = (stage: Stage): string => {
    const current = stage === currentStage;
    const only = stage.skills.length === 1 ? stage.skills[0] : undefined;
    const sameName = only && only.name.normalize("NFKC").trim() === stage.milestone.name.normalize("NFKC").trim();
    // 合并的是展示层级，按钮仍使用原Skill身份；不把展开知识点的完成当成整个阶段毕业。
    if (sameName) return `<li class="learning-route-stage learning-route-merged${current ? " is-current-stage" : ""}">${skillMarkup(only!, stage.milestone.id).replace(/^<li>|<\/li>$/g, "").replace('class="learning-route-skill-marker"', 'class="learning-route-skill-marker learning-route-stage-number"').replace('aria-hidden="true"></span>', `aria-hidden="true">${stage.index + 1}</span>`)}</li>`;
    const mastered = stage.skills.filter(skill => skill.status === "MASTERED_BY_USER").length;
    const caption = current ? "正在学习" : stage.skills.length ? `已展开 ${stage.skills.length} 项 · 已确认 ${mastered} 项` : "";
    const children = stage.skills.length ? `<ol class="learning-route-skills">${stage.skills.map(s => skillMarkup(s)).join("")}</ol>` : "";
    const heading = `<div class="learning-route-stage-heading"${current ? ' aria-current="step"' : ""}><span class="learning-route-stage-number" aria-hidden="true">${stage.index + 1}</span><div><strong class="learning-route-stage-name" title="${escapeHtml(stage.milestone.name)}">${escapeHtml(stage.milestone.name)}</strong><small class="learning-route-stage-caption">${escapeHtml(caption)}</small></div></div>`;
    return `<li class="learning-route-stage${current ? " is-current-stage" : ""}" value="${stage.index + 1}">${nodeMarkup(heading, [{kind:"milestone", id: stage.milestone.id}])}${children}</li>`;
  };
  const unassignedMarkup = unassigned.length ? `<li class="learning-route-stage learning-route-unassigned"><div class="learning-route-stage-heading"><span class="learning-route-stage-number" aria-hidden="true">${icon("book")}</span><div><strong class="learning-route-stage-name">当前学习知识点</strong><small class="learning-route-stage-caption">尚未归入具体路线阶段</small></div></div><ol class="learning-route-skills">${unassigned.map(s => skillMarkup(s)).join("")}</ol></li>` : "";
  const topicMarkup = topics.filter(topic => topic.skills.length).map(topic => `<li class="learning-route-stage learning-route-import-topic" data-import-topic="${escapeHtml(topic.id)}"><div class="learning-route-stage-heading"><span class="learning-route-stage-number" aria-hidden="true">${icon("book")}</span><div><strong class="learning-route-stage-name" title="${escapeHtml(topic.name)}">${escapeHtml(topic.name)}</strong><small class="learning-route-stage-caption">导入主题 · ${topic.skills.length} 个知识点</small></div></div><ol class="learning-route-skills">${topic.skills.map(s => skillMarkup(s)).join("")}</ol></li>`).join("");
  if (!stages.length) return topicMarkup + unassignedMarkup || '<li class="empty-item">路线确认后，学习阶段与知识点会显示在这里。</li>';
  return stages.map(stage => stageMarkup(stage) + (stage === anchor ? unassignedMarkup : "")).join("") + topicMarkup;
}
