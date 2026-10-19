# How to contribute

1. **Get the latest code** before you start: `git pull`.
2. **Work on a branch**, never directly on `master`:
   `git switch -c my-change`
3. **Follow the rules** in `docs/ONBOARDING.md`, section 4 (millimes, restaurant from the
   login, append-only tables, closed-by-default routes, strict input checks, new migration
   files only, no secrets, tests).
4. **Check before you push**:
   ```bash
   pnpm test
   pnpm test:e2e
   pnpm audit
   ```
   and, in `apps/api` and `apps/web`, `pnpm lint`.
5. **Push the branch** (`git push -u origin my-change`) and open a **Pull Request** on GitHub.
   Explain what changes and why. The project owner reviews and merges.

Screens are in **French** (the people using them are in Tunisia). Code, comments and
commit messages are in **English**.
