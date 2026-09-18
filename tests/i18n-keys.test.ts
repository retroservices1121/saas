import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every message key the code names must exist in both languages.
 *
 * next-intl does not throw on a missing key in production; it renders the key.
 * So a missing `form.routing.label` reaches a worker's screen as the literal
 * text "form.routing.label", in a form that asks for their bank account — which
 * is exactly where a page that looks broken makes someone stop and phone their
 * employer. This catches it on the developer's machine instead.
 *
 * Only static keys are checked. A template key (`t(\`audit.${row.action}\`)`)
 * is covered by the enum it is built from, and the enum tests.
 */

type Messages = Record<string, unknown>;

const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Messages;
const es = JSON.parse(readFileSync('messages/es.json', 'utf8')) as Messages;

function lookup(messages: Messages, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    );
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!/node_modules|\.next/.test(path)) sourceFiles(path, out);
    } else if (/\.(ts|tsx|mts)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Keys returned from actions and validators as bare string literals. */
const RETURNED_KEY_NAMESPACES =
  /'((?:validation|auth\.errors|firm\.errors|company\.errors|platform\.errors|form\.errors)\.[a-zA-Z0-9_.]+)'/g;

function keysIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const keys: string[] = [];

  // A component that scopes its hook — useTranslations('app') — calls t()
  // with keys relative to that namespace.
  const namespaces = [...src.matchAll(/(?:getTranslations|useTranslations)\(\s*'([^']+)'\s*\)/g)].map(
    (m) => m[1]!,
  );
  const prefix = namespaces.length === 1 ? `${namespaces[0]}.` : '';

  for (const m of src.matchAll(/\bt\(\s*'([^'`$]+)'/g)) keys.push(prefix + m[1]!);
  for (const m of src.matchAll(RETURNED_KEY_NAMESPACES)) keys.push(m[1]!);
  return keys;
}

describe('message keys', () => {
  const files = [...sourceFiles('app'), ...sourceFiles('lib')];

  it('every static key named in app/ and lib/ exists in en and es', () => {
    const missing: string[] = [];
    for (const file of files) {
      for (const key of keysIn(file)) {
        const inEn = lookup(en, key) !== undefined;
        const inEs = lookup(es, key) !== undefined;
        if (!inEn || !inEs) {
          missing.push(`${key}  (${file})${inEn ? '' : ' [en]'}${inEs ? '' : ' [es]'}`);
        }
      }
    }
    expect(missing, `missing message keys:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('en and es define the same keys', () => {
    const flatten = (node: unknown, path = ''): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Messages).flatMap(([k, v]) => flatten(v, path ? `${path}.${k}` : k))
        : [path];
    // `_translation` is a note block for translators, not messages.
    const messagesOnly = (m: Messages) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== '_translation'));
    const enKeys = new Set(flatten(messagesOnly(en)));
    const esKeys = new Set(flatten(messagesOnly(es)));
    const onlyEn = [...enKeys].filter((k) => !esKeys.has(k));
    const onlyEs = [...esKeys].filter((k) => !enKeys.has(k));
    expect({ onlyEn, onlyEs }).toEqual({ onlyEn: [], onlyEs: [] });
  });
});
