/**
 * Minimal Subprocess Runner for pi-permission-suite
 *
 * 自包含的 pi 子进程调用，不依赖外部 subagent 扩展
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SubprocessResult {
  success: boolean;
  output: string;
  error?: string;
}

// ─── 从 agent .md 文件读取配置 ─────────────────────────────────────

interface AgentConfig {
  model?: string;
  tools?: string[];
  systemPrompt: string;
}

export function loadAgent(name: string): AgentConfig | null {
  const userDir = join(process.env.HOME ?? "", ".pi", "agent", "agents");
  const filePath = join(userDir, `${name}.md`);

  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const get = (key: string) => match[1].match(new RegExp(`${key}:\\s*(.+)`))?.[1]?.trim();

    return {
      model: get("model"),
      tools: get("tools")?.split(",").map((t) => t.trim()).filter(Boolean),
      systemPrompt: match[2].trim(),
    };
  } catch {
    return null;
  }
}

// ─── 运行子进程 ────────────────────────────────────────────────────

export async function runSubprocess(
  prompt: string,
  options: {
    model?: string;
    systemPrompt?: string;
    timeout?: number;
  } = {},
): Promise<SubprocessResult> {
  const { model, systemPrompt, timeout = 15000 } = options;

  const args = ["--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  args.push(prompt);

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ success: false, output: "", error: `Timeout (${timeout}ms)` });
    }, timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: extractOutput(stdout) });
      } else {
        resolve({ success: false, output: stderr || stdout, error: `Exit ${code}` });
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ success: false, output: "", error: err.message });
    });
  });
}

// ─── 提取输出 ──────────────────────────────────────────────────────

function extractOutput(raw: string): string {
  const lines = raw.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "message_end" && e.message?.role === "assistant") {
        return e.message.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
      }
    } catch {}
  }
  return "";
}
