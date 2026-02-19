import mysql from 'mysql2/promise';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'whatsapp_baileys',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export const initDb = async () => {
  try {
    // 1. Create database if it doesn't exist
    const tempConn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
    });
    const dbName = process.env.DB_NAME || 'whatsapp_baileys';
    await tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await tempConn.end();
    console.log(`Database "${dbName}" ensured`);

    // 2. Push Prisma schema (creates/syncs all tables)
    console.log('Syncing database schema...');
    execSync('npx prisma db push --skip-generate 2>&1', { stdio: 'inherit' });
    console.log('Database schema synced');

    // 3. Ensure session_store table exists (used by raw mysql2 queries)
    const connection = await pool.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS session_store (
        id VARCHAR(255) NOT NULL PRIMARY KEY,
        data LONGTEXT NOT NULL
      )
    `);
    connection.release();
    console.log('Database initialized');
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
};

export default pool;
