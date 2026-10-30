// Validates registry/server.json against the vendored official MCP registry schema (draft-07).
// Usage: node scripts/validate-server-json.ts [path-to-server.json]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const addFormats = (() => {
  try {
    return require('ajv-formats');
  } catch {
    return null;
  }
})();

const schema = JSON.parse(readFileSync(new URL('../registry/server.schema.2025-12-11.json', import.meta.url), 'utf8'));
const target = process.argv[2] ?? new URL('../registry/server.json', import.meta.url);
const server = JSON.parse(readFileSync(target, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
if (addFormats) addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(server)) {
  console.log(`FAIL ${String(target)}`);
  console.log(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
console.log(`PASS ${String(target)} is valid against ${schema.$id}${addFormats ? '' : ' (formats not checked)'}`);
