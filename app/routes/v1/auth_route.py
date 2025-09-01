from datetime import datetime, timedelta, timezone
import random
from flask import Blueprint, current_app, make_response, render_template_string, request, jsonify
from app.config import Config
from app.models.User import User, UserRole
from app.models.TokenBlocklist import TokenBlocklist
from app.models.enumerations import Role
from app.schemas.user_schema import UserSchema
from flask_jwt_extended import (
    create_access_token, get_jwt_identity, jwt_required,
    get_jwt, set_access_cookies, unset_jwt_cookies
)
from app.utils.decorator import require_roles
from app.extensions import db

auth_bp = Blueprint('auth_bp', __name__)
user_schema = UserSchema()
ADMIN_ROLE = Config.ADMIN_ROLE


# -------------------- REGISTER --------------------
@auth_bp.route("/register", methods=["POST"])
def register():
    data = request.get_json()
    current_app.logger.info("Received registration data: %s", {k: v for k, v in data.items() if k != "password"})
    roles_in = data.get("roles", [])
    data_wo_roles = dict(data)
    data_wo_roles.pop("roles", None)
    try:
        # Validate and deserialize data using Marshmallow
        user = user_schema.load(data_wo_roles, partial=("roles",))
    except Exception as e:
        current_app.logger.exception("❌ Error deserializing user data")
        return jsonify(message="Invalid user data"), 400

    try:
        # Check if user already exists by email or employee ID
        if User.query.filter_by(email=user.email).first():
            current_app.logger.warning(f"⚠️  Email already registered: {user.email}")
            return jsonify(message="Email already exists"), 409

        if user.employee_id and User.query.filter_by(employee_id=user.employee_id).first():
            current_app.logger.warning(f"⚠️  Employee ID already registered: {user.employee_id}")
            return jsonify(message="Employee ID already exists"), 409

        # Hash the password securely
        user.set_password(data.get("password"))
        current_app.logger.info(f"🔒 Password set for user: {user.username}")


        for role in roles_in:
            if role not in [r.value for r in Role]:
                current_app.logger.warning(f"❌ Invalid role: {role}")
                return jsonify(message=f"Invalid role: {role}"), 400

            # Check if the role is already assigned to the user
            if any(user_role.role == Role(role) for user_role in user.role_associations):
                current_app.logger.info(
                    f"⚠️ Role {role} already assigned to user: {user.username}")
                continue

            user.role_associations.append(UserRole(role=Role(role)))
            current_app.logger.info(f"✅ Role {role} added to user: {user.username}")

        # Save to MongoDB
        db.session.add(user)
        db.session.commit()
        current_app.logger.info(f"✅ User registered successfully: {user.username} ({user.email})")

        return jsonify(message="User registered"), 201
    except Exception as e:
        current_app.logger.exception(f"❌ Error : {e}")
        return jsonify(message="Something went wrong"), 500


@auth_bp.route('/login', methods=['POST'])
def login():
    current_app.logger.info("Received login request")
    try:
        data = request.get_json(force=True)
        current_app.logger.debug(f"Request JSON data: {data}")
    except Exception as e:
        data = request.form or {}
        current_app.logger.warning(
            f"Failed to parse JSON data, falling back to form data: {data}, error: {str(e)}")

    identifier_fields = ['email', 'username', 'employee_id']
    password = data.get('password')
    mobile = data.get('mobile')
    otp = data.get('otp')
    user = None

    # --- EMPLOYEE LOGIN ---
    if password:
        identifier = next((data.get(field) for field in identifier_fields if data.get(
            field)), None) or data.get('identifier')
        current_app.logger.info(
            f"Employee login attempt with identifier: {identifier}")
        if identifier:
            user = (
                User.query
                .filter_by(user_type='employee')
                .filter(
                    (User.email == identifier) |
                    (User.username == identifier) |
                    (User.employee_id == identifier)
                )
                .first()
            )
            if not user:
                current_app.logger.warning(
                    f"Login failed: No user found for identifier {identifier}")
                return _htmx_or_json_error("Invalid credentials", 401)
            if not user.check_password(password):
                current_app.logger.warning(
                    f"Login failed: Incorrect password for user {identifier}")
                return _htmx_or_json_error("Invalid credentials", 401)
            current_app.logger.info(
                f"Login successful for employee user {identifier}")

    # --- OTP LOGIN ---
    elif mobile and otp:
        current_app.logger.info(f"OTP login attempt for mobile: {mobile}")
        user = User.query.filter_by(mobile=mobile).first()
        if not user:
            current_app.logger.warning(
                f"Login failed: No user found for mobile {mobile}")
            return _htmx_or_json_error("Invalid OTP", 401)
        if not user.verify_otp(otp):
            current_app.logger.warning(
                f"Login failed: Invalid OTP for mobile {mobile}")
            return _htmx_or_json_error("Invalid OTP", 401)
        if user.user_type == 'general' and password:
            current_app.logger.warning(
                f"General user attempted password login for mobile {mobile}")
            return _htmx_or_json_error("General users must log in with OTP only", 403)
        current_app.logger.info(f"OTP login successful for mobile {mobile}")

    else:
        current_app.logger.warning("Login failed: Missing credentials")
        return _htmx_or_json_error("Missing credentials", 400)

    # --- Issue JWT ---
    access_token = create_access_token(
        identity=str(user.id),  # ✅ simple and safe
        additional_claims={
            # or however you access role
            "roles": [ur.role.value for ur in user.role_associations]
        }
    )
    user.last_login = datetime.now(timezone.utc)
    user.reset_failed_logins()
    db.session.commit()

    current_app.logger.info(
        f"Issued JWT for user {user.username} (ID: {user.id}), roles: {user.roles}")
    resp = jsonify(access_token=access_token, success=True)
    set_access_cookies(resp, access_token)

    # --- HTMX Response ---
    if request.headers.get("HX-Request"):
        html = render_template_string(
            """
            <div class="login-success" style="text-align:center; font-family:'Segoe UI', sans-serif; padding: 2rem;">
                <div style="font-size: 3rem; color: #28a745; margin-bottom: 1rem;">✅</div>
                <h2 style="color:#28a745; margin-bottom: 0.5rem;">Login Successful</h2>
                <p style="font-size: 1.1rem;">Welcome, <strong>{{ user.username }}</strong>! Redirecting you shortly...</p>
            </div>
            <script>
                setTimeout(function () {
                    document.body.innerHTML = `
                        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
                            <h2>Loading...</h2>
                            <div class="loader"></div>
                        </div>
                    `;
                    setTimeout(function () {
                        window.location.href = "dc8e18b4-b0ad-4b76-a4c5-cd340f84d494";
                    }, 1000);
                }, 2000);
            </script>
            """,
            user=user
        )
        resp = make_response(html)
        set_access_cookies(resp, access_token)
        current_app.logger.info(
            f"Returning HTMX response for user {user.username}")
        return resp

    current_app.logger.info(
        f"Returning JSON response for user {user.username}")
    return resp, 200

@auth_bp.route('/generate-otp', methods=['POST'])
def generate_otp():
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    mobile = data.get("mobile")

    if not mobile:
        return jsonify({"msg": "Mobile number required", "success": False}), 400

    user = User.objects(mobile=mobile).first()
    if not user:
        return jsonify({"msg": "User with this mobile not found", "success": False}), 404

    # Generate 6-digit OTP
    otp_code = str(random.randint(100000, 999999))
    user.otp = otp_code
    user.otp_expiration = datetime.now(timezone.utc) + timedelta(minutes=5)
    user.save()

    # TODO: Integrate SMS provider here to send OTP
    current_app.logger.debug(f"[DEBUG] OTP for {mobile}: {otp_code}")  # Logging only for development

    return jsonify({"msg": "OTP sent successfully", "success": True}), 200

# -------------------- Helper --------------------

def _htmx_or_json_error(message, status):
    if request.headers.get("HX-Request"):
        return render_template_string(f"<div class='error-message'>{message}</div>"), status
    return jsonify({"msg": message, "success": False}), status



# -------------------- LOGOUT --------------------

@auth_bp.route('/logout', methods=['POST'])
@jwt_required()
def logout():
    jwt_payload = get_jwt()
    jti = jwt_payload["jti"]
    exp_timestamp = jwt_payload["exp"]
    expires_at = datetime.fromtimestamp(exp_timestamp, tz=timezone.utc)

    # Save to MongoDB (MongoEngine)
    blocklist=TokenBlocklist(jti=jti, expires_at=expires_at)
    db.session.add(blocklist)
    db.session.commit()

    current_app.logger.info(f"User {get_jwt_identity()} logged out, token jti {jti} blocked until {expires_at}")

    resp = jsonify(msg="Successfully logged out")
    unset_jwt_cookies(resp)
    return resp, 200


@auth_bp.route('/me', methods=['GET'])
@jwt_required()
def about_me():
    jwt_data = get_jwt()
    user_id = jwt_data.get('sub', 'unknown')
    user = User.query.get_or_404(user_id)
    return jsonify(logged_in_as=user_schema.dump(user)), 200