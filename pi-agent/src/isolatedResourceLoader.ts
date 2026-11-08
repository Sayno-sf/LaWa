import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface IsolatedResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  systemPrompt: () => string;
  extensionFactories?: ExtensionFactory[];
}

/**
 * 学习运行时只使用应用显式提供的提示词和扩展。
 * AGENTS.md、APPEND_SYSTEM.md、Skill、Prompt Template 与主机扩展属于开发/宿主配置，
 * 不能因为 Gateway 在某个目录启动就进入学习者的 system prompt。
 */
export function createIsolatedResourceLoader(
  options: IsolatedResourceLoaderOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    extensionFactories: options.extensionFactories ?? [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: options.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
}
