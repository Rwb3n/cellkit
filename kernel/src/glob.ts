// Globs for repo paths (cell audit's --except, a cell's owned paths in bedrock guards.json).
// `**` any number of segments (`x/**` also matches x itself), `*` and `?` within one segment. Case-insensitive.
export function globRe(glob: string): RegExp {
  const g = glob.toLowerCase().replace(/^\/+|\/+$/g, '');
  let out = '';
  for (let i = 0; i < g.length;) {
    if (g.startsWith('**/', i)) { out += '(?:.*/)?'; i += 3; }
    else if (g.startsWith('/**', i) && i + 3 === g.length) { out += '(?:/.*)?'; i += 3; }
    else if (g.startsWith('**', i)) { out += '.*'; i += 2; }
    else if (g[i] === '*') { out += '[^/]*'; i++; }
    else if (g[i] === '?') { out += '[^/]'; i++; }
    else { out += g[i].replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  return new RegExp(`^${out}$`);
}
