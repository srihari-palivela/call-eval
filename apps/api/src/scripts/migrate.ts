// Apply database migrations: npm run migrate
import { getDb } from '../db';
import { seedTaxonomy } from '../analytics/meta';

const db = await getDb();
await seedTaxonomy(db);
console.log(`migrated (${db.kind})`);
await db.close();
