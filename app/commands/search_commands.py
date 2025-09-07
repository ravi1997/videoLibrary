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
            res = conn.execute(db.text(
                """
                UPDATE videos v
                SET search_vec = compute_video_search_vec(v.uuid, v.title, v.description, v.transcript, v.category_id)
                """
            ))
            # res.rowcount may be -1 depending on driver; echo anyway
            current_app.logger.info('search-reindex: vectors rebuilt for videos (rowcount=%s)', getattr(res, 'rowcount', '?'))
            click.echo(f'Reindexed videos.search_vec (rowcount={getattr(res, "rowcount", "?")})')
    except Exception as e:
        current_app.logger.exception('search-reindex failed: %s', e)
        click.echo(f'Error: {e}', err=True)
