# 成长图谱协议资源

- `capability-rubric-v1.3.1.md`：生产与回测共同加载的评分说明。Node/Python的policy_version须同步修改；资料hash、说明版本和模型身份共同决定缓存。
- `learning-import.schema.json`：`lawa.learning-import/v1` JSON Schema，由app/growth_protocol.py生成。运行时还校验跨记录引用、总数量及原文合计长度，Schema通过不代表导入已经保存。
- `export-prompt.md`：给其他AI的导出提示词；仅提取实际存在内容，区分学习者原答与AI讲解，不导入正式评分或掌握状态。
- `calibration-fixtures.json`：规划阶段与本轮沿用的合成数据，包含窄目标、重复、自述隔离、广度、深度、混合领域和保留样例；其中旧分数仅为历史实验，不作为当前评价真值。

用户文件限制：UTF-8 1 MiB，20个目标、合计200个知识点、100份作答样本，每份原题/原答/反馈/上下文合计16000字符。未知发生时间为null，导入时间由Kernel另记。原答缩进及换行按原文保存。媒体只保存来源说明，首版不执行代码或评审像素/音频。

连续学习方向或同一项目导出为一个目标，用`skills[].topic`保留内部主题。预览默认把所选条目合为一个目标，可切换分别保存或明确追加已有目标；同名不自动合并。已保存的批次支持保留唯一已有进度目标进行整合，多个独立进度不能自动合并。撤回批次移除其有效自述与外部表现，已经确认建立的目标/知识点身份和之后的正常学习保留。首次继续导入目标时再确认路线。

可选资料接受null或省略。原题缺失可用null或空串，保留真实原答供有限评审，不能编造题目；没有学习者原答则不创建作答样本。代码原文不做strip或换行替换，AI讲解/示例不能冒充学习者表现。前端接受完整JSON代码围栏和BOM，仍拒绝混杂说明或损坏的JSON。

新导出提示词要求每个知识点填写简短具体topic；协议保留缺省兼容旧文件，预览会提醒。课堂直接按导入主题组织未入路线的知识点；学习库可修改主题或移入已有阶段。用户修改单独保存topic_overrides，不改导入原文、来源或去重身份。

导出数组按原对话的实际学习先后排列，禁止按教材顺序重写经历。topic按首次出现归组，主题内保持首次学习顺序，回顾不重复建知识点。background_summary先写最近学习位置和未解决问题，再概括此前经历，未知明确保留；供首次续学选择接点，不等于掌握或完成状态。原有文件不会按猜测回填顺序，跨文件也不推测时间。

生成Schema（仓库根目录）：

```powershell
.venv/Scripts/python.exe -X utf8 -c "import json; from pathlib import Path; from app.growth_protocol import LearningImport; Path('resources/growth/learning-import.schema.json').write_text(json.dumps(LearningImport.model_json_schema(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')"
```

验证命令、隔离预览和真实模型调用边界见[RUNBOOK](../../RUNBOOK.md)；本轮结果见[验收记录](../../docs/evals/GROWTH_ATLAS_V1_20261101.md)。
