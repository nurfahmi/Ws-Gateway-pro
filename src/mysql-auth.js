import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export const useMySQLAuthState = async (pool, sessionId) => {
    
    // Helper to prefix keys
    const getKey = (key) => `${sessionId}:${key}`;

    // Load creds
    const readData = async (id) => {
        try {
            const [rows] = await pool.query('SELECT data FROM session_store WHERE id = ?', [getKey(id)]);
            if (rows.length > 0) {
                return JSON.parse(rows[0].data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`Error reading data for ${id}:`, error);
            return null;
        }
    };

    const writeData = async (id, data) => {
        try {
            const serialized = JSON.stringify(data, BufferJSON.replacer);
            await pool.query(
                'INSERT INTO session_store (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
                [getKey(id), serialized, serialized]
            );
        } catch (error) {
            console.error(`Error writing data for ${id}:`, error);
        }
    };

    const removeData = async (id) => {
        try {
            await pool.query('DELETE FROM session_store WHERE id = ?', [getKey(id)]);
        } catch (error) {
            console.error(`Error deleting data for ${id}:`, error);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            if (value) {
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value === null || value === undefined) {
                                tasks.push(removeData(key));
                            } else {
                                tasks.push(writeData(key, value));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', creds);
        }
    };
};
