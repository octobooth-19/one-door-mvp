import { AppError, isObject, requireThat } from './shared.mjs';

const keywords = new Set([
  '$schema', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'enum', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems',
]);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

// This intentionally bounded subset rejects unsupported schema keywords instead of ignoring them.
export function checkSchema(schema, depth = 0) {
  requireThat(isObject(schema) && depth <= 10, 'INVALID_SCHEMA', 'Unsupported schema structure.');
  for (const key of Object.keys(schema)) {
    requireThat(keywords.has(key), 'INVALID_SCHEMA', `Unsupported schema keyword: ${key}.`);
  }
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  requireThat(declared.length > 0 && declared.every(type => types.has(type)),
    'INVALID_SCHEMA', 'A supported explicit schema type is required.');
  if (declared.includes('object')) {
    requireThat(schema.additionalProperties !== undefined, 'INVALID_SCHEMA',
      'Object schemas must specify additionalProperties.');
    requireThat(!schema.properties || isObject(schema.properties),
      'INVALID_SCHEMA', 'Schema properties must be an object.');
    for (const child of Object.values(schema.properties ?? {})) checkSchema(child, depth + 1);
    if (isObject(schema.additionalProperties)) checkSchema(schema.additionalProperties, depth + 1);
    else requireThat(typeof schema.additionalProperties === 'boolean',
      'INVALID_SCHEMA', 'Invalid additionalProperties rule.');
    if (schema.required) {
      requireThat(Array.isArray(schema.required) &&
        schema.required.every(key => Object.hasOwn(schema.properties ?? {}, key)),
      'INVALID_SCHEMA', 'Required properties must be defined.');
    }
  }
  if (declared.includes('array')) checkSchema(schema.items, depth + 1);
  if (schema.pattern) {
    requireThat(typeof schema.pattern === 'string' && schema.pattern.length <= 160,
      'INVALID_SCHEMA', 'Schema pattern is too large.');
    try {
      new RegExp(schema.pattern, 'u');
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new AppError('INVALID_SCHEMA', 'Invalid schema pattern.');
    }
  }
}

function matches(type, value) {
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

export function validate(schema, value, path = 'input', depth = 0) {
  const fail = detail => {
    throw new AppError('INVALID_INPUT', `${path}: ${detail}`);
  };
  if (depth > 12) fail('nesting is too deep.');
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!declared.some(type => matches(type, value))) fail(`expected ${declared.join(' or ')}.`);
  if (schema.enum && !schema.enum.includes(value)) fail('value is not in the allowed set.');
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0)) fail('value is too short.');
    if (value.length > (schema.maxLength ?? 4096)) fail('value is too long.');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('invalid format.');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('value is below the minimum.');
    if (schema.maximum !== undefined && value > schema.maximum) fail('value is above the maximum.');
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) {
      fail('invalid number of items.');
    }
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, depth + 1));
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) fail(`missing ${required}.`);
    }
    if (Object.keys(value).length > 64) fail('too many properties.');
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('reserved property name.');
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        validate(schema.properties[key], child, `${path}.${key}`, depth + 1);
      } else if (isObject(schema.additionalProperties)) {
        validate(schema.additionalProperties, child, `${path}.${key}`, depth + 1);
      } else if (schema.additionalProperties === false) {
        fail(`unexpected property ${key}.`);
      }
    }
  }
  return value;
}

export const text = (maxLength = 200) => ({ type: 'string', maxLength });
export const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });

export const resultSchema = object({
  title: text(160),
  summary: text(2000),
  asOf: { ...text(40), pattern: '^\\d{4}-\\d{2}-\\d{2}T' },
  metrics: {
    type: 'array', maxItems: 4,
    items: object({
      label: text(80), value: text(100),
      tone: { type: 'string', enum: ['neutral', 'positive', 'warning'] },
    }),
  },
  columns: {
    type: 'array', maxItems: 8,
    items: object({
      key: { ...text(40), pattern: '^[a-zA-Z][a-zA-Z0-9]*$' },
      label: text(80),
      format: { type: 'string', enum: ['text', 'money', 'date', 'status'] },
    }),
  },
  rows: {
    type: 'array', maxItems: 10,
    items: { type: 'object', additionalProperties: { type: ['string', 'number'], maxLength: 300 } },
  },
  details: { type: 'array', maxItems: 8, items: object({ label: text(80), value: text(600) }) },
  suggestions: { type: 'array', maxItems: 3, items: text(200) },
  nextCursor: { type: ['string', 'null'], maxLength: 2048 },
});
