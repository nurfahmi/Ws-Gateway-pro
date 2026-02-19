import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';

export const loginPage = (req, res) => {
  res.render('login', { title: 'Login', error: null, layout: false });
};

export const loginPost = async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !user.isActive) {
      return res.render('login', { title: 'Login', error: 'Invalid credentials', layout: false });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.render('login', { title: 'Login', error: 'Invalid credentials', layout: false });
    }
    req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { title: 'Login', error: 'Server error', layout: false });
  }
};

export const logout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
};
