import type { Session, SnippetVariable } from "../types";

const VAR_REGEX = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;

const BUILTINS: Record<string, (session: Session) => string> = {
  HOST: (s) => s.hostConfig.host,
  USER: (s) => s.hostConfig.username,
  PORT: (s) => String(s.hostConfig.port),
  DATE: () => new Date().toISOString().slice(0, 10),
  TIMESTAMP: () => new Date().toISOString(),
};

export const BUILTIN_NAMES = Object.keys(BUILTINS);

export function extractVariables(command: string): string[] {
  const matches = [...command.matchAll(VAR_REGEX)];
  return [...new Set(matches.map((m) => m[1]))];
}

export function resolveCommand(
  command: string,
  userValues: Record<string, string>,
  session: Session | null,
): string {
  return command.replace(VAR_REGEX, (_match, name: string) => {
    if (name in BUILTINS && session) return BUILTINS[name](session);
    if (name in userValues) return userValues[name];
    return `{{${name}}}`;
  });
}

export function parseVariables(json: string | null): SnippetVariable[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as SnippetVariable[];
  } catch {
    return [];
  }
}

/** Returns the built-in value for a variable name given a session, or null if
 *  the name is not a built-in. */
export function resolveBuiltin(name: string, session: Session | null): string | null {
  if (!(name in BUILTINS)) return null;
  if (!session) return null;
  return BUILTINS[name](session);
}
