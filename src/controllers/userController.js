import prisma from '../lib/prisma.js';
import bcrypt from 'bcryptjs';

export const index = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 15;
  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.user.count(),
  ]);
  const totalPages = Math.ceil(total / limit);
  res.render('users/index', { title: 'User Management', users, pagination: { page, totalPages, total } });
};

export const createPage = (req, res) => {
  res.render('users/create', { title: 'Create User', error: null });
};

export const createPost = async (req, res) => {
  const { username, password, name, role } = req.body;
  try {
    // Admin can only create 'user' role
    let finalRole = role;
    if (req.session.user.role === 'admin' && role !== 'user') {
      finalRole = 'user';
    }
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { username, password: hash, name, role: finalRole },
    });
    res.redirect('/users');
  } catch (err) {
    if (err.code === 'P2002') {
      return res.render('users/create', { title: 'Create User', error: 'Username already exists' });
    }
    console.error(err);
    res.render('users/create', { title: 'Create User', error: 'Failed to create user' });
  }
};

export const editPage = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!user) return res.redirect('/users');
  res.render('users/edit', { title: 'Edit User', editUser: user, error: null });
};

export const editPost = async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, role, password, isActive } = req.body;
  try {
    const data = { name, role, isActive: isActive === 'on' };
    if (req.session.user.role === 'admin' && role !== 'user') {
      data.role = 'user';
    }
    if (password && password.trim()) {
      data.password = await bcrypt.hash(password, 10);
    }
    await prisma.user.update({ where: { id }, data });
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    const user = await prisma.user.findUnique({ where: { id } });
    res.render('users/edit', { title: 'Edit User', editUser: user, error: 'Failed to update' });
  }
};

export const deleteUser = async (req, res) => {
  const id = parseInt(req.params.id);
  // Prevent deleting yourself
  if (id === req.session.user.id) {
    return res.redirect('/users');
  }
  await prisma.user.delete({ where: { id } });
  res.redirect('/users');
};
