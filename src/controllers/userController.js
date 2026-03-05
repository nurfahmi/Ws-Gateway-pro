import prisma from '../lib/prisma.js';
import bcrypt from 'bcryptjs';

export const index = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const limit = 15;
  const skip = (page - 1) * limit;

  // Manager can only see their own assigned users
  const where = req.session.user.role === 'manager'
    ? { managerId: req.session.user.id }
    : {};

  // Add search filter
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { username: { contains: search } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { manager: { select: { id: true, name: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  const totalPages = Math.ceil(total / limit);

  // For superadmin: provide list of managers for display
  const managers = req.session.user.role === 'superadmin'
    ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
    : [];

  res.render('users/index', { title: 'User Management', users, managers, search, pagination: { page, totalPages, total } });
};

export const createPage = async (req, res) => {
  // For superadmin: get managers list for assignment dropdown
  const managers = req.session.user.role === 'superadmin'
    ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
    : [];

  res.render('users/create', { title: 'Create User', error: null, managers });
};

export const createPost = async (req, res) => {
  const { username, password, name, role, managerId } = req.body;
  try {
    let finalRole = role;
    let finalManagerId = null;

    if (req.session.user.role === 'manager') {
      // Manager can only create 'user' role, auto-assigned to themselves
      finalRole = 'user';
      finalManagerId = req.session.user.id;
    } else if (req.session.user.role === 'superadmin') {
      // Superadmin can create manager or user
      if (finalRole === 'user' && managerId) {
        finalManagerId = parseInt(managerId);
      }
      // manager role users don't have a managerId
    }

    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { username, password: hash, name, role: finalRole, managerId: finalManagerId },
    });
    res.redirect('/users');
  } catch (err) {
    if (err.code === 'P2002') {
      const managers = req.session.user.role === 'superadmin'
        ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
        : [];
      return res.render('users/create', { title: 'Create User', error: 'Username already exists', managers });
    }
    console.error(err);
    const managers = req.session.user.role === 'superadmin'
      ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
      : [];
    res.render('users/create', { title: 'Create User', error: 'Failed to create user', managers });
  }
};

export const editPage = async (req, res) => {
  const editUser = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!editUser) return res.redirect('/users');

  // Manager can only edit their own assigned users
  if (req.session.user.role === 'manager' && editUser.managerId !== req.session.user.id) {
    return res.status(403).render('403', { title: 'Forbidden' });
  }

  const managers = req.session.user.role === 'superadmin'
    ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
    : [];

  res.render('users/edit', { title: 'Edit User', editUser, error: null, managers });
};

export const editPost = async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, role, password, isActive, managerId } = req.body;
  try {
    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) return res.redirect('/users');

    // Manager can only edit their own assigned users
    if (req.session.user.role === 'manager' && existingUser.managerId !== req.session.user.id) {
      return res.status(403).render('403', { title: 'Forbidden' });
    }

    const data = { name, isActive: isActive === 'on' };

    if (req.session.user.role === 'manager') {
      // Manager cannot change role
      data.role = 'user';
    } else {
      data.role = role;
      if (role === 'user' && managerId) {
        data.managerId = parseInt(managerId);
      } else if (role === 'manager' || role === 'superadmin') {
        data.managerId = null;
      }
    }

    if (password && password.trim()) {
      data.password = await bcrypt.hash(password, 10);
    }
    await prisma.user.update({ where: { id }, data });
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    const editUser = await prisma.user.findUnique({ where: { id } });
    const managers = req.session.user.role === 'superadmin'
      ? await prisma.user.findMany({ where: { role: 'manager' }, select: { id: true, name: true } })
      : [];
    res.render('users/edit', { title: 'Edit User', editUser, error: 'Failed to update', managers });
  }
};

export const deleteUser = async (req, res) => {
  const id = parseInt(req.params.id);
  // Prevent deleting yourself
  if (id === req.session.user.id) {
    return res.redirect('/users');
  }

  const targetUser = await prisma.user.findUnique({ where: { id } });
  if (!targetUser) return res.redirect('/users');

  // Manager can only delete their own assigned users
  if (req.session.user.role === 'manager' && targetUser.managerId !== req.session.user.id) {
    return res.status(403).render('403', { title: 'Forbidden' });
  }

  await prisma.user.delete({ where: { id } });
  res.redirect('/users');
};

// Impersonate a user (superadmin or manager for their staff)
export const impersonate = async (req, res) => {
  const currentUser = req.session.user;
  if (currentUser.role !== 'superadmin' && currentUser.role !== 'manager') {
    return res.status(403).render('403', { title: 'Forbidden' });
  }
  const targetId = parseInt(req.params.id);
  if (targetId === currentUser.id) return res.redirect('/users');

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.redirect('/users');

  // Manager can only impersonate their own staff
  if (currentUser.role === 'manager' && target.managerId !== currentUser.id) {
    return res.status(403).render('403', { title: 'Forbidden' });
  }

  // Store original session
  req.session.originalUser = req.session.user;
  // Switch to target user
  req.session.user = {
    id: target.id,
    name: target.name,
    username: target.username,
    role: target.role,
  };
  res.redirect('/dashboard');
};

// Stop impersonating
export const stopImpersonate = (req, res) => {
  if (req.session.originalUser) {
    req.session.user = req.session.originalUser;
    delete req.session.originalUser;
  }
  res.redirect('/users');
};
