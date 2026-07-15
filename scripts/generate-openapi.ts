import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RequestMethod } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';

dotenv.config();

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'servers')
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]));
}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'api/v2/graphql', method: RequestMethod.ALL }],
  });
  await app.init();

  const config = new DocumentBuilder()
    .setTitle('DVI Backend APIs')
    .setDescription('Hotels & Itineraries APIs with RBAC (admin/agent/vendor)')
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Paste the JWT access token from /api/v1/auth/login here (without "Bearer " prefix).',
    })
    .build();

  const document = normalize(SwaggerModule.createDocument(app, config));
  const output = path.resolve(process.cwd(), process.argv[2] || 'docs/testing/openapi-baseline.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`OpenAPI document written to ${output}`);
  console.log(`Paths: ${Object.keys((document as { paths?: object }).paths || {}).length}`);
  await app.close();
}

main().catch((error) => {
  console.error('OpenAPI generation failed:', error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
