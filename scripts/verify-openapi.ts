// Verifies the published OpenAPI document against a running deployment:
// every documented operation exists (no 404/405) and every $ref resolves.
// Usage: BASE_URL=http://localhost:8787 node scripts/verify-openapi.ts
const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const doc: any = await (await fetch(`${BASE}/openapi.json`)).json();
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`FAIL  ${msg}`);
};

if (doc.openapi !== '3.1.0') fail(`openapi version is ${doc.openapi}`);
if (doc.servers?.[0]?.url !== BASE) console.log(`NOTE  servers[0].url=${doc.servers?.[0]?.url} (BASE_URL=${BASE})`);
for (const ref of JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? []) {
  if (!doc.components.schemas[ref.split('/').pop()!]) fail(`unresolved ${ref}`);
}
const sampleId = 'conv_AAAAAAAAAAAAAAAAAAAAAA';
for (const [path, item] of Object.entries<any>(doc.paths)) {
  for (const method of ['get', 'post']) {
    if (!item[method]) continue;
    const url = `${BASE}${path.replace('{conversation_id}', sampleId)}`;
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: method === 'post' ? { 'content-type': 'application/json' } : {},
      body: method === 'post' ? '{}' : undefined,
    });
    const ok = res.status !== 404 && res.status !== 405;
    if (!ok) fail(`${method.toUpperCase()} ${path} -> ${res.status}`);
    else console.log(`PASS  ${method.toUpperCase()} ${path} -> ${res.status}`);
  }
}
if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('OpenAPI document verified.');
