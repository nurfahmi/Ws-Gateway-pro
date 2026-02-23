import 'dotenv/config';
import prisma from './src/lib/prisma.js';
import crypto from 'crypto';

/**
 * One-time script to backfill API keys for existing devices.
 * Run this after deploying the schema change on production:
 *   node backfill-apikeys.js
 */
async function backfill() {
  const devices = await prisma.device.findMany();
  let updated = 0;

  for (const device of devices) {
    if (!device.apiKey || device.apiKey === '') {
      const newKey = crypto.randomUUID();
      await prisma.device.update({
        where: { id: device.id },
        data: { apiKey: newKey },
      });
      console.log(`✅ Device "${device.name || device.sessionId}" (id: ${device.id}) → ${newKey}`);
      updated++;
    } else {
      console.log(`⏭️  Device "${device.name || device.sessionId}" already has key`);
    }
  }

  console.log(`\nDone! Updated ${updated}/${devices.length} devices.`);
  process.exit(0);
}

backfill().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
