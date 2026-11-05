/**
 * Stand-in for `@deepseek-ai/dsh-tools` used by the smoke test.
 *
 * The real package only exists inside the harness process; this stub keeps the
 * definition shape honest so the host module can be mounted and driven offline.
 */
export function defineTool(definition) {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) throw new TypeError('defineTool: name is required')
  if (typeof definition.execute !== 'function') throw new TypeError('defineTool: execute is required')
  if (definition.parameters === undefined || definition.parameters === null || typeof definition.parameters !== 'object') {
    throw new TypeError('defineTool: parameters is required')
  }
  if (definition.output === undefined || typeof definition.output.render !== 'function') throw new TypeError('defineTool: output.render is required')
  return definition
}
