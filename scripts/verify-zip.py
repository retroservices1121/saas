"""
Reads an archive back with an independent AES-ZIP implementation.

lib/zip.ts implements the WinZip AE-2 format by hand, and the unit tests in
tests/zip.test.ts can only check that the bytes are shaped correctly — a
round-trip through our own decryptor would pass just as happily if the counter
were incremented the wrong way, because it would be incremented the wrong way in
both directions.

This reads it with pyzipper instead, which has no shared code with ours. If this
passes, 7-Zip and WinZip will open the archive too.

    pip install pyzipper
    pnpm zip:verify
"""

import subprocess
import sys
import tempfile
import os

try:
    import pyzipper
except ImportError:
    sys.exit("pyzipper is not installed. Run: pip install pyzipper")

BUILDER = r"""
import { writeFileSync } from 'node:fs';
import { createEncryptedZip, generateArchivePassword, toCsv } from './lib/zip';

const password = generateArchivePassword();
const csv = toCsv([
  { name: 'Ada Lovelace', tin: '123456789', note: 'has, a comma and "quotes"' },
  { name: '=cmd|calc', tin: '000123456789', note: 'formula injection attempt' },
]);

const zip = createEncryptedZip(
  [
    { name: 'workers.csv', data: Buffer.from(csv, 'utf8') },
    // Multi-block, to catch a counter incremented the wrong way.
    { name: 'documents/peña-check.txt', data: Buffer.from('x'.repeat(5000) + 'TAIL') },
    { name: 'empty.txt', data: Buffer.from('') },
    // Incompressible, so the store path is exercised as well as deflate.
    { name: 'random.bin', data: Buffer.from(require('node:crypto').randomBytes(3000)) },
  ],
  password,
  new Date('2026-08-17T10:30:00Z'),
);

writeFileSync(process.argv[2], zip);
console.log(password);
"""


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    builder = os.path.join(root, 'verify-zip-build.tmp.ts')
    archive = os.path.join(tempfile.gettempdir(), 'onboarding-verify.zip')

    with open(builder, 'w', encoding='utf-8') as handle:
        handle.write(BUILDER)

    try:
        result = subprocess.run(
            ['npx', 'tsx', builder, archive],
            cwd=root, capture_output=True, text=True, shell=(os.name == 'nt'),
        )
        if result.returncode != 0:
            sys.exit(f"could not build the archive:\n{result.stderr}")
        password = result.stdout.strip().splitlines()[-1].encode()
    finally:
        if os.path.exists(builder):
            os.remove(builder)

    failures = []

    with pyzipper.AESZipFile(archive) as zf:
        zf.setpassword(password)
        names = zf.namelist()

        expected = ['workers.csv', 'documents/peña-check.txt', 'empty.txt', 'random.bin']
        if names != expected:
            failures.append(f"entry names: expected {expected}, got {names}")

        csv = zf.read('workers.csv').decode('utf-8')
        if 'Ada Lovelace' not in csv:
            failures.append('workers.csv did not decrypt to the expected content')
        if "'=cmd|calc" not in csv:
            failures.append('formula injection was not neutralised')

        big = zf.read('documents/peña-check.txt').decode()
        if len(big) != 5004 or not big.endswith('TAIL'):
            failures.append(f'multi-block file decrypted wrong (len {len(big)})')

        if zf.read('empty.txt') != b'':
            failures.append('empty file did not round-trip')

        if len(zf.read('random.bin')) != 3000:
            failures.append('stored (incompressible) entry did not round-trip')

    with pyzipper.AESZipFile(archive) as zf:
        zf.setpassword(b'definitely-not-the-password')
        try:
            zf.read('workers.csv')
            failures.append('SECURITY: the wrong password was accepted')
        except Exception:
            pass

    os.remove(archive)

    if failures:
        for failure in failures:
            print('  FAIL', failure)
        sys.exit(1)

    print('  AES-256 archive verified against pyzipper:')
    print('    entry names, UTF-8 paths, multi-block CTR, empty and stored entries,')
    print('    and a wrong password is rejected.')


if __name__ == '__main__':
    main()
