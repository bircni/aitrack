import type { Command } from 'commander';

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

interface Node {
  name: string;
  description: string;
  flags: string[];
  children: Node[];
}

function collect(command: Command): Node {
  return {
    name: command.name(),
    description: command.description(),
    flags: [...command.options.flatMap((option) => [option.long, option.short]), '--help'].filter(
      (flag): flag is string => flag !== undefined,
    ),
    children: command.commands.map(collect),
  };
}

/** Path of the node as a shell-safe function/case key, e.g. `usage today` -> `usage_today`. */
const key = (path: string[]): string => path.join('_').replaceAll('-', '_');

function flatten(node: Node, path: string[] = []): Array<{ path: string[]; node: Node }> {
  return [
    { path, node },
    ...node.children.flatMap((child) => flatten(child, [...path, child.name])),
  ];
}

function words(node: Node): string {
  return [...node.children.map((child) => child.name), ...node.flags].join(' ');
}

/** Shared by bash and zsh: `path` ends up as the key of the deepest subcommand already typed. */
function walker(root: Node, wordList: string, lastWord: string): string {
  const known = flatten(root)
    .filter(({ path }) => path.length > 0)
    .map(({ path }) => key(path))
    .join(' ');
  return `  local path="" word next
  for word in ${wordList}; do
    [[ "$word" == -* ]] && continue
    next="\${path:+\${path}_}\${word//-/_}"
    case " ${known} " in *" $next "*) path="$next" ;; esac
  done
  : "${lastWord}"`;
}

function optionCases(root: Node): string {
  return flatten(root)
    .map(({ path, node }) => `    "${key(path)}") opts="${words(node)}" ;;`)
    .join('\n');
}

function bash(root: Node): string {
  return `# bash completion for aitrack
_aitrack() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" opts
${walker(root, '"${COMP_WORDS[@]:1:COMP_CWORD-1}"', '')}
  case "$path" in
${optionCases(root)}
  esac
  COMPREPLY=($(compgen -W "$opts" -- "$cur"))
}
complete -F _aitrack aitrack
`;
}

function zsh(root: Node): string {
  return `#compdef aitrack
# zsh completion for aitrack
_aitrack() {
  local opts
${walker(root, '"${(@)words[2,CURRENT-1]}"', '')}
  case "$path" in
${optionCases(root)}
  esac
  compadd -- \${=opts}
}
compdef _aitrack aitrack
`;
}

const quote = (text: string): string => `'${text.replaceAll("'", String.raw`\'`)}'`;

function fish(root: Node): string {
  const lines = ['# fish completion for aitrack'];
  for (const { path, node } of flatten(root)) {
    // Without a subcommand typed yet the condition is the bare "no subcommand" test.
    const condition =
      path.length === 0
        ? '__fish_use_subcommand'
        : `__fish_seen_subcommand_from ${path.at(-1) ?? ''}`;
    for (const child of node.children) {
      lines.push(
        `complete -c aitrack -f -n ${quote(condition)} -a ${quote(child.name)} -d ${quote(child.description)}`,
      );
    }
    for (const flag of node.flags) {
      if (!flag.startsWith('--')) continue;
      lines.push(`complete -c aitrack -n ${quote(condition)} -l ${flag.slice(2)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const GENERATORS: Record<CompletionShell, (root: Node) => string> = { bash, zsh, fish };

export function completionScript(program: Command, shell: CompletionShell): string {
  return GENERATORS[shell](collect(program));
}
