// A blueprint as YAML text: what one made on the form is saved with as its source.

import { stringify } from 'yaml'
import type { Blueprint, Tool } from './core/domain/types'
import { shortRepo } from './github'

/** The tool names a YAML blueprint uses. */
const YAML_TOOLS: Record<Tool, string> = {
  readFile: 'read_file',
  writeFile: 'write_file',
  webSearch: 'web_search',
  runCommand: 'run_command',
}

export type BlueprintYaml = Pick<Blueprint, 'name' | 'prompt' | 'comment' | 'skills' | 'tools'>

/** What a blueprint made on the form is kept as: name, prompt, comment, skills (path or repo, ref, include, exclude), tools. */
export function blueprintToYaml({ name, prompt, comment, skills, tools }: BlueprintYaml) {
  return stringify({
    name,
    ...(prompt && { prompt }),
    ...(comment && { comment }),
    skills: skills.flatMap((p) => {
      if (!p.source) return []
      const where = p.source.kind === 'local'
        ? { path: p.source.path }
        : { repo: shortRepo(p.source.repo), ...(p.source.ref && { ref: p.source.ref }) }
      return [{ ...where, ...(p.include && { include: p.include }), ...(p.exclude.length > 0 && { exclude: p.exclude }) }]
    }),
    tools: tools.map((t) => YAML_TOOLS[t]),
  })
}
