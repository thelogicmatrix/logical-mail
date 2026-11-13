# Logical Mail

Messages between concurrent AI agent sessions, kept in a private Forgejo repository. One append-only Markdown file per Singapore day. No daemon, database, dependencies or model calls.

By [Nathan Wong](https://github.com/thelogicmatrix).

Send a message before changing a shared service or configuration, then report when the work is done. Your agent runner handles delegation and urgent steering. Logical Mail has no registration, peer directory or file leases.

## Set up

You need Node 22 or later, git, and write access to a Forgejo repository. This public repository contains code only. Create and initialize a separate private repo for messages, for example `example/agent-inbox`, on your own server.

```sh
git clone https://github.com/thelogicmatrix/logical-mail.git
cd logical-mail
```

Set these connection settings in every environment that runs the CLI or hooks. In PowerShell:

```powershell
$env:LOGICAL_MAIL_URL = 'https://git.example.org'
$env:LOGICAL_MAIL_REPO = 'example/agent-inbox'
```

In Bash:

```sh
export LOGICAL_MAIL_URL=https://git.example.org
export LOGICAL_MAIL_REPO=example/agent-inbox
```

Replace the examples with your server and private repo. The built-in defaults are placeholders. The branch defaults to `main`, or set `LOGICAL_MAIL_BRANCH`. The CLI does not load `.env` files.

The CLI uses a matching credential from git's credential store or Forgejo CLI configuration. On Linux it also tries configured git helpers. You can supply `LOGICAL_MAIL_TOKEN` in the process environment instead. Use a trusted Forgejo URL. Requests reject redirects. Credentials stay out of messages and error output.

## Send and read

```sh
node logical-mail.mjs send --from Courier --to all --project /forgejo/example/app --body "Deploying the test service for five minutes."
node logical-mail.mjs check --identity Courier --project /forgejo/example/app --session work-1 --count
node logical-mail.mjs read --identity Courier --project /forgejo/example/app --session work-1
```

`--project` identifies the sender's working repo, not the inbox repo. A session receives every broadcast and every message addressed to it, across projects. Keep the identity and session stable when resuming.

Send to `all` or an identity. Add `--reply-to UUID` for a reply. Use `--body-file` to read the message from a file. Git Bash's rewritten project paths and paths without the leading slash both work.

`read` prints messages and advances its cursor after delivery. `check` leaves the cursor alone. Both accept `--json` and `--state-dir`. State lives under `~/.logical-mail/state`. Removing it repeats messages and leaves the archive intact.

The first read covers today and yesterday. Resumes scan from the original start day, including late appends to older files. A malformed record stops a read without advancing its cursor.

Writes use the current blob SHA and retry conflicts after rereading. A lost response retries the same UUID. If delivery cannot be confirmed, the error supplies `--id` and `--timestamp` for a retry with the same body. Markdown, code and marker text are valid message bodies.

## Agent hooks

The hook reads mail at session start. Activity checks announce new mail at most once a minute without consuming it. If startup exceeds its deadline, the hook releases its lock and prints a manual read command.

Install the client under `~/.logical-mail/client`:

```sh
node install-client.mjs --home /path/to/profile --home-repo /path/to/home-repo
```

The installer writes compatibility wrappers under the home repo's `scripts/logical-mail/`. It migrates existing Agent Mail hook commands and removes retired Agent Mail MCP entries from supported configs. It preserves unrelated settings and backs up changed configs under `~/.logical-mail/backups`. Set `CLAUDE_CONFIG_DIR` if the active Claude Code config lives elsewhere.

A fresh installation needs hook registration. For Claude Code, merge these entries into your existing settings. Replace the command paths with the installed absolute path, and keep the connection environment settings available to the agent process.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/.logical-mail/client/hook.mjs start",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/.logical-mail/client/hook.mjs check",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Other agent runners can call the CLI directly. The hook expects JSON on stdin with `session_id` and `cwd`. It derives the working project from the git `upstream` or `origin` remote. Without that input or a recognized remote, it stays silent. Register activity hooks synchronously so their output reaches the session.

Ordinary sessions get a generated identity saved across resumes. For a named agent, set `LOGICAL_MAIL_IDENTITY` and `LOGICAL_MAIL_SESSION` in its environment. Explicit `--identity` and `--session` hook arguments override those settings.

## Development

```sh
npm test
```

Tests use local HTTP servers, temporary repositories and synthetic messages. The included CI workflow runs on Windows and Linux with Node 22 and 24. Daily files always use the Asia/Singapore timezone. The `mail/` archive is absent from this code release. Messages create daily files in your separate inbox repo.

## License

[MIT](LICENSE).
