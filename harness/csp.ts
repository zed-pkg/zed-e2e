function splitCspDirectives(value: string): string[] {
  // Multiple Content-Security-Policy fields are serialized as a comma-separated
  // policy list, while directives inside one policy are semicolon-separated.
  // For this defense-in-depth predicate we only need the effective directives:
  // every policy in the list is enforced, so a bare sandbox in one policy or a
  // fleet constraint in another is still meaningful on the wire.
  return value
    .split(/[;,]/u)
    .map((directive) => directive.trim())
    .filter(Boolean);
}

export function artifactCspIsConstrained(value: string): boolean {
  const directives = splitCspDirectives(value);

  const sandboxed = directives.some((directive) => {
    if (!/^sandbox(?:\s|$)/iu.test(directive)) return false;
    // `allow-scripts` defeats the specific non-execution property this E2E
    // guard is meant to preserve. Other sandbox relaxations do not enable
    // script execution by themselves.
    return !/(?:^|\s)allow-scripts(?:\s|$)/iu.test(directive);
  });

  const hasDefaultPolicy = directives.some((directive) => /^default-src\s+/iu.test(directive));
  const blocksEmbedding = directives.some(
    (directive) => /^frame-ancestors\s+'none'\s*$/iu.test(directive),
  );

  return sandboxed || (hasDefaultPolicy && blocksEmbedding);
}
