# Legacy user migration

`dvi_users` migration is intentionally dry-run by default. The utility preserves legacy PHP password hashes so the current API can verify the old password on first login and upgrade it to bcrypt.

Set these variables in the shell or in the local ignored `.env` file:

```text
LEGACY_DATABASE_URL=mysql://user:password@host:3306/dvi_travels
DATABASE_URL=mysql://user:password@host:3306/dvi_staging
```

When the command is run on the legacy server, `LEGACY_DATABASE_URL` can be replaced by the existing PHP configuration:

```bash
--legacy-php-config /var/www/html/head/config/database.php
```

For production, load the production environment file explicitly:

```bash
npm run migrate:legacy-users -- --env-file .env-prod --target-db dvi_main
```

Run the staging dry-run first:

```bash
npm run migrate:legacy-users -- --target-db dvi_staging
```

Apply only after reviewing the summary:

```bash
npm run migrate:legacy-users -- --target-db dvi_staging --apply
```

The command:

- allows only `dvi_staging` and `dvi_main` as targets;
- validates both `dvi_users` schemas before reading data;
- rejects duplicate normalized emails during `--apply`;
- creates a target backup table and an auditable source-to-target mapping table;
- preserves source `userID` values when the target table is empty;
- merges by normalized email when the target already contains users;
- does not overwrite matching target users unless `--replace-matched-passwords` is explicitly supplied;
- can skip every source row belonging to a duplicated normalized email with `--skip-duplicate-source-emails`;
- does not copy old session fields (`usertoken`, `userlogkey`, `last_loggedon`, or `google_auth_code`);
- reports empty or unsupported password hashes and blocks active ones unless `--allow-unusable-passwords` is supplied.

The utility migrates accounts, not their related `dvi_agent`, `dvi_agent_configuration`, staff, vendor, guide, or booking records. Those related rows must already exist in the target database with compatible IDs for the corresponding login context to work.

After staging succeeds, repeat the dry-run and apply steps with `--target-db dvi_main` and a `DATABASE_URL` pointing to `dvi_main`.
