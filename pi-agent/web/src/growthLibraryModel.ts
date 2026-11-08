import {latestRecordedTime} from "./learningProgress";
interface ProjectTimes {
  status: string; archived_at?: string | null;
  evidence?: Array<{created_at: string}>; answer_assessments?: Array<{created_at: string}>;
  knowledge_cards?: Array<{created_at: string; note_updated_at?: string | null; feedback_updated_at?: string | null}>;
}
export function orderedGrowthProjects<P extends ProjectTimes>(projects: readonly P[]): P[] {
  return [...projects].sort((a, b) => Number(b.status === "CURRENT") - Number(a.status === "CURRENT"));
}
export function growthProjectTimes(project: ProjectTimes): {recorded: string | null; switched: string | null} {
  return {recorded: latestRecordedTime([...(project.evidence ?? []).map(e => e.created_at), ...(project.answer_assessments ?? []).map(a => a.created_at),
    ...(project.knowledge_cards ?? []).flatMap(c => [c.created_at, c.note_updated_at, c.feedback_updated_at])]),
    switched: project.status === "ARCHIVED" ? project.archived_at ?? null : null};
}
