<h1 align="center">
  <a href="https://www.onorca.dev"><img src="resources/build/icon.png" alt="Orca" width="72" valign="middle" /></a>
  <br />
  Orca
</h1>

<p align="center">
  <strong>Run parallel coding agents without branch chaos.</strong><br />
  Orca is a desktop control plane for Claude Code, Codex, Gemini, OpenCode, Cursor,
  and any CLI agent. Every task gets its own worktree, terminal, browser, diff, and path to PR.
</p>

<p align="center">
  <a href="https://www.onorca.dev"><strong>Download Orca</strong></a>
  · <a href="https://github.com/stablyai/orca/releases/latest">Latest release</a>
  · <a href="#quickstart">Quickstart</a>
  · <a href="https://www.onorca.dev/docs">Docs</a>
  · <a href="https://discord.gg/fzjDKHxv8Q">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/stablyai/orca/releases/latest"><img src="https://img.shields.io/github/v/release/stablyai/orca?label=release&style=flat-square" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-0f172a?style=flat-square" alt="macOS, Windows, and Linux" />
  <img src="https://img.shields.io/badge/agents-any%20CLI%20agent-2563eb?style=flat-square" alt="Works with any CLI agent" />
  <img src="https://img.shields.io/badge/login-not%20required-16a34a?style=flat-square" alt="No Orca login required" />
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="docs/README.zh-CN.md">中文</a> · <a href="docs/README.ja.md">日本語</a> · <a href="docs/README.es.md">Español</a>
</p>

<p align="center">
  <img src="docs/assets/feature-wall/parallel-worktrees.gif" alt="Orca showing parallel coding-agent worktrees" width="900" />
</p>

## Why Orca

AI coding agents are most useful when you can run several of them at once. The hard part is keeping their branches, terminals, browser state, diffs, and handoffs under control.

Orca turns that into a single desktop workflow:

| You want to... | Orca gives you... |
|---|---|
| Run multiple agents at the same time | One isolated git worktree per task, with active/idle status visible at a glance |
| Stop losing context between terminal tabs | Agent terminals, files, browser tabs, GitHub issues, diffs, and comments in one worktree view |
| Review AI output before it lands | Built-in source control, inline AI-diff comments, quick edits, commits, and PR flow |
| Use the agent you already pay for | Bring Claude Code, Codex, Gemini, OpenCode, Cursor, or any CLI command |
| Keep working away from your desk | Mobile companion app for monitoring sessions and sending commands from your phone |

## From Prompt To PR

1. Add a GitHub repo.
2. Create a worktree for an issue, feature, bug, or experiment.
3. Launch one or more agents in tabs or split panes.
4. Preview the app in the built-in browser and pass UI context back to the agent.
5. Review the diff, annotate exact lines, and ask the agent to revise.
6. Commit, open a PR, and move on to the next worktree.

## Quickstart

### Download

- **Desktop:** [Download Orca](https://www.onorca.dev) for macOS, Windows, or Linux.
- **Releases:** [GitHub Releases](https://github.com/stablyai/orca/releases/latest).
- **Mobile companion:** [iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) or [Android build from GitHub Releases](https://github.com/stablyai/orca/releases).

### macOS via Homebrew

```bash
brew install --cask stablyai/orca/orca
```

### Arch Linux via AUR

```bash
# Precompiled binary
yay -S stably-orca-bin

# Build from source
yay -S stably-orca-git
```

After installing, open Orca, add a repo, and create your first worktree. Orca does not require an Orca account; use the agent subscriptions and CLIs you already have.

## What Makes Orca Different

Click a workflow tile to open the relevant docs.

<p align="center">
  <a href="https://www.onorca.dev/docs/model/worktrees">
    <kbd>
      <strong>Parallel Worktrees</strong><br /><br />
      <img src="docs/assets/feature-wall/parallel-worktrees.jpg" alt="Parallel worktree orchestration in Orca" width="390" /><br /><br />
      Isolated branches, terminals, files, browser state, and status lanes for every agent task.
    </kbd>
  </a>
  &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/terminal">
    <kbd>
      <strong>Readable Agent Terminals</strong><br /><br />
      <img src="docs/assets/feature-wall/terminal-splits.jpg" alt="Agent terminal splits in Orca" width="390" /><br /><br />
      Run agents side-by-side in tabs and split panes without babysitting shells.
    </kbd>
  </a>
  <br /><br />
  <a href="https://www.onorca.dev/docs/browser/design-mode">
    <kbd>
      <strong>Browser And Design Mode</strong><br /><br />
      <img src="docs/assets/feature-wall/design-mode.jpg" alt="Orca browser Design Mode" width="390" /><br /><br />
      Click UI elements and drop exact browser context into the agent chat.
    </kbd>
  </a>
  &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff">
    <kbd>
      <strong>AI Diff Review</strong><br /><br />
      <img src="docs/assets/feature-wall/annotate-diff.jpg" alt="Annotating AI-generated diffs in Orca" width="390" /><br /><br />
      Comment on generated code, send feedback back to the agent, and revise in place.
    </kbd>
  </a>
  <br /><br />
  <a href="https://www.onorca.dev/docs/review/linear">
    <kbd>
      <strong>GitHub And Linear, Native</strong><br /><br />
      <img src="docs/assets/feature-wall/github-linear.jpg" alt="GitHub and Linear workflows in Orca" width="390" /><br /><br />
      Start from issues, track checks, and keep implementation tied to the work item.
    </kbd>
  </a>
  &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/cli/overview">
    <kbd>
      <strong>Orca CLI</strong><br /><br />
      <img src="docs/assets/feature-wall/orca-cli.jpg" alt="Orca CLI controlling worktrees and terminals" width="390" /><br /><br />
      Let agents create worktrees, read terminals, update status, and drive the browser.
    </kbd>
  </a>
</p>

<details>
<summary><strong>More Orca workflows</strong></summary>

<br />

| Workflow | What it helps with |
|---|---|
| [Mobile companion](mobile/README.md) | Monitor agents and send commands from your phone |
| [SSH worktrees](https://www.onorca.dev/docs/ssh) | Run agents on remote machines from the Orca UI |
| [Drag files to agents](https://www.onorca.dev/docs/editing/file-explorer) | Drop files, screenshots, and images into prompts |
| [Account switcher and usage tracking](https://www.onorca.dev/docs/agents/usage-tracking) | Switch Codex accounts and see usage without config-file churn |
| [Rich repo previews](https://www.onorca.dev/docs/editing/markdown) | Preview Markdown, images, PDFs, and repo docs next to the agent |
| [Split anything](https://www.onorca.dev/docs/model/tabs-panes-splits) | Split agents, terminals, files, browsers, and review panes in one workspace |

</details>

## Supported Agents

Orca runs CLI agents instead of replacing them. Bring the tools and subscriptions you already use.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="docs/assets/claude-logo.svg" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://github.com/google-gemini/gemini-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64" width="16" valign="middle" /> Gemini</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" width="16" valign="middle" /> GitHub Copilot</kbd></a>
</p>

<details>
<summary><strong>Additional agent CLIs people run in Orca</strong></summary>

<br />

<p>
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="docs/assets/droid-logo.svg" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" width="16" valign="middle" /> Rovo Dev</kbd></a>
</p>

</details>

## Mobile Companion

Control your agents from your phone. Pair the mobile app with desktop Orca, check worktree status, inspect terminal output, and send commands while agents run.

<p align="center">
  <picture>
    <source srcset="docs/assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif" />
    <img src="docs/assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca desktop paired with the mobile companion app" width="720" />
  </picture>
</p>

- **iOS:** [Download from the App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Download the latest mobile build from GitHub Releases](https://github.com/stablyai/orca/releases)

## Community &amp; Support

- **Discord:** Join the community on [Discord](https://discord.gg/fzjDKHxv8Q).
- **X:** Follow [@orca_build](https://x.com/orca_build) for updates and shipping notes.
- **Feedback and ideas:** [Request a feature](https://github.com/stablyai/orca/issues).
- **Privacy:** Read the [privacy and telemetry docs](https://www.onorca.dev/docs/telemetry).
- **Support the project:** Star this repo to follow releases and help more agent builders find Orca.

## Developing

Want to contribute or run Orca locally? See [CONTRIBUTING.md](.github/CONTRIBUTING.md).
