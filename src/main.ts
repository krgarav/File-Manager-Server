import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function loadEnvFromFile() {
  const envPath = join(process.cwd(), '.env');

  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf8');

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function bootstrap() {
  loadEnvFromFile();
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create(AppModule);
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls and tools that do not send Origin.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Log only non-sensitive runtime config to confirm .env loading.
  console.log('Environment loaded', {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: process.env.PORT ?? '3000',
    corsOrigins,
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
