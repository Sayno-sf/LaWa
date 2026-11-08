# 安装与运行

## 常用命令

在仓库根目录运行。使用 `python3` 的系统可以替换下文中的 `python`。

| 命令 | 用途 |
| --- | --- |
| `python scripts/bootstrap.py` | 首次安装并启动 |
| `python scripts/bootstrap.py install` | 安装依赖和构建网页 |
| `python scripts/bootstrap.py start` | 用已安装的环境启动 |
| `python scripts/bootstrap.py check` | 在临时数据目录验证本机服务 |

Windows 可以双击仓库根目录的 [Start-LaWa.bat](../Start-LaWa.bat)。终端启动时也可以加 `--open`，等两项本机服务都就绪后自动打开浏览器。

程序在回环地址启动 Web 和 Python Kernel，默认端口是 8787 和 8000。已经运行另一个 LaWa 时，可单独分配端口和数据目录。

```sh
python scripts/bootstrap.py start --port 8788 --kernel-port 8001 --data-dir .lawa/second
```

首次安装需要访问 PyPI 和 npm registry。检查 `python --version`、`node --version` 与 `npm --version` 是否正常，再运行安装命令。升级源码后可重新运行 `install`。

Debian 或 Ubuntu 若提示缺少 `ensurepip`，请先安装与 Python 版本匹配的 `python3-venv` 包。

## 模型配置

在网页「设置」里填写服务商、模型标识和该服务商的 API Key。使用自定义兼容接口时，按服务商文档填写 API 基地址。设置保存在当前数据目录。把凭据留在本地配置里，提交 Issue 时请清理日志和截图中的凭据、个人内容及文档地址。

能力画像的评估及建议在后台按需调用当前模型。插画、语音、云端检索各自需要相应的服务配置。模型返回质量、响应时间和可用额度取决于所选服务。

## 可选的本机摄像头观察

先完成安装。以下命令获取固定版本的 MediaPipe 模型，校验散列，并把模型和 WASM 加入前端构建。

```sh
npm --prefix pi-agent run camera:assets
npm --prefix pi-agent run web:build
```

更新后刷新页面，再通过浏览器授权摄像头。推理在浏览器进行，摄像头画面不发给本机 Kernel 或模型服务。没有该资产时仍可使用普通学习计时。[模型来源](../third_party/mediapipe/README.md)

## 备份

先按 Ctrl+C 停止服务，再备份整个 `.lawa/` 或指定的数据目录。恢复时将备份复制到一个新的目录，用 `start --data-dir` 打开它，确认记录后再决定是否替换旧目录。备份包含凭据和学习原文，应保存在私密位置。
