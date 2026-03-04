import prisma from '../lib/prisma.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { setGlobalWebhook, getGlobalWebhook } from '../whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, '../../public/uploads');

// Ensure uploads dir exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper to get all settings as object
export async function getSettings() {
  const rows = await prisma.setting.findMany();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  // Include live webhook URL
  settings.webhookUrl = getGlobalWebhook() || '';
  return settings;
}

export const index = async (req, res) => {
  const settings = await getSettings();
  res.render('settings/index', {
    title: 'Site Settings',
    settings,
    success: req.query.success || null,
  });
};

export const update = async (req, res) => {
  const { siteName, baseUrl, webhookUrl } = req.body;

  const upserts = [];
  if (siteName !== undefined) {
    upserts.push(prisma.setting.upsert({ where: { key: 'siteName' }, update: { value: siteName }, create: { key: 'siteName', value: siteName } }));
  }
  if (baseUrl !== undefined) {
    upserts.push(prisma.setting.upsert({ where: { key: 'baseUrl' }, update: { value: baseUrl }, create: { key: 'baseUrl', value: baseUrl } }));
  }
  await Promise.all(upserts);

  // Save webhook URL via whatsapp module
  if (webhookUrl !== undefined) {
    await setGlobalWebhook(webhookUrl.trim() || null);
  }

  res.redirect('/settings?success=1');
};

export const uploadFile = async (req, res) => {
  const { type } = req.params; // 'favicon' or 'logo'
  if (!['favicon', 'logo'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  // Simple raw body file upload using base64 from form
  // We'll handle this via multipart in a simple way
  try {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const buffer = Buffer.concat(chunks);

      // Parse multipart boundary
      const contentType = req.headers['content-type'];
      const boundary = contentType.split('boundary=')[1];
      const parts = buffer.toString('binary').split('--' + boundary);

      for (const part of parts) {
        if (part.includes('name="file"')) {
          const headerEnd = part.indexOf('\r\n\r\n') + 4;
          const bodyEnd = part.lastIndexOf('\r\n');
          const fileData = Buffer.from(part.substring(headerEnd, bodyEnd), 'binary');

          // Get filename from header
          const filenameMatch = part.match(/filename="([^"]+)"/);
          const origName = filenameMatch ? filenameMatch[1] : 'upload';
          const ext = path.extname(origName) || '.png';
          const filename = `${type}${ext}`;
          const filepath = path.join(uploadsDir, filename);

          fs.writeFileSync(filepath, fileData);

          // Save setting
          await prisma.setting.upsert({
            where: { key: type },
            update: { value: `/uploads/${filename}` },
            create: { key: type, value: `/uploads/${filename}` },
          });

          return res.redirect('/settings?success=1');
        }
      }
      res.redirect('/settings');
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.redirect('/settings');
  }
};
