# WA Gateway — Project Rules

## Architecture: MVC (Model-View-Controller)
- **Models**: Prisma ORM (`prisma/schema.prisma`). No raw SQL unless for analytics aggregation.
- **Views**: EJS templates in `src/views/`. Uses `express-ejs-layouts` with `src/views/layout.ejs` as the main layout.
- **Controllers**: `src/controllers/`. One file per feature (e.g. `deviceController.js`, `userController.js`).
- **Routes**: All routes defined in `src/routes/index.js` with auth/role middleware.
- **Middleware**: `src/middleware/` (e.g. `auth.js` for `requireAuth`, `requireRole`, `guestOnly`).
- **Entry point**: `src/index.js` — Express setup, session config, API routes (backward-compatible), and mounts `src/routes/index.js`.

## Styling: Tailwind CSS Only
- Use **Tailwind CSS via CDN** (`<script src="https://cdn.tailwindcss.com">`), already included in `layout.ejs`.
- **DO NOT** create custom CSS files, use `<style>` blocks (except minimal overrides for markdown/prose in docs), or import external CSS frameworks.
- **DO NOT** use Bootstrap, custom stylesheets, or inline `style` attributes.
- All styling must be done with Tailwind utility classes directly in EJS templates.
- Dark mode uses `class` strategy — always include `dark:` variants on all UI elements.

## File Structure
```
src/
├── controllers/     # Feature controllers
├── middleware/       # Auth, role middleware
├── routes/          # index.js — central router
├── views/           # EJS templates
│   ├── layout.ejs   # Main layout (sidebar, header, theme toggle)
│   ├── login.ejs    # Login page (standalone, no layout)
│   ├── 403.ejs
│   ├── dashboard.ejs
│   ├── users/       # index, create, edit
│   ├── devices/     # index
│   ├── messages/    # index
│   ├── analytics/   # index
│   ├── monitor/     # index
│   ├── settings/    # index
│   └── api-docs/    # index
├── lib/
│   └── prisma.js    # Shared PrismaClient instance
├── whatsapp.js      # Baileys WA integration
├── db.js            # Legacy DB init
└── index.js         # App entry point
prisma/
├── schema.prisma    # Database schema
└── seed.js          # Default superadmin seed
public/
└── uploads/         # Uploaded favicon/logo
```

## Key Conventions
- **Auth**: Session-based (`express-session`). Passwords hashed with `bcryptjs`.
- **Roles**: `superadmin`, `admin`, `user`. Enforced via `requireRole()` middleware.
- **Site settings**: Stored in `settings` table (key-value). Injected globally via `res.locals.siteSettings` in router middleware.
- **Tables with pagination**: All list views must use paginated tables with Previous/Next links.
- **Dark/light theme**: Toggle in header, persisted to `localStorage`. All views must support both themes.
- **API routes**: Mounted directly on `app` in `src/index.js` under `/api/*` — no session auth, backward-compatible.
- **Dashboard routes**: Mounted via `src/routes/index.js` under `/` — require session auth.
