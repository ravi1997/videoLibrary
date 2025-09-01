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
