# telegram-agent

English | [中文](README.zh.md)

A Telegram forum-topic frontend composition: each chat topic drives one durable coding-agent session with its own harness-enforced working folder. Normal messages are plain prompts; `/status`, `/folder`, `/reset`, `/cancel`, and `/help` are the only commands. The bot answers approval requests and `ask_user_question` items with inline buttons, and renders committed answers chunked for the Bot API.

The model-facing tools are `bash` (sandboxed), `read`, `write`, and `edit`, plus automatic context compaction and JSONL session persistence. The sandbox confines each session's writes to its workspace; the plugin's workspace-root validation fences reads.

## Runtime environment

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot token, read by the credentials service from the environment |
| `DSH_TELEGRAM_ALLOWED_CHATS` | Comma-separated chat ids allowed to drive topics |
| `DSH_TELEGRAM_ALLOWED_USERS` | Comma-separated user ids allowed to drive topics |
| `DSH_TELEGRAM_WORKSPACE_ROOTS` | Comma-separated absolute roots a topic workspace may select from (defaults to the process cwd) |
| `DSH_TELEGRAM_DEFAULT_WORKSPACE` | Optional default workspace for first-message creation |
| `DSH_TELEGRAM_API_BASE` | Optional Bot API base URL (tests point this at a local mock) |
| `DSH_TELEGRAM_PROVIDER` / `DSH_TELEGRAM_MODEL` | Provider/model for created sessions (defaults to the DeepSeek official route) |
| `DEEPSEEK_API_KEY` | Credential for the DeepSeek adapter |

Run from this directory with `pnpm dsh --profile telegram-agent`; at least one allowlist side and one workspace root are required, or the plugin fails load with a precise error.

## Keyless smoke

[`tests/keyless-smoke.e2e.ts`](tests/keyless-smoke.e2e.ts) boots the real composition through the Loader with a scripted model adapter and an in-process mock Bot API server, drives one topic message through the real HTTP client, and asserts the committed answer arrives before a clean exit.
