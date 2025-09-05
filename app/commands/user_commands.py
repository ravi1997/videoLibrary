import click
from datetime import datetime, timezone
from flask.cli import with_appcontext
from app.models.User import User, db, UserType, Role, UserRole


@click.command("create-user")
@click.option(
    "--username",
    prompt="Username",
    default="admin",
    help="Username of the new user"
)
@click.option(
    "--email",
    prompt="Email address",
    default="admin@example.com",
    help="Email address"
)
@click.option(
    "--employee-id",
    prompt="Employee ID",
    default="EMP001",
    help="Employee ID"
)
@click.option(
    "--mobile",
    prompt="Mobile number",
    default="9999999999",
    help="Mobile number"
)
@click.option(
    "--password",
    prompt=True,
    hide_input=True,
    confirmation_prompt=True,
    default="admin123",
    help="Password"
)
@click.option(
    "--user-type",
    type=click.Choice([u.value for u in UserType]),
    prompt="User type",
    default=UserType.EMPLOYEE.value,
    help="User type"
)
@click.option(
    "--roles",
    multiple=True,
    type=click.Choice([r.value for r in Role]),
    help="Roles (can be multiple, e.g. --roles admin --roles uploader)"
)
@click.option(
    "--admin",
    is_flag=True,
    default=False,
    help="Grant admin role (used only if --roles is not provided)"
)
@with_appcontext
def create_user(username, email, employee_id, mobile, password, user_type, roles, admin):
    """Create a new user from the CLI."""

    existing_user = User.query.filter(
        (User.username == username) |
        (User.email == email) |
        (User.employee_id == employee_id)
    ).first()

    if existing_user:
        click.secho(
            "❌ A user with the same username, email, or employee ID already exists.", fg='red')
        return

    # Determine final roles
    final_roles = list(roles)
    if not final_roles and admin:
        final_roles = ["admin"]

    user = User(
        username=username,
        email=email,
        employee_id=employee_id,
        mobile=mobile,
        user_type=UserType(user_type),
        is_active=True,
        is_email_verified=True,
        is_admin="admin" in final_roles,
        created_at=datetime.now(timezone.utc),
    )

    user.set_password(password)
    db.session.add(user)
    db.session.flush()  # So user.id is available before commit

    # Insert roles manually into association table
    for role in final_roles:
        db.session.execute(UserRole.insert().values(
            user_id=user.id, role=Role(role)))

    db.session.commit()
    click.secho(
        f"✅ User '{username}' created with roles: {final_roles or '[]'}", fg='green')


@click.command("create-superadmin")
@click.option("--username", default=None, help="Override username (default from config or superadmin)")
@click.option("--email", default=None, help="Override email (default from config)")
@click.option("--employee-id", default=None, help="Override employee id")
@click.option("--mobile", default=None, help="Override mobile")
@click.option("--password", prompt=True, hide_input=True, confirmation_prompt=True, help="Superadmin password (required)")
@with_appcontext
def create_superadmin(username, email, employee_id, mobile, password):
    """Create a superadmin (idempotent if one already exists)."""
    existing = User.query.join(UserRole).filter(UserRole.role == Role.SUPERADMIN).first()
    if existing:
        click.secho("⚠ A superadmin already exists; aborting.", fg='yellow')
        return
    from flask import current_app
    cfg = current_app.config
    su = User(
        username=username or cfg.get('SUPERADMIN_USERNAME') or 'superadmin',
        email=email or cfg.get('SUPERADMIN_EMAIL') or 'superadmin@example.com',
        employee_id=employee_id or cfg.get('SUPERADMIN_EMPLOYEE_ID') or 'SUPER001',
        mobile=mobile or cfg.get('SUPERADMIN_MOBILE') or '9000000000',
        is_active=True,
        is_email_verified=True,
        is_verified=True,
        is_admin=True,
        user_type=UserType.EMPLOYEE
    )
    su.set_password(password)
    db.session.add(su)
    db.session.flush()
    db.session.execute(UserRole.insert().values(user_id=su.id, role=Role.SUPERADMIN))
    db.session.execute(UserRole.insert().values(user_id=su.id, role=Role.ADMIN))
    db.session.commit()
    click.secho(f"✅ Superadmin '{su.username}' created (email: {su.email})", fg='green')


@click.command("rotate-superadmin-password")
@click.option("--current", prompt=True, hide_input=True, help="Current superadmin password")
@click.option("--new", prompt=True, hide_input=True, confirmation_prompt=True, help="New superadmin password")
@with_appcontext
def rotate_superadmin_password(current, new):
    """Rotate password for existing superadmin (first one found); requires current password."""
    from flask import current_app
    su = User.query.join(UserRole).filter(UserRole.role == Role.SUPERADMIN).first()
    if not su:
        click.secho("❌ No superadmin exists to rotate password.", fg='red')
        return
    # Verify current
    if not su.check_password(current):
        click.secho("❌ Current password invalid.", fg='red')
        current_app.logger.warning("Superadmin rotation failed: invalid current password for user %s", su.id)
        return
    try:
        su.set_password(new)
        db.session.commit()
        click.secho(f"✅ Superadmin password rotated for '{su.username}'", fg='green')
        current_app.logger.info("Superadmin password rotated for user %s", su.id)
    except Exception as e:
        db.session.rollback()
        current_app.logger.exception("Superadmin rotation error: %s", e)
        click.secho(f"❌ Rotation failed: {e}", fg='red')
