// After the client and server builds: write the prerendered page into dist/index.html, plus robots.txt and
// sitemap.xml for the domain in src/site.ts, then drop the server build.
import { readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const { render, SITE } = await import(new URL('.ssr/entry-server.js', root).href);

const indexPath = new URL('dist/index.html', root);
const html = await readFile(indexPath, 'utf8');
if (!html.includes('<!--app-html-->')) throw new Error('dist/index.html has no <!--app-html--> placeholder');
await writeFile(indexPath, html.replace('<!--app-html-->', render()));

await writeFile(new URL('dist/robots.txt', root), `User-agent: *\nAllow: /\nDisallow: /app/\n\nSitemap: ${SITE.domain}/sitemap.xml\n`);
await writeFile(
  new URL('dist/sitemap.xml', root),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE.domain}/</loc></url>\n</urlset>\n`,
);
await rm(new URL('.ssr/', root), { recursive: true, force: true });
console.log('prerendered dist/index.html, robots.txt, sitemap.xml');
