# Esse Agent Sidecar

This directory contains the Agent Sidecar distribution of Esse. “Agent Sidecar” is a technical packaging term; the installed application, window, MCP server, skills, and user-facing documentation all call the product **Esse**.

It runs a local Electron workspace and authenticated loopback HTTP MCP for WorkBuddy and other compatible Agents. It has no hosted Esse backend. Provider profiles are stored locally, API keys are protected by the operating system, and the release contains built-in Tuzi configuration presets but no API key.

## Development on Windows

```powershell
npm install
npm run typecheck
npm test
npm run make
```

The unsigned alpha installer is emitted under `out/make/squirrel.windows/x64/Esse-Setup.exe`.

Use `npm start` only for development debugging. Do not commit `out/`, `.vite/`, `node_modules/`, local Provider settings, credentials, inputs, outputs, or QA captures.
