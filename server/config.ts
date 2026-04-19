function requireEnv(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "development" || nodeEnv === "test") {
    return "postgresql://shopping:shopping@127.0.0.1:54329/shopping_list";
  }

  return requireEnv("DATABASE_URL", process.env.DATABASE_URL);
}

function createAllowedOriginRegex() {
  if (!process.env.CLIENT_ORIGIN_REGEX) {
    return null;
  }

  return new RegExp(process.env.CLIENT_ORIGIN_REGEX);
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:4173",
  clientOriginRegex: createAllowedOriginRegex(),
  databaseUrl: resolveDatabaseUrl(),
};
