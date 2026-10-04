import postgres from "postgres";

/**
 * A database per test suite, created on demand next to DATABASE_URL_TEST, so suites that
 * truncate tables can run in parallel. Returns its connection URL.
 */
export async function testDatabase(name: string): Promise<string> {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) throw new Error("DATABASE_URL_TEST is not set");
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("test database name must be [a-z0-9_]");
  const dbName = `tab402_t_${name}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (!exists) {
      await admin.unsafe(`create database ${dbName}`).catch((err: { code?: string }) => {
        if (err.code !== "42P04") throw err; // created concurrently
      });
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}
