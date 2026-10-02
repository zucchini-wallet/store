import { readFile } from 'node:fs/promises';
export async function credentials(path) {
  const values = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  if (!values.API_KEY || !values.API_SECRET) throw Error('Provider credentials missing');
  return values;
}
