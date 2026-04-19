function requireEnv(name: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://127.0.0.1:4173",
  databaseUrl:
    process.env.DATABASE_URL ??
    (process.env.NODE_ENV === "production"
      ? requireEnv("DATABASE_URL", process.env.DATABASE_URL)
      : "postgresql://shopping:shopping@127.0.0.1:54329/shopping_list"),
};
