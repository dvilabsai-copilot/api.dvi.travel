import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeEmail,
  parseArgs,
  passwordFormat,
} from '../../scripts/migrate-legacy-users';

test('normalizes login emails the same way as AuthService', () => {
  assert.equal(normalizeEmail('  Legacy@Example.COM '), 'legacy@example.com');
  assert.equal(normalizeEmail(null), '');
});

test('recognizes supported and unsupported password formats', () => {
  assert.equal(passwordFormat('abcdef123' + 'a'.repeat(40)), 'legacy_php');
  assert.equal(passwordFormat('$2b$10$' + 'a'.repeat(53)), 'bcrypt');
  assert.equal(passwordFormat(''), 'empty');
  assert.equal(passwordFormat('not-a-supported-hash'), 'unknown');
});

test('defaults to a dry-run and requires an explicit target', () => {
  const args = parseArgs(['--target-db', 'dvi_staging']);
  assert.equal(args.apply, false);
  assert.equal(args.targetDatabase, 'dvi_staging');
  assert.equal(args.replaceMatchedPasswords, false);
});

test('parses explicit write options', () => {
  const args = parseArgs([
    '--target=dvi_main',
    '--apply',
    '--replace-matched-passwords',
    '--allow-unusable-passwords',
  ]);
  assert.deepEqual(args, {
    apply: true,
    targetDatabase: 'dvi_main',
    legacyPhpConfig: '',
    envFile: '',
    replaceMatchedPasswords: true,
    skipDuplicateSourceEmails: false,
    allowUnusablePasswords: true,
    help: false,
  });
});
