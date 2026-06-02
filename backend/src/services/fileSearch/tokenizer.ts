// Deterministic query/identifier tokenization. Splits whitespace, camelCase,
// snake_case, kebab-case, and path separators into lowercased tokens.

export function tokenize(input: string): string[] {
  const tokens = new Set<string>();

  for (const raw of input.split(/[\s/\\.]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    tokens.add(trimmed.toLowerCase());

    for (const part of trimmed.split(/[_\-]+/)) {
      if (part) tokens.add(part.toLowerCase());
    }

    const camelSplit = trimmed
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/);
    for (const part of camelSplit) {
      if (part) tokens.add(part.toLowerCase());
    }
  }

  return [...tokens].filter((t) => t.length > 0);
}

// Tokens worth matching on (drops 1-2 char noise for overlap scoring).
export function meaningfulTokens(input: string): string[] {
  return tokenize(input).filter((t) => t.length >= 3);
}
