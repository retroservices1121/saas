/**
 * Field-name analysis, shared by the log redactor and the response scanner.
 *
 * Both need the same question answered — "is this key the name of a sensitive
 * field?" — and both got it wrong in the same way when they answered it with a
 * regex over the raw key. A pattern anchored on `_` boundaries misses `tinEnc`;
 * a bare substring match fires on `operatingStates`. Splitting the key into
 * words first makes both cases fall out correctly, and doing it in one place
 * means the two callers cannot drift apart.
 */

/**
 * Splits `tin_last4`, `tinLast4`, and `TINLast4` alike into `['tin','last4']`.
 *
 * The second replace handles a run of capitals followed by a word — `TINLast`
 * splits after `TIN`, not after `TI`.
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True if any word of `key` appears in `words`. */
export function keyMentions(key: string, words: ReadonlySet<string>): string | undefined {
  return keyWords(key).find((w) => words.has(w));
}
