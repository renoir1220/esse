# esse

Local ChatGPT Work/Codex plugin for parallel image generation and editing. Say `esse` to open it.

## Runtime design

```text
ChatGPT desktop Work/Codex
  -> plugin-launched local stdio MCP adapter
     -> per-user single-instance Esse Core over restricted local IPC
        -> local folder inspection and persistent batch queue
        -> current Agent image capability or selected Provider API
        -> local output folder
```

There is no public MCP endpoint. The stdio adapter owns no writable state; the single-instance Core exclusively owns Provider credentials, batch persistence, and scheduling so parallel Codex tasks cannot overwrite each other. Active Provider work continues if one stdio adapter disconnects. The widget calls app-only settings tools so API keys do not enter model-visible tool input or output.

Windows Releases use a self-contained executable. macOS Releases contain the bundled JS service and a Bash launcher that accepts only the signed Node.js runtime managed by Codex/ChatGPT. Users do not install Node separately, and Esse does not ship its own unsigned macOS executable.

One Provider Profile represents one exact credential group, price tier, API contract, and concurrency limit. If the same underlying model is sold through several tiers with different interfaces, configure separate profiles.

`Codex 生成` is a built-in offering. It does not have a Provider profile or credentials: the current Agent uses whatever image-generation capability and concurrency strategy it supports, then submits each local result back to Esse. Its cost label is `模型额度`.

## Tools

- `open_esse`
- `list_image_offerings`
- `inspect_image_folder`
- `list_image_batches`
- `create_image_batch`
- `start_agent_image_job`
- `complete_agent_image_job`
- `fail_agent_image_job`
- `get_image_batch`
- `render_image_batch`
- `modify_selected_images`
- `delete_esse_images`
- `merge_image_batches`
- `ui_*` app-only tools for settings, previews, progress, local refresh, cancel, retry, and batch management

## Security

- Windows secrets: current-user DPAPI ciphertext.
- macOS secrets: system Keychain.
- Provider keys are never returned by MCP tools.
- Source images are never overwritten.
- Timed-out/interrupted requests use `chargeState: unknown` and are not blindly retried.
- Batches and generated files persist locally across plugin restarts.
- The macOS installer never falls back to an arbitrary `codex` or `node` command from `PATH`.

## Development

```bash
npm install
npm run check
npm run preview
```

`npm run preview` is a development-only static UI preview. Production enters through local stdio and reaches the single-instance Core through user-restricted local IPC.
