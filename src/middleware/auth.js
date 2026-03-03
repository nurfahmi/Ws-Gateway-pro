export const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  res.locals.user = req.session.user;
  res.locals.originalUser = req.session.originalUser || null;
  next();
};

export const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    const currentRole = req.session.user.role;
    const originalRole = req.session.originalUser?.role;
    if (!roles.includes(currentRole) && !roles.includes(originalRole)) {
      return res.status(403).render('403', { title: 'Forbidden' });
    }
    next();
  };
};

export const guestOnly = (req, res, next) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  next();
};
