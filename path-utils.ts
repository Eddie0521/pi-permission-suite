/**
 * Path utilities — ported from pi-permission-system
 *
 * Provides:
 * - Home directory expansion (~ / $HOME)
 * - Path normalization (relative → absolute, CWD-aware)
 * - Symlink resolution (canonical form)
 * - External directory detection (outside CWD)
 * - Path policy value generation (for pattern matching)
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute, resolve, normalize } from "node:path";

// ─── Home expansion ────────────────────────────────────────────────────

export function expandHome(pattern: string): string {
  if (pattern === "~" || pattern === "$HOME") return homedir();
  if (pattern.startsWith("~/") || pattern.startsWith("~\\"))
    return join(homedir(), pattern.slice(2));
  if (pattern.startsWith("$HOME/") || pattern.startsWith("$HOME\\"))
    return join(homedir(), pattern.slice(6));
  return pattern;
}

// ─── Path normalization ────────────────────────────────────────────────

/**
 * Normalize a path value: trim, strip wrapping quotes, expand ~, resolve
 * against cwd. Returns the normalized absolute path.
 */
export function normalizePath(pathValue: string, cwd: string): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return "";
  const expanded = expandHome(trimmed);
  return normalize(resolve(cwd, expanded));
}

// ─── Symlink resolution ────────────────────────────────────────────────

/**
 * Resolve symlinks in an absolute path, best-effort.
 * Returns the input unchanged when no ancestor resolves or on error.
 */
export function canonicalizePath(absolutePath: string): string {
  if (!absolutePath) return absolutePath;
  const parts = absolutePath.split("/").filter(Boolean);
  for (let i = parts.length; i >= 0; i--) {
    const candidate = "/" + parts.slice(0, i).join("/");
    try {
      const real = realpathSync(candidate);
      const tail = parts.slice(i);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolutePath;
    }
  }
  return absolutePath;
}

/**
 * Normalize + resolve symlinks.
 */
function canonicalNormalizePath(pathValue: string, cwd: string): string {
  const lexical = normalizePath(pathValue, cwd);
  if (!lexical) return "";
  return canonicalizePath(lexical);
}

// ─── Containment checks ───────────────────────────────────────────────

/**
 * Returns true when pathValue is directory itself or nested inside it.
 */
export function isPathWithinDirectory(pathValue: string, directory: string): boolean {
  if (!pathValue || !directory) return false;
  if (pathValue === directory) return true;
  const rel = relative(directory, pathValue);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

// ─── Path policy values ────────────────────────────────────────────────

/**
 * Return equivalent lookup values for path-policy matching:
 * - The normalized absolute path
 * - The project-relative form (if inside cwd)
 * - The literal expanded form
 */
export function getPathPolicyValues(pathValue: string, cwd: string): string[] {
  const literal = expandHome(pathValue.trim().replace(/^['"]|['"]$/g, ""));
  if (!literal) return [];
  if (literal === "*") return ["*"];

  const absolute = normalizePath(pathValue, cwd);
  const values = new Set<string>();
  if (absolute) {
    values.add(absolute);
    // Project-relative alias
    const normalizedCwd = normalizePath(cwd, cwd);
    if (normalizedCwd && isPathWithinDirectory(absolute, normalizedCwd)) {
      const rel = relative(normalizedCwd, absolute);
      if (rel) values.add(rel);
    }
  }
  values.add(literal);
  return [...values];
}

// ─── File tool helpers ─────────────────────────────────────────────────

export const READONLY_TOOLS = new Set(["read", "grep", "find", "ls", "set_approval_mode"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export function getToolPath(toolName: string, input: Record<string, unknown>): string | null {
  if (!PATH_TOOLS.has(toolName)) return null;
  const path = input.path;
  if (typeof path !== "string" || !path.trim()) return null;
  return path;
}
