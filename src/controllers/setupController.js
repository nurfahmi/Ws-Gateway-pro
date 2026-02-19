import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';

// Generate a one-time setup token on startup
let setupToken = null;

export const initSetup = async () => {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    setupToken = crypto.randomBytes(24).toString('hex');
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  🔐 FIRST-TIME SETUP');
    console.log('  No admin account found. Use this one-time link');
    console.log('  to create your superadmin account:');
    console.log('');
    console.log(`  http://localhost:${process.env.PORT || 3000}/setup/${setupToken}`);
    console.log('');
    console.log('  ⚠️  This link expires after use or on restart.');
    console.log('═══════════════════════════════════════════════════');
    console.log('');
  }
};

export const setupPage = async (req, res) => {
  const { token } = req.params;
  if (!setupToken || token !== setupToken) {
    return res.status(404).render('403', { title: 'Not Found', layout: false });
  }
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    setupToken = null;
    return res.redirect('/login');
  }
  res.render('setup', { title: 'Setup Admin', token, error: null, layout: false });
};

export const setupPost = async (req, res) => {
  const { token } = req.params;
  if (!setupToken || token !== setupToken) {
    return res.status(404).render('403', { title: 'Not Found', layout: false });
  }
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    setupToken = null;
    return res.redirect('/login');
  }

  const { username, password, name } = req.body;
  if (!username || !password || !name) {
    return res.render('setup', { title: 'Setup Admin', token, error: 'All fields are required', layout: false });
  }
  if (password.length < 6) {
    return res.render('setup', { title: 'Setup Admin', token, error: 'Password must be at least 6 characters', layout: false });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { username, password: hash, name, role: 'superadmin' }
    });
    // Invalidate the token
    setupToken = null;
    console.log(`Superadmin "${username}" created via setup link`);
    res.redirect('/login');
  } catch (err) {
    console.error('Setup error:', err);
    res.render('setup', { title: 'Setup Admin', token, error: 'Failed to create account. Username may already be taken.', layout: false });
  }
};
