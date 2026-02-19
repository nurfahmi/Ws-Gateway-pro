export const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  res.locals.user = req.session.user;
  next();
};

export const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
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
