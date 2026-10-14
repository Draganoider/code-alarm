# Security

Code Alarm runs inside your coding agent's hooks and can make your phone ring. Here's what it
protects, and how to report a problem.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a
vulnerability). Please don't open a public issue for a security problem. You'll get a reply within
a week. The latest release is the supported one.

## What Code Alarm protects

| What | How |
|---|---|
| Your code, prompts and transcripts | An event carries only a type, an ID, timestamps, the agent's name and the project folder's name ([protocol](docs/protocol.md)). A test fails if anything else appears |
| Your agent sessions | Hooks print nothing, always exit 0, and send in the background. They never decide a permission |
| Your ntfy topic | It's long and random, stored in your config folder with user-only permissions, and never logged. On a public ntfy server, whoever knows it can ring your phone: run `code-alarm init --force` for a new one if it leaks |
| Your sleep | Only armed work rings. Arming expires (12 hours by default, 24 at most), and a project arming ends after its first end-of-task alert |

## Hooks run as you

Like every agent plugin, Code Alarm's hooks run with your privileges. Read
`plugins/claude-code/hooks/hooks.json`, and for Codex the hooks `code-alarm install codex` adds to
`~/.codex/hooks.json`, before you trust them. Codex asks you to review each one.
