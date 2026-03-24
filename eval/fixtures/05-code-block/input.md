# Database Migration Guide

## Setup

Install the migration tool:

```bash
npm install -g db-migrate
```

## Creating a Migration

<!-- @comment{"id":"eval-05-c1","anchor":"```javascript\nmodule.exports = {\n  up: async (db) => {\n    await db.createTable('users', {\n      id: 'serial',\n      email: 'string',\n      name: 'string',\n    });\n  },\n  down: async (db) => {\n    await db.dropTable('users');\n  },\n};```","text":"Add error handling — wrap the up/down functions in try/catch. Also add a created_at timestamp column to the table.","author":"PM","timestamp":"2026-03-20T14:00:00Z"} -->```javascript
module.exports = {
  up: async (db) => {
    await db.createTable('users', {
      id: 'serial',
      email: 'string',
      name: 'string',
    });
  },
  down: async (db) => {
    await db.dropTable('users');
  },
};
```

## Running Migrations

Run `db-migrate up` to apply pending migrations. Use `db-migrate down` to rollback the most recent migration.
