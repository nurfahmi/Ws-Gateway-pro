import mysql from 'mysql2/promise';
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
        const connection = await pool.getConnection();
        await connection.query(`
            CREATE TABLE IF NOT EXISTS session_store (
                id VARCHAR(255) NOT NULL PRIMARY KEY,
                data LONGTEXT NOT NULL
            )
        `);
        console.log('Database initialized and table ensured');
        connection.release();
    } catch (error) {
        console.error('Database initialization failed:', error);
    }
};

export default pool;
