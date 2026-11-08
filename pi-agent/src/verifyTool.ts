import { fetchLearningOverview } from "./learningOverviewTool.js";

const overview = await fetchLearningOverview({
  baseUrl: process.env.LEARNING_API_BASE_URL,
});
console.log(
  JSON.stringify(
    {
      current_goal: overview.current_goal,
      skill_count: overview.skills.length,
      evidence_count: overview.recent_evidence.length,
      has_active_task: overview.active_task !== null,
    },
    null,
    2,
  ),
);
