# 参与开发

先按 [README](README.md) 安装。问题报告请附操作系统、Python 与 Node 版本、复现步骤及清理过的报错。建议把修复和无关格式改动分开。

## 代码入口

- `app/` 是 Python Kernel，负责目标、任务、作答证据和学习数据。
- `pi-agent/src/` 是教师和助教运行时以及 Web 网关。
- `pi-agent/web/` 是学习工作区。
- `resources/growth/` 是导入协议、导出提示词与能力评估资源。
- `tests/`、`pi-agent/src/` 和 `pi-agent/web/` 包含测试。默认运行不需要真实模型账号。

教师工具通过 Kernel 写入业务状态。提交功能前，检查题卡、评分、学习记录和掌握确认是否保留各自的业务边界。

## 本地验证

```sh
python scripts/bootstrap.py check
npm --prefix pi-agent run check
npm --prefix pi-agent run check:web
npm --prefix pi-agent test
```

Python 测试可在激活仓库的 `.venv` 后安装测试依赖并运行。

```sh
python -m pip install pytest
python -m pytest -q
```
