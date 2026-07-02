/**
 * Wildcard pattern matcher — ported from pi-permission-system
 *
 * `*` matches any sequence of characters (including empty).
 * `?` matches exactly one character.
 * A pattern ending with " *" (space + wildcard) also matches the bare
 * command without arguments (e.g. "git *" matches both "git status" and "git").
 * Last-match-wins semantics.
 */

import { expandHome } from "./path-utils.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compilePattern(pattern: string): RegExp {
  let expanded = expandHome(pattern);
  let escaped = expanded
    .split("*")
    .map((part) => escapeRegExp(part).replaceAll("\\?", "."))
    .join(".*");
  // "git *" should match bare "git" too
  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }
  return new RegExp(`^${escaped}$`, "s");
}

/**
 * Find the last matching pattern in a record (last-match-wins).
 * Returns the matched value and pattern, or null if no match.
 */
export function findMatch<T>(
  patterns: Record<string, T>,
  value: string,
): { value: T; pattern: string } | null {
  const entries = Object.entries(patterns);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, state] = entries[i];
    if (compilePattern(pattern).test(value)) {
      return { value: state, pattern };
    }
  }
  return null;
}

/**
 * Simple wildcard match test.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  return compilePattern(pattern).test(value);
}
