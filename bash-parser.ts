/**
 * Bash parser — ported from pi-permission-system
 *
 * Uses tree-sitter-bash to parse shell commands into AST, then:
 * - Splits chain operators (&&, ||, ;, |, &) into sub-commands
 * - Extracts path-candidate tokens from each sub-command
 * - Handles command substitution $(...), subshells, and env-var prefixes
 * - Detects opaque wrappers (bash -c, eval) for fail-closed behavior
 *
 * Falls back to simple string splitting when tree-sitter is unavailable.
 */

import { createRequire } from "node:module";
import { expandHome } from "./path-utils.ts";

// ─── Minimal tree-sitter types ─────────────────────────────────────────

interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly childCount: number;
  readonly isNamed: boolean;
  child(index: number): TSNode | null;
}

interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

// ─── Parser singleton ──────────────────────────────────────────────────

let parserPromise: Promise<TSParser | null> | null = null;

async function initParser(): Promise<TSParser | null> {
  try {
    const { Parser, Language } = await import("web-tree-sitter");
    const req = createRequire(import.meta.url);
    const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
    await Parser.init({ locateFile: () => treeSitterWasm });

    const parser = new Parser();
    const bashWasm = req.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
    const bash = await Language.load(bashWasm);
    parser.setLanguage(bash);
    return parser;
  } catch {
    return null; // tree-sitter unavailable — will use fallback
  }
}

function getParser(): Promise<TSParser | null> {
  if (!parserPromise) {
    parserPromise = initParser().catch((err) => {
      parserPromise = null; // allow retry
      return null;
    });
  }
  return parserPromise;
}

// ─── Command types ─────────────────────────────────────────────────────

export interface BashCommand {
  /** The command text (stripped of env-var prefix) */
  readonly text: string;
  /** True if this is an opaque wrapper (bash -c, eval) — floor to ask */
  readonly opaque?: boolean;
  /** Execution context: substitution or subshell */
  readonly context?: "command_substitution" | "process_substitution" | "subshell";
}

// ─── AST constants ─────────────────────────────────────────────────────

const DESCEND_TYPES = new Set(["program", "list", "pipeline", "redirected_statement"]);
const SKIP_TYPES = new Set(["heredoc_body", "heredoc_end", "comment", "file_redirect", "heredoc_redirect"]);
const ARG_TYPES = new Set(["word", "concatenation", "string", "raw_string"]);
const NESTED_CONTEXTS = new Map<string, BashCommand["context"]>([
  ["command_substitution", "command_substitution"],
  ["process_substitution", "process_substitution"],
]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

// ─── AST helpers ───────────────────────────────────────────────────────

function resolveNodeText(node: TSNode): string {
  switch (node.type) {
    case "word":
      return node.text;
    case "raw_string": {
      const t = node.text;
      return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t;
    }
    case "string": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type === '"') continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    case "string_content":
    case "simple_expansion":
    case "expansion":
      return node.text;
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    default:
      return node.text;
  }
}

function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

function extractCommandName(node: TSNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "command_name") {
      const text = resolveNodeText(child);
      return text ? basename(text) : undefined;
    }
  }
  return undefined;
}

/** Strip leading variable_assignment prefix from command text */
function commandUnitText(node: TSNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && child.type !== "variable_assignment") {
      return node.text.slice(child.startIndex - node.startIndex);
    }
  }
  return node.text;
}

/** Check if command is an opaque wrapper (bash -c, eval) */
function isOpaqueWrapper(node: TSNode): boolean {
  let commandName: string | undefined;
  let sawFlagC = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed) continue;
    if (child.type === "variable_assignment") continue;
    if (commandName === undefined) {
      commandName = basename(child.text);
      continue;
    }
    const text = child.text;
    if (text === "--") break;
    if (text.startsWith("-") && !text.startsWith("--") && text.includes("c")) {
      sawFlagC = true;
    }
  }
  if (commandName === undefined) return false;
  if (commandName === "eval") return true;
  return SHELL_WRAPPERS.has(commandName) && sawFlagC;
}

// ─── Command enumeration ───────────────────────────────────────────────

function collectCommands(node: TSNode, context?: BashCommand["context"], out: BashCommand[] = []): BashCommand[] {
  if (!node.isNamed || SKIP_TYPES.has(node.type)) return out;

  if (node.type === "command") {
    const text = commandUnitText(node);
    const opaque = isOpaqueWrapper(node);
    out.push(context ? { text, context, opaque } : { text, opaque });
    // Also descend into substitutions within this command
    collectSubstitutionCommands(node, out);
    return out;
  }

  if (node.type === "subshell") {
    out.push({ text: node.text, context: "subshell" });
    descendChildren(node, "subshell", out);
    return out;
  }

  if (DESCEND_TYPES.has(node.type)) {
    descendChildren(node, context, out);
    return out;
  }

  // Other compound statements (if/while/for/case, { }) — emit whole
  out.push(context ? { text: node.text, context } : { text: node.text });
  return out;
}

function descendChildren(node: TSNode, context: BashCommand["context"], out: BashCommand[]) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectCommands(child, context, out);
  }
}

function collectSubstitutionCommands(node: TSNode, out: BashCommand[]) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const nestedContext = NESTED_CONTEXTS.get(child.type);
    if (nestedContext) {
      descendChildren(child, nestedContext, out);
    } else {
      collectSubstitutionCommands(child, out);
    }
  }
}

// ─── Path token extraction ─────────────────────────────────────────────

const PATTERN_FIRST_COMMANDS: Record<string, number> = {
  sed: 1, awk: 1, gawk: 1, nawk: 1,
  grep: 1, egrep: 1, fgrep: 1, rg: 1,
  sd: 2,
};

function collectPathTokens(node: TSNode): string[] {
  if (SKIP_TYPES.has(node.type)) return [];
  if (node.type === "command") return collectCommandPathTokens(node);
  if (node.type === "file_redirect") return collectRedirectTokens(node);

  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) tokens.push(...collectPathTokens(child));
  }
  return tokens;
}

function collectCommandPathTokens(node: TSNode): string[] {
  const cmdName = extractCommandName(node);
  const patternSkipCount = cmdName ? (PATTERN_FIRST_COMMANDS[cmdName] ?? 0) : 0;

  const tokens: string[] = [];
  let positionalsSeen = 0;
  let seenCommandName = false;
  let skipNext = false;
  let hasExplicitScript = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "variable_assignment") continue;

    if (child.type === "command_name") {
      seenCommandName = true;
      continue;
    }

    if (!seenCommandName && ARG_TYPES.has(child.type)) {
      seenCommandName = true;
      continue;
    }

    if (!ARG_TYPES.has(child.type)) {
      tokens.push(...collectPathTokens(child));
      continue;
    }

    const text = resolveNodeText(child);

    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Flag handling for pattern-first commands
    if (child.type === "word" && text.startsWith("-") && text.length > 1) {
      if (text === "--") { positionalsSeen = patternSkipCount; continue; }
      if (["-e", "-f", "-i"].includes(text)) { skipNext = true; hasExplicitScript = true; continue; }
      if (["-A", "-B", "-C", "-m", "-F", "-v", "-g", "-t", "-T", "-j", "-M", "-r", "-E", "-n"].includes(text)) {
        skipNext = true;
        continue;
      }
      continue;
    }

    // Skip inline patterns/scripts
    if (!hasExplicitScript && positionalsSeen < patternSkipCount) {
      positionalsSeen++;
      continue;
    }

    // Path candidate
    if (isPathCandidate(text)) {
      tokens.push(text);
    }
  }
  return tokens;
}

function collectRedirectTokens(node: TSNode): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && ARG_TYPES.has(child.type)) {
      tokens.push(resolveNodeText(child));
    }
  }
  return tokens;
}

function isPathCandidate(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("-")) return false;
  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false; // URL
  if (token.startsWith("@") && !token.startsWith("@/")) return false; // npm scope
  if (/^\/+$/.test(token)) return false; // bare slash
  return (
    token.startsWith("/") ||
    token.startsWith("~/") ||
    token.startsWith(".") ||
    token.includes("/") ||
    token.includes("..") ||
    /^[a-zA-Z]:[/\\]/.test(token) // Windows drive letter
  );
}

// ─── Public API ────────────────────────────────────────────────────────

export interface ParseResult {
  /** Individual sub-commands in source order */
  commands: BashCommand[];
  /** Path tokens extracted from the command */
  pathTokens: string[];
}

/**
 * Parse a bash command using tree-sitter, falling back to simple splitting.
 */
export async function parseBashCommand(command: string): Promise<ParseResult> {
  const parser = await getParser();

  if (!parser) {
    return fallbackParse(command);
  }

  const tree = parser.parse(command);
  if (!tree) return fallbackParse(command);

  try {
    const commands = collectCommands(tree.rootNode);
    const pathTokens = collectPathTokens(tree.rootNode);
    return { commands, pathTokens };
  } finally {
    tree.delete();
  }
}

/**
 * Fallback parser when tree-sitter is unavailable.
 * Splits on chain operators and does basic path extraction.
 */
function fallbackParse(command: string): ParseResult {
  // Split on &&, ||, ;, | (but not inside quotes)
  const parts = splitOnChainOperators(command);
  const commands: BashCommand[] = parts.map((text) => {
    const stripped = stripEnvPrefix(text.trim());
    const opaque = /^(bash|sh|dash|zsh|ksh)\b.*\s-c\b/.test(stripped) || /^eval\b/.test(stripped);
    return { text: stripped, opaque: opaque || undefined };
  });

  // Simple path token extraction from the full command
  const pathTokens = extractSimplePathTokens(command);

  return { commands, pathTokens };
}

function splitOnChainOperators(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\") { current += ch; escaped = true; continue; }
    if (ch === "'" && !inDouble) { current += ch; inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { current += ch; inDouble = !inDouble; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    // Chain operators
    if (ch === "&" && cmd[i + 1] === "&") {
      if (current.trim()) parts.push(current.trim());
      current = ""; i++; continue;
    }
    if (ch === "|" && cmd[i + 1] === "|") {
      if (current.trim()) parts.push(current.trim());
      current = ""; i++; continue;
    }
    if (ch === ";" || ch === "|") {
      if (current.trim()) parts.push(current.trim());
      current = ""; continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [cmd];
}

function stripEnvPrefix(cmd: string): string {
  // Strip leading FOO=bar FOO2=baz ...
  return cmd.replace(/^(\w+=\S+\s+)+/, "");
}

function extractSimplePathTokens(cmd: string): string[] {
  const tokens: string[] = [];
  // Match quoted and unquoted path-like tokens
  const regex = /(?:^|\s)((?:[~/.]|[a-zA-Z]:)[^\s'"|&;<>]*)/g;
  let match;
  while ((match = regex.exec(cmd)) !== null) {
    const token = match[1].replace(/^['"]|['"]$/g, "");
    if (isPathCandidate(token)) {
      tokens.push(expandHome(token));
    }
  }
  return tokens;
}
