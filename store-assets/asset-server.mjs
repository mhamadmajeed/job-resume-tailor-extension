// Local-only helper for generating Chrome Web Store assets. Serves the extension
// directory statically and accepts POST /save?name=<file> with a raw image body,
// writing it into store-assets/. Never deployed; dev machine only.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store-assets');
const PORT = 4872;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json'
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/save') {
    const name = path.basename(url.searchParams.get('name') || '');
    if (!/^[\w.-]+\.(png|jpg)$/.test(name)) {
      res.writeHead(400).end('bad name');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await writeFile(path.join(OUT, name), Buffer.concat(chunks));
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('saved ' + name);
    return;
  }

  const filePath = path.join(ROOT, path.normalize(url.pathname).replace(/^([\\/])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`asset server on ${PORT}`));
