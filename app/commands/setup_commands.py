import click
from flask import current_app
from flask.cli import with_appcontext
from flask_migrate import upgrade as alembic_upgrade, stamp as alembic_stamp
from app.extensions import db


@click.command("setup")
@click.option("--reindex/--no-reindex", default=True, help="Rebuild FTS vectors after migrations (PostgreSQL only)")
@click.option("--create-unaccent/--no-create-unaccent", default=True, help="Ensure unaccent extension (PostgreSQL only)")
@click.option("--create-superadmin/--no-create-superadmin", default=True, help="Create superadmin if none exists (uses env or provided password)")
@click.option("--superadmin-password", default=None, help="Superadmin password (falls back to SUPERADMIN_PASSWORD env)")
@with_appcontext
def setup_command(reindex: bool, create_unaccent: bool, create_superadmin: bool, superadmin_password: str | None):
    """One-shot project setup for fresh systems.

    - Upgrades DB schema to head (Alembic)
    - Ensures unaccent extension (PostgreSQL)
    - Rebuilds videos.search_vec for all rows (PostgreSQL)

    Safe to run multiple times; all steps are idempotent.
    """
    engine = db.engine
    engine_name = getattr(engine, 'name', '').lower()
    current_app.logger.info("setup: starting (engine=%s)", engine_name)

    # 1) Ensure Postgres unaccent extension (if requested)
    if engine_name == 'postgresql' and create_unaccent:
        try:
            with engine.begin() as conn:
                conn.execute(db.text("CREATE EXTENSION IF NOT EXISTS unaccent"))
            click.echo("✔ unaccent extension ensured")
        except Exception as e:
            # Non-fatal: migrations may still run; surface message
            current_app.logger.warning("setup: could not create unaccent: %s", e)
            click.echo(f"⚠ Could not create unaccent extension: {e}")

    # 2) Upgrade schema to head
    try:
        # Detect inconsistent stamp (alembic_version at head but tables missing)
        try:
            from sqlalchemy import inspect as sa_inspect
            insp = sa_inspect(db.engine)
            tables = set(insp.get_table_names())
        except Exception:
            tables = set()

        if ('users' not in tables or 'user_roles' not in tables) and 'alembic_version' in tables:
            # Likely a fresh DB with only alembic_version stamped incorrectly.
            click.echo('ℹ Detected stale stamp without tables; re-stamping to base then upgrading')
            alembic_stamp(revision='base')  # reset revision without modifying schema
            alembic_upgrade()
        else:
            alembic_upgrade()  # uses Flask-Migrate configured context
        click.echo("✔ Database upgraded to head")
    except Exception as e:
        current_app.logger.exception('setup: migration failed: %s', e)
        raise click.ClickException(f"Migration failed: {e}")

    # 3) Optionally create superadmin now that schema exists
    if create_superadmin:
        try:
            from app.commands.user_commands import create_superadmin as _create_su
            # Determine password source
            pwd = superadmin_password or current_app.config.get('SUPERADMIN_PASSWORD')
            if pwd:
                # Call the function directly (idempotent; it will skip if one exists)
                _create_su.callback(None, None, None, None, pwd)  # username,email,employee_id,mobile,password
                click.echo("✔ Superadmin ensured")
            else:
                click.echo("ℹ SUPERADMIN_PASSWORD not provided; skipping superadmin creation")
        except Exception as e:
            current_app.logger.warning('setup: superadmin creation skipped/failed: %s', e)
            click.echo(f"⚠ Superadmin creation skipped/failed: {e}")

    # 4) Reindex FTS vectors (optional; Postgres only)
    if reindex and engine_name == 'postgresql':
        try:
            with engine.begin() as conn:
                res = conn.execute(db.text(
                    """
                    UPDATE videos v
                    SET search_vec = compute_video_search_vec(v.uuid, v.title, v.description, v.transcript, v.category_id)
                    """
                ))
                click.echo(f"✔ Reindexed videos.search_vec (rowcount={getattr(res, 'rowcount', '?')})")
        except Exception as e:
            # Non-fatal; keep setup overall successful
            current_app.logger.warning('setup: reindex failed: %s', e)
            click.echo(f"⚠ Reindex failed: {e}")

    click.echo("✅ Setup complete")
