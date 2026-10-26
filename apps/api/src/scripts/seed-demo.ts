// Load demo data from the command line: npm run seed:demo [-- --count 3000 --days 90]
import { getDb } from '../db';
import { seedTaxonomy } from '../analytics/meta';
import { seedDemo } from '../demo/seed';

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) || d : d; };
const db = await getDb();
await seedTaxonomy(db);
const r = await seedDemo(db, { count: arg('count', 5000), days: arg('days', 90) });
console.log(JSON.stringify(r));
await db.close();
