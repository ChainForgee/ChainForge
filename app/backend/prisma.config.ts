import { defineConfig } from 'prisma/config';
import * as fs from 'fs';
import * as path from 'path';

const provider = process.env.DATABASE_PROVIDER || 'sqlite';
const sourceSchemaPath = path.join(__dirname, 'prisma', 'schema.prisma');
const destSchemaPath = path.join(__dirname, 'prisma', 'schema.generated.prisma');

if (fs.existsSync(sourceSchemaPath)) {
  let content = fs.readFileSync(sourceSchemaPath, 'utf8');
  
  // Replace provider env mapping
  content = content.replace(
    /provider\s*=\s*env\("DATABASE_PROVIDER"\)/g,
    `provider = "${provider}"`
  );
  
  // Remove shadowDatabaseUrl if using SQLite
  if (provider === 'sqlite') {
    content = content.replace(/shadowDatabaseUrl\s*=\s*env\("SHADOW_DATABASE_URL"\)/g, '');
  }
  
  fs.writeFileSync(destSchemaPath, content, 'utf8');
}

export default defineConfig({
  schema: 'prisma/schema.generated.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL || 'file:./dev.db',
  },
});
