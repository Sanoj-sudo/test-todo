import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const DB_NAME = process.env.DB_NAME || 'todoapp';
if (!/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  throw new Error('DB_NAME may only contain letters, numbers and underscores');
}

function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;

  const caPath = path.resolve(process.env.DB_SSL_CA || 'certs/global-bundle.pem');
  if (fs.existsSync(caPath)) {
    // Same as `--ssl-mode=VERIFY_IDENTITY`: trust only the RDS CA and check the hostname.
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true, verifyIdentity: true };
  }

  console.warn(
    `[db] DB_SSL=true but CA bundle not found at ${caPath}. ` +
      'Connecting with TLS but WITHOUT certificate verification. ' +
      'Run deploy/setup-ec2.sh or download https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'
  );
  return { rejectUnauthorized: false };
}

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  ssl: sslConfig(),
  connectTimeout: 10_000,
  timezone: 'Z',
  // Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates,
  // so due dates never shift because of server/client timezone differences.
  dateStrings: ['DATE'],
  // MySQL stores BOOLEAN as TINYINT(1); hand it back as a real boolean.
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === '1';
    }
    return next();
  },
};

export const pool = mysql.createPool({
  ...connectionConfig,
  database: DB_NAME,
  connectionLimit: Number(process.env.DB_POOL_MAX || 10),
  waitForConnections: true,
});

// Keep TIMESTAMP values in UTC regardless of the server's time_zone setting.
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export async function migrate() {
  // Create the database itself if RDS was set up without an "Initial database name".
  const admin = await mysql.createConnection(connectionConfig);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end();
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title       VARCHAR(500) NOT NULL,
      completed   BOOLEAN      NOT NULL DEFAULT FALSE,
      priority    TINYINT      NOT NULL DEFAULT 2,
      due_date    DATE         NULL,
      created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX todos_completed_created_idx (completed, created_at),
      CHECK (priority BETWEEN 1 AND 3),
      CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 500)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
