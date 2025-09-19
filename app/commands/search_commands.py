import click
from flask import current_app
from app.extensions import db


@click.command('search-reindex')
def search_reindex():
    """Rebuild videos.search_vec for all rows (PostgreSQL only).

    Safe to run multiple times; skips on non-Postgres. Logs number of updated rows.
    """
    engine = db.engine
    if getattr(engine, 'name', '').lower() != 'postgresql':
        current_app.logger.info('search-reindex: skipped (non-PostgreSQL engine)')
        click.echo('Skipped: non-PostgreSQL engine')
        return
    try:
        with engine.begin() as conn:
            # Ensure videos.search_vec exists
            has_col = False
            try:
                res = conn.execute(db.text("SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='search_vec'"))
                has_col = bool(res.scalar())
            except Exception:
                has_col = False
            if not has_col:
                current_app.logger.warning('search-reindex: videos.search_vec column missing; skipping')
                click.echo('Skipped: videos.search_vec column missing')
                return

            # Detect unaccent availability
            try:
                res = conn.execute(db.text("SELECT 1 FROM pg_proc WHERE proname='unaccent' LIMIT 1"))
                has_unaccent = bool(res.scalar())
            except Exception:
                has_unaccent = False

            def wrap(expr: str) -> str:
                return f"unaccent({expr})" if has_unaccent else expr

            # Build UPDATE that aggregates category, tags, surgeons into a single TSV
            sql = f"""
                UPDATE videos v
                SET search_vec = to_tsvector('simple',
                    {wrap("coalesce(v.title,'')")} || ' ' ||
                    {wrap("coalesce(v.description,'')")} || ' ' ||
                    {wrap("coalesce(v.transcript,'')")} || ' ' ||
                    coalesce((SELECT {wrap('c.name')} FROM categories c WHERE c.id = v.category_id),'') || ' ' ||
                    coalesce((
                        SELECT string_agg({wrap('t.name')}, ' ')
                        FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
                        WHERE vt.video_id = v.uuid
                    ), '') || ' ' ||
                    coalesce((
                        SELECT string_agg({wrap('s.name')}, ' ')
                        FROM video_surgeons vs JOIN surgeons s ON s.id = vs.surgeon_id
                        WHERE vs.video_id = v.uuid
                    ), '')
                )
            """
            res = conn.execute(db.text(sql))
            current_app.logger.info('search-reindex: vectors rebuilt for videos (rowcount=%s)', getattr(res, 'rowcount', '?'))
            click.echo(f'Reindexed videos.search_vec (rowcount={getattr(res, "rowcount", "?")})')
    except Exception as e:
        current_app.logger.exception('search-reindex failed: %s', e)
        click.echo(f'Error: {e}', err=True)
