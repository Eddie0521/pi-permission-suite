<p align="right">
  <a href="README-zh.md">🇨🇳 中文</a>
</p>

# Pi Permission Suite

> Four approval modes + command-level security restrictions for the Pi coding agent.

A Pi extension that provides **Act / Auto / Ask / Plan** permission modes, a rule engine for command and path protection, and a subagent-based auto-approver. Enhanced fork of [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system).

## Install

```bash
pi install npm:pi-permission-suite
```

Once installed and pi restarted, you get:
- `/approval-mode` command to switch between four modes
- `set_approval_mode` tool (callable by the agent itself)
- `Ctrl+Q` keyboard shortcut to cycle modes
- A rule engine that blocks dangerous commands across all modes
- Subagent auto-approval for complex tool calls

## Modes

| Mode | Icon | Shortcut | Description |
|------|------|----------|-------------|
| Act | ⚡ | Ctrl+Q | Full permissions (default) |
| Auto | 🤖 | Ctrl+Q | Subagent approval for uncertain calls |
| Ask | ❓ | Ctrl+Q | Read-only Q&A — write tools disabled |
| Plan | 📋 | Ctrl+Q | Read-only planning — write tools disabled |

## Commands

```bash
/approval-mode [ask|auto|act|plan]  # Switch mode
/approval-status                    # View current status
```

## Tool (agent-callable)

```typescript
// Agent can switch modes on its own
set_approval_mode({ mode: "plan" })  // Switch to read-only plan mode
set_approval_mode({ mode: "act" })   // Switch to full permission mode
```

## Rule Engine

### Evaluation Order

```
deny rules (hard block, overrides all modes)
  ↓ no match
allow rules (auto-approve, skips mode check)
  ↓ no match
session always rules (interactive temporary rules)
  ↓ no match
Mode-layer decision (ask/plan block writes, act passes, auto delegates to AI)
```

### Deny Rules (applied in all modes)

**bash commands:**
- tree-sitter parses chained commands (`&&`, `||`, `;`, `|`)
- Detects command substitution `$(...)` and subshells
- Wildcard matching: `"sudo *": "sudo blocked"`
- Hardcoded disaster command fallback: `rm -rf /`, fork bombs, `curl|bash`

**File paths (cross-tool):**
- `read`/`write`/`edit`/`bash` all subject to path rules
- Symlink resolution to prevent bypass
- Wildcard matching: `"*.env": "env files blocked"`

### Allow Rules

| Category | Commands |
|----------|----------|
| File viewing | `cat`, `head`, `tail`, `less`, `more`, `wc`, `file`, `stat` |
| Directory/search | `ls`, `tree`, `find`, `grep`, `rg` |
| Git | `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `describe`, `blame`, `reflog` |
| System status | `ps`, `top`, `df`, `du`, `free`, `uptime`, `uname`, `id`, `whoami` |
| Package mgmt | `npm list/info/view`, `pip list/show`, `cargo tree`, `go list` |
| Docker | `docker ps/images/logs/inspect/version` |
| Archives | `zcat`, `zgrep`, `unzip -l`, `tar -t` |
| Text processing | `awk`, `sed`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff` |
| Network | `curl`, `wget`, `ping`, `dig`, `traceroute`, `whois`, `netstat` |

## Configuration

Default rules ship in `config.default.json`.

User config lives at `~/.pi/extensions/pi-permission-suite/config.json`. Created automatically on first load from the default.

```jsonc
{
  // bash command rules
  "bash": {
    "deny": {
      "rm -rf /": "prevent root deletion",
      "sudo *": "block sudo",
      "curl * | bash": "block remote code execution"
    },
    "allow": {
      "bun test": true,
      "bun run *": true,
      "git status": true,
      "git diff": true,
      "cat *": true
    }
  },
  // cross-tool file path rules
  "path": {
    "deny": {
      "*.env": "block env file access",
      "~/.ssh/*": "block SSH key access"
    },
    "allow": {
      "*.env.example": true
    }
  },
  // CWD-external path strategy: "mode" | "deny" | "allow"
  "external_directory": "mode"
}
```

### Config Semantics

- `deny` entries → hard block, no mode can override (including `act`)
- `allow` entries → auto-approve, skip the mode layer
- Neither matches → delegate to mode layer
- `external_directory`: `"mode"` = fall through to mode; `"deny"` = hard block; `"allow"` = approve

## Project Structure

```
pi-permission-suite/
├── index.ts              # Main extension entry
├── types.ts              # Shared types
├── rules.ts              # Rule engine
├── approver.ts           # Auto-approver
├── subprocess-runner.ts  # Subprocess runner
├── bash-parser.ts        # tree-sitter bash parser
├── wildcard-matcher.ts   # Glob matching
├── path-utils.ts         # Path utilities
├── config-loader.ts      # Config loader
├── config.default.json   # Default rules
└── README.md             # This file (English)
└── README-zh.md          # Chinese translation
```

## License

MIT — based on [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) (MIT).
