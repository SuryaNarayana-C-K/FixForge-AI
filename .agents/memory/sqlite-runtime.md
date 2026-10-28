---
name: Local SQLite runtime
description: Why FixForge uses Node's built-in SQLite support for the local-first milestone.
---

FixForge uses Node 24's built-in `node:sqlite` module for local persistence instead of a native npm SQLite driver.

**Why:** Native driver installation was not available through the workspace package installer, while the requested product architecture explicitly requires SQLite.

**How to apply:** Keep the database file local and isolated behind `lib/db`; do not expose SQLite handles to the frontend or Python service. Revisit the driver choice only if the runtime baseline changes or a production persistence requirement is introduced.