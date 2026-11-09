# LaWa

[简体中文](README.md)

LaWa is a learning assistant that runs on your computer. Set a goal in your own words, work through a learning plan with explanations and exercises, and pick up where you left off. LaWa saves your learning records locally. You decide when you have mastered a topic.

## Quick start

Install **Python 3.11 or newer**, **Node.js 24** with npm, and Git. Clone the repository into a new directory.

```sh
git clone https://github.com/Sayno-sf/LaWa.git
cd LaWa
```

**Windows.** Double-click [Start-LaWa.bat](Start-LaWa.bat). On a fresh checkout it installs the project dependencies and builds the workspace. Once both local services are ready, it opens the workspace in your browser.

Setup downloads and verifies the local model for camera observation. Model settings start empty. Enable speech and cloud retrieval when you need them.

**Terminal.** From the repository root, run the following command. Use `python3` in place of `python` if that is how your system exposes Python.

```sh
python scripts/bootstrap.py
```

When the launcher reports that LaWa is ready, open [http://127.0.0.1:8787](http://127.0.0.1:8787) or the loopback URL printed in the terminal. In **Settings** (设置), add your model provider, model ID, and API key. Then choose **Start a new goal** (开始新目标) and describe what you want to learn and what you already know.

On later runs, use `python scripts/bootstrap.py start` to start without reinstalling. Press Ctrl+C in the launcher to stop LaWa. The Windows startup flow has been verified. macOS and Linux can use the terminal commands above, and end-to-end verification on those systems is pending.

## Install with your own AI assistant

Copy this prompt into an assistant that can run commands on your computer.

```text
Install LaWa from https://github.com/Sayno-sf/LaWa.git in a new,
dedicated directory. Check for Git, Python 3.11 or newer, and Node.js 24
with npm. If a prerequisite is missing, use its official installation
method and ask for any system permissions you need.

From the new checkout, run `python scripts/bootstrap.py install`, then
`python scripts/bootstrap.py check`. Use `python3` where appropriate.
After the check passes, start LaWa with `python scripts/bootstrap.py start`.
Keep both services on 127.0.0.1. If either default port (8787 for the
workspace or 8000 for the Kernel) is occupied, use confirmed free ports
with --port and --kernel-port. Leave the existing processes, installations
and data untouched. Use only this checkout's data directory, or a new
dedicated directory via --data-dir.

Check that the workspace opens and report the exact URL and how to stop it.
Direct me to Settings so I can enter my own provider, model ID and API key.
Do not ask me to paste a key into this chat, use any existing credentials,
or send a paid model request as part of installation or verification.
```

## What you can do

- Work through a plan one stage at a time, take a branch to fill in background knowledge, and return to the original task.
- Answer practice cards, ask the tutor for help, and pause an illustrated animation to ask about the current frame.
- Save notes and knowledge cards, review your growth map, and import learning records from another tool.

You can open the workspace before configuring a model. Teaching and tutoring need a model provider. Book illustrations, speech, and cloud retrieval use their own optional service settings.

The default data directory is `.lawa/` in the checkout. It holds learning records, documents, conversations, and model credentials and is ignored by Git. When you use a configured model, LaWa sends the relevant conversation or source excerpts to the provider you selected. Keep the service on your computer and store backups privately.

- [Setup and troubleshooting (Chinese)](docs/setup.md)
- [Contributing and verification](CONTRIBUTING.md)
- [Reporting security issues](SECURITY.md)
- [Apache-2.0 license](LICENSE) and [third-party notices](NOTICE)
