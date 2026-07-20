/**
 * openapi-validate.ts
 *
 * Utilities for fetching and structurally validating the AI service OpenAPI
 * document.  Used by:
 *   - app/backend/test/contract/ai-service.contract.spec.ts
 *   - directly as a CLI:
 *       AI_SERVICE_URL=http://localhost:8000 \
 *         ts-node --transpile-only scripts/openapi-validate.ts
 */

import * as http from 'http';
import * as https from 'https';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, SchemaObject> };
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  tags?: string[];
  requestBody?: { required?: boolean; content: Record<string, MediaTypeObject> };
  responses: Record<string, ResponseObject>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
}

export interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  enum?: unknown[];
  items?: SchemaObject;
  $ref?: string;
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  nullable?: boolean;
  default?: unknown;
  description?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchOpenApiSpec(
  baseUrl: string,
  specPath = '/openapi.json',
): Promise<OpenApiDocument> {
  const url = `${baseUrl}${specPath}`;
  const client = url.startsWith('https') ? https : http;

  return new Promise<OpenApiDocument>((resolve, reject) => {
    const req = client.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} from ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as OpenApiDocument);
        } catch (e) {
          reject(new Error(`JSON parse error from ${url}: ${String(e)}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Network error fetching ${url}: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

export function resolveRef(doc: OpenApiDocument, ref: string): SchemaObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: unknown = doc;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[p];
  }
  return node as SchemaObject | undefined;
}

export function getResponseSchema(
  doc: OpenApiDocument,
  urlPath: string,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  status: string,
): SchemaObject | undefined {
  const op = doc.paths[urlPath]?.[method];
  if (!op) return undefined;
  const schema = op.responses[status]?.content?.['application/json']?.schema;
  if (!schema) return undefined;
  return schema.$ref ? resolveRef(doc, schema.$ref) : schema;
}

export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: SchemaObject,
  doc: OpenApiDocument,
  atPath = '$',
): ValidationResult {
  const errors: string[] = [];

  let s = schema;
  if (s.$ref) {
    const resolved = resolveRef(doc, s.$ref);
    if (!resolved) {
      return { valid: false, errors: [`${atPath}: cannot resolve $ref "${s.$ref}"`] };
    }
    s = resolved;
  }

  // Required fields
  for (const key of s.required ?? []) {
    if (!(key in value)) errors.push(`${atPath}: missing required field "${key}"`);
  }

  // Per-property type + enum check
  for (const [key, propRaw] of Object.entries(s.properties ?? {})) {
    if (!(key in value)) continue;
    const fieldVal = value[key];
    const prop = propRaw.$ref ? (resolveRef(doc, propRaw.$ref) ?? propRaw) : propRaw;
    const fp = `${atPath}.${key}`;

    if (prop.type && fieldVal !== null && fieldVal !== undefined) {
      const got = Array.isArray(fieldVal) ? 'array' : typeof fieldVal;
      const want = prop.type;
      // integer is a subtype of number in JSON
      if (!(want === 'integer' && got === 'number') && want !== got) {
        errors.push(`${fp}: expected type "${want}", got "${got}"`);
      }
    }

    if (prop.enum != null && fieldVal !== null && fieldVal !== undefined) {
      if (!prop.enum.includes(fieldVal)) {
        errors.push(
          `${fp}: "${String(fieldVal)}" not in enum [${prop.enum.map(String).join(', ')}]`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const base = process.env['AI_SERVICE_URL'] ?? 'http://localhost:8000';
  console.log(`Fetching spec from ${base}/openapi.json …`);

  let doc: OpenApiDocument | undefined;
  try {
    doc = await fetchOpenApiSpec(base);
  } catch (e) {
    console.error(`❌  ${String(e)}`);
    process.exit(1);
  }

  if (!doc) { process.exit(1); }

  console.log(`✅  ${doc.info.title} v${doc.info.version}`);
  console.log(`    paths: ${Object.keys(doc.paths).length}`);
  console.log(`    schemas: ${Object.keys(doc.components?.schemas ?? {}).length}`);

  const required = [
    '/v1/ai/humanitarian/verify',
    '/v1/ai/anonymize',
    '/v1/ai/proof-of-life',
    '/v1/fraud/detect',
  ];
  const missing = required.filter((p) => !doc.paths[p]);
  if (missing.length) {
    console.error(`❌  Missing paths:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log('✅  All required v1 paths present');
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
