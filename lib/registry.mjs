import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, freeze, isObject, requireThat } from './shared.mjs';
import { checkSchema, validate } from './schema.mjs';

export async function loadRegistry(directory) {
  const schema = JSON.parse(await readFile(join(directory, 'connector.schema.json'), 'utf8'));
  checkSchema(schema);
  const policy = JSON.parse(await readFile(join(directory, 'platform-policy.json'), 'utf8'));
  requireThat(policy.version === 1 && isObject(policy.connectors),
    'INVALID_POLICY', 'Platform policy version 1 is required.');
  const files = (await readdir(join(directory, 'connectors')))
    .filter(name => name.endsWith('.json')).sort();
  requireThat(files.length > 0 && files.length <= 20, 'INVALID_REGISTRY',
    'The registry must contain between one and twenty connectors.');
  const connectors = [];
  const ids = new Set();
  const toolNames = new Set();
  for (const file of files) {
    const manifest = JSON.parse(await readFile(join(directory, 'connectors', file), 'utf8'));
    validate(schema, manifest, `manifest ${file}`);
    requireThat(!ids.has(manifest.id), 'INVALID_REGISTRY', 'Connector IDs must be unique.');
    ids.add(manifest.id);
    const approved = policy.connectors[manifest.id];
    requireThat(approved?.audience === manifest.auth.audience && isObject(approved.tools),
      'POLICY_DENIED', `Connector ${manifest.id} has no matching platform approval.`);
    for (const tool of manifest.tools) {
      const rule = approved.tools[tool.name];
      requireThat(tool.name.startsWith(`${manifest.id}_`) && !toolNames.has(tool.name),
        'INVALID_REGISTRY', 'Tool names must be unique and namespaced by connector.');
      toolNames.add(tool.name);
      requireThat(rule?.risk === 'read' && rule.scope === tool.scope && tool.risk === 'read',
        'POLICY_DENIED', `Tool ${tool.name} is not approved as read-only.`);
    }
    connectors.push(manifest);
  }
  const snapshot = freeze({ connectors, policy, digest: digest({ connectors, policy }) });
  return {
    ...snapshot,
    visible(principal) {
      return connectors.filter(connector => connector.lifecycle === 'active' &&
        connector.tools.some(tool => principal.scopes.includes(tool.scope)));
    },
    get(id) {
      return connectors.find(connector => connector.id === id && connector.lifecycle === 'active');
    },
  };
}

export function publicConnector(connector, principal) {
  return {
    id: connector.id, version: connector.version, ...connector.display,
    protocolVersion: connector.endpoint.protocolVersion,
    tools: connector.tools.filter(tool => principal.scopes.includes(tool.scope))
      .map(tool => ({ name: tool.name, risk: tool.risk, pin: tool.pin })),
  };
}
