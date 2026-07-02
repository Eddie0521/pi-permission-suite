<p align="right">
  <a href="README.md">🇬🇧 English</a>
</p>

# Pi Permission Suite

> 四种审批模式 + 指令级安全限制的 Pi 扩展。

为 Pi coding agent 提供 **Act / Auto / Ask / Plan** 四种权限模式、命令和路径规则引擎、以及 subagent 自动审批。基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system) 增强改造。

## 安装

```bash
pi install npm:pi-permission-suite
```

安装后重启 pi，你会获得：
- `/approval-mode` 命令切换四种模式
- `set_approval_mode` 工具（agent 可调用）
- `Ctrl+Q` 快捷键循环切换模式
- 规则引擎自动拦截危险命令
- Subagent 自动审批复杂工具调用

## 模式

| 模式 | 图标 | 快捷键 | 说明 |
|------|------|--------|------|
| Act | ⚡ | Ctrl+Q | 完全权限（默认） |
| Auto | 🤖 | Ctrl+Q | subagent 审批不确定的调用 |
| Ask | ❓ | Ctrl+Q | 只读问答，写工具禁用 |
| Plan | 📋 | Ctrl+Q | 只读计划，写工具禁用 |

## 命令

```bash
/approval-mode [ask|auto|act|plan]  # 切换模式
/approval-status                    # 查看状态
```

## 工具（agent 可调用）

```typescript
// agent 可以通过调用此工具自动切换模式
set_approval_mode({ mode: "plan" })  // 切换到只读计划模式
set_approval_mode({ mode: "act" })   // 切换到完全权限模式
```

## 规则引擎

### 评估优先级

```
deny 规则（硬阻断，任何模式不可覆盖）
  ↓ 未命中
allow 规则（自动放行，跳过模式检查）
  ↓ 未命中
session always rules（交互式临时规则）
  ↓ 未命中
模式层决策（ask/plan 阻断写操作，act 放行，auto 走 AI 审查）
```

### Deny 规则（所有模式生效）

**bash 命令：**
- tree-sitter 解析链式命令（`&&`、`||`、`;`、`|`）
- 识别命令替换 `$(...)` 和子 shell
- 通配符匹配：`"sudo *": "禁止 sudo"`
- 硬编码灾难命令兜底：`rm -rf /`、`fork bomb`、`curl|bash`

**文件路径（跨工具）：**
- `read`/`write`/`edit`/`bash` 都受 path 规则约束
- symlink 解析防绕过
- 通配符匹配：`"*.env": "禁止访问环境变量文件"`

### Allow 规则

| 类别 | 命令 |
|------|------|
| 文件查看 | `cat`, `head`, `tail`, `less`, `more`, `wc`, `file`, `stat` |
| 目录/搜索 | `ls`, `tree`, `find`, `grep`, `rg` |
| Git | `status`, `log`, `diff`, `show`, `branch`, `tag`, `remote`, `describe`, `blame`, `reflog` |
| 系统状态 | `ps`, `top`, `df`, `du`, `free`, `uptime`, `uname`, `id`, `whoami` |
| 包管理 | `npm list/info/view`, `pip list/show`, `cargo tree`, `go list` |
| Docker | `docker ps/images/logs/inspect/version` |
| 压缩文件 | `zcat`, `zgrep`, `unzip -l`, `tar -t` |
| 文本处理 | `awk`, `sed`, `jq`, `sort`, `uniq`, `cut`, `tr`, `diff` |
| 网络 | `curl`, `wget`, `ping`, `dig`, `traceroute`, `whois`, `netstat` |

## 配置

默认规则在 `config.default.json` 中。

用户自定义配置在 `~/.pi/extensions/pi-permission-suite/config.json`。首次加载时自动从默认文件创建。

```jsonc
{
  // bash 命令规则
  "bash": {
    "deny": {
      "rm -rf /": "禁止删除根目录",
      "sudo *": "禁止 sudo",
      "curl * | bash": "禁止远程代码执行"
    },
    "allow": {
      "bun test": true,
      "bun run *": true,
      "git status": true,
      "git diff": true,
      "cat *": true
    }
  },
  // 跨工具文件路径规则
  "path": {
    "deny": {
      "*.env": "禁止访问环境变量文件",
      "~/.ssh/*": "禁止访问 SSH 密钥"
    },
    "allow": {
      "*.env.example": true
    }
  },
  // CWD 外路径策略："mode" | "deny" | "allow"
  "external_directory": "mode"
}
```

### 配置语义

- `deny` 下的规则 → 硬阻断，任何 Mode 都不能覆盖（包括 `act`）
- `allow` 下的规则 → 自动放行，不经过 Mode 层
- 都不命中 → 交给 Mode 层决策
- `external_directory`: `"mode"` = 未命中规则时走 Mode 层；`"deny"` = 硬阻断；`"allow"` = 放行

## 项目结构

```
pi-permission-suite/
├── index.ts              # 主逻辑
├── types.ts              # 公共类型
├── rules.ts              # 规则引擎
├── approver.ts           # 审批器
├── subprocess-runner.ts  # 子进程调用
├── bash-parser.ts        # tree-sitter bash 解析
├── wildcard-matcher.ts   # 通配符匹配
├── path-utils.ts         # 路径工具
├── config-loader.ts      # 配置加载
├── config.default.json   # 默认规则
├── README.md             # 英文版
└── README-zh.md          # 本文件（中文版）
```

## License

MIT — 基于 [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system)（MIT）。
