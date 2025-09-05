import re
import uuid
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
from app.security_utils import rate_limit, ip_and_path_key, ip_key
from app.extensions import db
from app.models.RefreshToken import RefreshToken
from werkzeug.utils import secure_filename
import os
from sqlalchemy.exc import ProgrammingError, IntegrityError
from flask import send_file

from app.utils.services.cdac import cdac_service
from app.utils.services.sms import send_sms

auth_bp = Blueprint('auth_bp', __name__)
user_schema = UserSchema()
ADMIN_ROLE = Config.ADMIN_ROLE


# -------------------- REGISTER --------------------
@auth_bp.route("/register", methods=["POST"])
@rate_limit(ip_and_path_key, limit=10, window_sec=300)
def register():
    data = request.get_json()
    current_app.logger.info("Received registration data: %s", {k: v for k, v in data.items() if k != "password"})
    # Only allow non-privileged roles on self-registration to prevent escalation
    roles_in = [r for r in data.get("roles", []) if r in {Role.GENERAL.value, Role.USER.value, Role.VIEWER.value}]
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
        try:
            user.set_password(data.get("password"))
        except ValueError as pe:
            current_app.logger.warning(f"Weak password attempt for user {user.username}: {pe}")
            return jsonify(message=str(pe)), 400
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
@rate_limit(ip_and_path_key, limit=20, window_sec=300)
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
            if not user.is_verified:
                current_app.logger.warning(f"Login failed: user {identifier} not verified by admin")
                return _htmx_or_json_error("Account pending verification", 403)
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
        if not user.is_verified:
            current_app.logger.warning(f"OTP login failed: user with mobile {mobile} not verified by admin")
            return _htmx_or_json_error("Account pending verification", 403)
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
            "roles": [ur.role.value for ur in user.role_associations]
        }
    )
    # Issue refresh token (persisted, hashed)
    refresh_ttl = timedelta(minutes=Config.REFRESH_TOKEN_EXPIRES_MINUTES)
    try:
        rt_obj, refresh_plain = RefreshToken.create_for_user(user.id, refresh_ttl, request.headers.get('User-Agent'), request.remote_addr)
    except Exception:
        current_app.logger.exception("Failed creating refresh token")
        return _htmx_or_json_error("Internal error", 500)
    user.last_login = datetime.now(timezone.utc)
    user.reset_failed_logins()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Login DB commit failed")
        return _htmx_or_json_error("Internal error", 500)

    current_app.logger.info(
        f"Issued JWT for user {user.username} (ID: {user.id}), roles: {user.roles}")
    resp = jsonify(access_token=access_token, refresh_token=refresh_plain, success=True)
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
        resp_html = make_response(html)
        set_access_cookies(resp_html, access_token)
        current_app.logger.info(
            f"Returning HTMX response for user {user.username}")
        return resp_html

    current_app.logger.info(
        f"Returning JSON response for user {user.username}")
    return resp, 200

@auth_bp.route('/refresh', methods=['POST'])
@rate_limit(ip_and_path_key, limit=30, window_sec=300)
def refresh_token():
    """Exchange a valid (non-revoked, unexpired) refresh token for a new access token.
    Body: {"refresh_token":"..."}
    Rotates refresh token (old one becomes revoked) to mitigate replay.
    """
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}
    supplied = (data.get('refresh_token') or '').strip()
    if not supplied:
        return jsonify({'msg': 'refresh_token required'}), 400
    token_hash = RefreshToken.hash_token(supplied)
    rt = RefreshToken.query.filter_by(token_hash=token_hash).first()
    if not rt:
        # Do not reveal if invalid vs reused
        return jsonify({'msg': 'invalid refresh token'}), 401
    if not rt.is_active():
        return jsonify({'msg': 'expired or revoked'}), 401

    # Rotate (single-use) -> revoke current, issue new
    user = User.query.get(rt.user_id)
    if not user or not user.is_active:
        return jsonify({'msg': 'user inactive'}), 401

    access_token = create_access_token(
        identity=str(user.id),
        additional_claims={
            'roles': [ur.role.value for ur in user.role_associations]
        }
    )
    refresh_ttl = timedelta(minutes=Config.REFRESH_TOKEN_EXPIRES_MINUTES)
    new_rt, new_plain = RefreshToken.create_for_user(user.id, refresh_ttl, request.headers.get('User-Agent'), request.remote_addr)
    rt.revoke(replaced_by=new_rt)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('refresh_token: DB commit failed')
        return jsonify({'msg': 'internal error'}), 500
    return jsonify({'access_token': access_token, 'refresh_token': new_plain}), 200

@auth_bp.route('/generate-otp', methods=['POST'])
@rate_limit(ip_and_path_key, limit=5, window_sec=300)
def generate_otp():
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    mobile = data.get("mobile")

    if not mobile:
        return jsonify({"msg": "Mobile number required", "success": False}), 400

    # Using SQLAlchemy (Postgres) instead of Mongo-style API
    user = User.query.filter_by(mobile=mobile).first()
    if not user:
        return jsonify({"msg": "User with this mobile not found", "success": False}), 404

    # Generate 6-digit OTP
    otp_code = str(random.randint(100000, 999999))
    user.otp = otp_code
    user.otp_expiration = datetime.now(timezone.utc) + timedelta(minutes=5)
    try:
        otp_status = send_sms(
            mobile, f"OTP for RPC Surgical video Library is {otp_code}")
        if otp_status != 200:
            current_app.logger.warning(f"Failed to send OTP SMS to {mobile}")
            return jsonify({"msg": "Failed to send OTP", "success": False}), 500
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception("Failed to save OTP to DB")
        return jsonify({"msg": "internal server error", "success": False}), 500

    # TODO: Integrate SMS provider here to send OTP
    current_app.logger.debug(f"[DEBUG] OTP for {mobile}: {otp_code}")  # Logging only for development

    return jsonify({"msg": "OTP sent successfully", "success": True}), 200


# -------------------- EMPLOYEE HELPERS / REG FLOW --------------------
@auth_bp.route('/employee-lookup', methods=['POST'])
def employee_lookup():
    """
    Unified employee / mobile lookup + OTP dispatch.

    Scenarios:
    1) employee_id only:
         - Look in local DB.
         - If not found -> query CDAC (external). If CDAC returns data, create user from it.
         - If CDAC has no mobile AND client did not supply one -> ask client for mobile.
         - Generate + persist OTP, send SMS.
    2) employee_id + mobile (employee not in DB):
         - Try CDAC first (optional – if you want to trust supplied mobile when CDAC lacks one).
         - Create provisional employee user with supplied mobile.
    3) mobile only (non‑permanent / general):
         - Reuse existing user by mobile or create provisional general user.
    Responses are normalized with an 'ok' flag and consistent status codes.
    """
    def json_error(msg, status=400, **extra):
        payload = {'ok': False, 'msg': msg}
        payload.update(extra)
        return jsonify(payload), status

    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    emp_id = (data.get('employee_id') or '').strip() or None
    mobile_in = (data.get('mobile') or '').strip() or None

    # Basic validation
    MOBILE_RE = re.compile(r'^\+?\d{8,15}$')
    if mobile_in and not MOBILE_RE.match(mobile_in):
        return json_error("invalid mobile format")

    # Helper to split full name safely
    def split_name(full: str):
        if not full:
            return ("", "")
        parts = full.split()
        if len(parts) == 1:
            return (parts[0], "")
        if len(parts) == 2:
            return (parts[0], parts[1])
        return (" ".join(parts[:-1]), parts[-1])

    # (OTP generation removed from lookup flow; done explicitly via /generate-otp)
    def assign_otp(user: User):  # retained for backward compatibility if referenced elsewhere
        otp_code = str(random.randint(100000, 999999))
        user.set_otp(otp_code)
        return otp_code

    # Branch 1 / 2: Have employee_id
    if emp_id:
        try:
            user = User.query.filter_by(employee_id=emp_id).first()
        except ProgrammingError:
            current_app.logger.exception("employee_lookup: programming error")
            return json_error("internal server error", 500)

        if user:
            changed = False
            # Existing employee; maybe update missing mobile if a valid one supplied
            if mobile_in and not user.mobile:
                user.mobile = mobile_in
                changed = True
            if not user.mobile:
                return json_error("mobile required to proceed", 400, mobile_required=True)
            if changed:
                try:
                    db.session.commit()
                except Exception:
                    db.session.rollback()
                    current_app.logger.exception(
                        "employee_lookup: failed to persist employee update")
                    return json_error("internal server error", 500)
            return jsonify({
                'ok': True,
                'found': True,
                'existing': True,
                'employee_id': emp_id,
                'username': user.username,
                'email': user.email,
                'mobile': user.mobile,
                'sent_otp': False  # OTP now deferred until /generate-otp
            }), 200

        # No local user: try external CDAC unless client already supplied a mobile and we choose to trust it.
        cdac_data = None
        if not mobile_in:
            cdac_data = cdac_service(emp_id)
            if not cdac_data:
                # Could not resolve externally and no mobile to continue
                return json_error("employee not found; mobile required", 404, mobile_required=True)

        # Normalize fields from CDAC (if present) or fallback
        if cdac_data:
            # Some implementations wrap data under 'data'
            payload = cdac_data.get('data') if isinstance(
                cdac_data, dict) and 'data' in cdac_data else cdac_data
            name_raw = payload.get('name') or ""
            first, last = split_name(name_raw)
            username = name_raw or f"user_{emp_id.lower()}"
            mobile = str(payload.get('mobile_number')) or mobile_in
            email = payload.get('email_address')
        else:
            # Creating provisional employee from provided mobile only
            username = f"user_{emp_id.lower()}"
            mobile = mobile_in
            email = None

        if not mobile:
            return json_error("mobile required (not provided by CDAC)", 400, mobile_required=True)
        if not MOBILE_RE.match(mobile):
            return json_error("invalid mobile format", 400)

        # Check if mobile already belongs to an existing user; attach employee_id if vacant
        existing_mobile_user = User.query.filter_by(mobile=mobile).first()
        if existing_mobile_user and existing_mobile_user.employee_id and existing_mobile_user.employee_id != emp_id:
            return json_error("mobile already in use by another user", 409)

        if existing_mobile_user and not existing_mobile_user.employee_id:
            user = existing_mobile_user
            user.employee_id = emp_id
            if email and not user.email:
                user.email = email
            if username and not user.username:
                user.username = username
        else:
            user = User(
                username=username,
                email=email,
                mobile=mobile,
                employee_id=emp_id,
                user_type='employee',
                is_active=True,
                is_verified=False,
                document_submitted=False
            )
            db.session.add(user)

        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            current_app.logger.exception(
                "employee_lookup: failed to create/augment employee record (no OTP phase)")
            return json_error("internal server error", 500)

        return jsonify({
            'ok': True,
            'found': True,
            'created': True,
            'employee_id': emp_id,
            'username': user.username,
            'email': user.email,
            'mobile': user.mobile,
            'sent_otp': False  # defer OTP
        }), 201

    # Branch 3: mobile only (non-permanent / general)
    if mobile_in:
        mobile = mobile_in
        existing = User.query.filter_by(mobile=mobile).first()
        if existing:
            user = existing
        else:
            user = User(
                mobile=mobile,
                user_type='general',
                is_active=True,
                is_verified=False,
                document_submitted=False
            )
            db.session.add(user)

        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            current_app.logger.exception(
                "employee_lookup: failed to persist general user record (no OTP phase)")
            return json_error("internal server error", 500)

        return jsonify({
            'ok': True,
            'found': bool(existing),
            'created_temp': not bool(existing),
            'mobile': mobile,
            'sent_otp': False  # defer OTP
        }), 201 if not existing else 200

    return json_error("employee_id or mobile required")

@auth_bp.route('/verify-otp', methods=['POST'])
@rate_limit(ip_and_path_key, limit=15, window_sec=300)
def verify_otp():
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    mobile = data.get('mobile')
    code = data.get('otp')

    if not mobile or not code:
        return jsonify({'msg': 'mobile and otp required'}), 400

    user = User.query.filter_by(mobile=mobile).first()
    if not user:
        return jsonify({'msg': 'user not found'}), 404

    if not user.verify_otp(code):
        return jsonify({'msg': 'invalid otp'}), 401

    # mark mobile verified for the session — don't mark is_verified yet
    user.otp = None
    user.otp_expiration = None
    db.session.commit()
    return jsonify({'msg': 'otp verified', 'mobile': mobile}), 200


@auth_bp.route('/create-account', methods=['POST'])
@rate_limit(ip_and_path_key, limit=10, window_sec=600)
def create_account():
    """Finalize account after OTP verification.
    Accepts: username, email, password, mobile, optional employee_id, optional temp_upload_id.
    If temp_upload_id provided, any temp files are reassigned to this user and document_submitted flagged.
    """
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    required = ['username', 'email', 'password', 'mobile']
    for r in required:
        if not data.get(r):
            return jsonify({'msg': f'{r} required'}), 400

    employee_id = (data.get('employee_id') or '').strip() or None
    mobile = (data.get('mobile') or '').strip()
    temp_upload_id = (data.get('temp_upload_id') or '').strip() or None

    # Find existing provisional user created during lookup phase
    user = None
    if employee_id:
        user = User.query.filter_by(employee_id=employee_id).first()
    if not user:
        user = User.query.filter_by(mobile=mobile).first()
    if not user:
        return jsonify({'msg': 'provisional user not found'}), 404

    user.username = data['username']
    user.email = data['email']
    try:
        user.set_password(data['password'])
    except ValueError as pe:
        return jsonify({'msg': str(pe)}), 400

    # Link temp uploaded document if present
    if temp_upload_id:
        upload_dir = os.path.join(os.getcwd(),"app","uploads","id_uploads")
        try:
            os.makedirs(upload_dir, exist_ok=True)
            # Find files starting with temp_<id>_
            prefix = f"temp_{temp_upload_id}_"
            moved_any = False
            for fname in os.listdir(upload_dir):
                if fname.startswith(prefix):
                    src = os.path.join(upload_dir, fname)
                    # remove temp prefix keep remainder after id underscore
                    remainder = fname.split(prefix, 1)[-1]
                    dest_name = f"{user.id}_{remainder}"
                    dest = os.path.join(upload_dir, dest_name)
                    try:
                        os.replace(src, dest)
                        moved_any = True
                    except Exception:
                        current_app.logger.exception('create_account: failed to move temp upload file')
            if moved_any:
                user.document_submitted = True
        except Exception:
            current_app.logger.exception('create_account: error processing temp uploads')

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('create_account: DB commit failed')
        return jsonify({'msg': 'internal error'}), 500

    return jsonify({'msg': 'account created', 'user_id': str(user.id)}), 200

@auth_bp.route('/upload-temp-id', methods=['POST'])
@rate_limit(ip_and_path_key, limit=10, window_sec=600)
def upload_temp_id():
    """Upload ID document before account creation.
    Stores file with a temporary token and returns temp_upload_id.
    Later /create-account can bind this to the created user.
    """
    if 'file' not in request.files:
        return jsonify({'msg': 'file missing'}), 400
    f = request.files['file']
    if f.filename == '':
        return jsonify({'msg': 'empty filename'}), 400
    upload_dir = os.path.join(os.getcwd(),"app","uploads" ,"id_uploads")
    current_app.logger.info(f"Upload directory: {upload_dir}")
    os.makedirs(upload_dir, exist_ok=True)
    temp_id = uuid.uuid4().hex
    safe = secure_filename(f.filename)
    allowed_ext = {'.png', '.jpg', '.jpeg', '.pdf'}
    ext = (safe.rsplit('.',1)[-1]).lower() if '.' in safe else ''
    if ext and f'.{ext}' not in allowed_ext:
        return jsonify({'msg': 'unsupported file type'}), 400
    dest = os.path.join(upload_dir, f"temp_{temp_id}_{safe}")
    try:
        f.save(dest)
    except Exception:
        current_app.logger.exception('upload_temp_id: failed to save file')
        return jsonify({'msg': 'save failed'}), 500
    return jsonify({'msg': 'temp file stored', 'temp_upload_id': temp_id, 'filename': safe}), 200


@auth_bp.route('/upload-id/<user_id>', methods=['POST'])
@rate_limit(ip_and_path_key, limit=10, window_sec=600)
def upload_id(user_id):
    # Accept file upload (PDF) and mark document_submitted=True
    if 'file' not in request.files:
        return jsonify({'msg': 'file missing'}), 400
    f = request.files['file']
    if f.filename == '':
        return jsonify({'msg': 'empty filename'}), 400
    filename = secure_filename(f.filename)
    allowed_ext = {'.png', '.jpg', '.jpeg', '.pdf'}
    ext = (filename.rsplit('.',1)[-1]).lower() if '.' in filename else ''
    if ext and f'.{ext}' not in allowed_ext:
        return jsonify({'msg': 'unsupported file type'}), 400
    upload_dir = current_app.config.get('UPLOAD_FOLDER', '/tmp/uploads')
    os.makedirs(upload_dir, exist_ok=True)
    dest = os.path.join(upload_dir, f"{user_id}_{filename}")
    f.save(dest)

    user = User.query.get(user_id)
    if not user:
        return jsonify({'msg': 'user not found'}), 404
    user.document_submitted = True
    db.session.commit()
    return jsonify({'msg': 'file uploaded'}), 200

# -------------------- ADMIN VERIFICATION --------------------

@auth_bp.get('/unverified')
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def list_unverified():
    """Return list of users pending admin verification.
    Includes basic profile & document status. Sorted oldest first.
    """
    users = (User.query
             .filter_by(is_verified=False)
             .order_by(User.created_at.asc())
             .all())
    payload = []
    for u in users:
        payload.append({
            'id': str(u.id),
            'username': u.username,
            'email': u.email,
            'employee_id': u.employee_id,
            'mobile': u.mobile,
            'user_type': u.user_type,
            'document_submitted': u.document_submitted,
            'created_at': u.created_at.isoformat() if u.created_at else None,
        })
    return jsonify({'users': payload, 'count': len(payload)}), 200


@auth_bp.post('/verify-user')
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def verify_user():
    """Mark a user as verified.
    Body: {"user_id": "<uuid>"}
    Returns updated user summary.
    """
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}
    target_id = (data.get('user_id') or '').strip()
    if not target_id:
        return jsonify({'msg': 'user_id required'}), 400
    target = User.query.get(target_id)
    if not target:
        return jsonify({'msg': 'user not found'}), 404
    if target.is_verified:
        return jsonify({'msg': 'already verified'}), 200

    # Optional rule: require document if general user
    if target.user_type == 'general' and not target.document_submitted:
        return jsonify({'msg': 'document required before verification'}), 409

    target.is_verified = True
    target.updated_at = datetime.now(timezone.utc)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('verify_user: DB commit failed')
        return jsonify({'msg': 'internal error'}), 500

    return jsonify({'msg': 'verified', 'user': {
        'id': str(target.id),
        'username': target.username,
        'email': target.email,
        'employee_id': target.employee_id,
        'mobile': target.mobile,
        'user_type': target.user_type,
        'document_submitted': target.document_submitted,
        'is_verified': target.is_verified,
    }}), 200


@auth_bp.get('/user-document/<user_id>')
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def get_user_document(user_id=None):
    """Stream the first document file associated with the user (if any).
    Looks for files named '<user_id>_...' in UPLOAD_FOLDER.
    Returns 404 if none found.
    """
    target_id = user_id
    if not target_id:
        return jsonify({'msg': 'user_id missing'}), 400
    upload_dir = os.path.join(os.getcwd(),"app","uploads","id_uploads")
    if not os.path.isdir(upload_dir):
        return jsonify({'msg': 'no documents'}), 404
    # Find first matching file
    for fname in os.listdir(upload_dir):
        if fname.startswith(f"{target_id}_"):
            path = os.path.join(upload_dir, fname)
            try:
                return send_file(path, as_attachment=False)
            except Exception:
                current_app.logger.exception('get_user_document: failed to send file')
                return jsonify({'msg': 'error reading file'}), 500
    return jsonify({'msg': 'document not found'}), 404


@auth_bp.post('/discard-user')
@require_roles(Role.ADMIN.value, Role.SUPERADMIN.value)
def discard_user():
    """Delete (discard) a non-verified user and any uploaded documents.
    Body: {"user_id": "<uuid>"}
    Prevent deletion of already verified users.
    """
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}
    target_id = (data.get('user_id') or '').strip()
    if not target_id:
        return jsonify({'msg': 'user_id required'}), 400
    target = User.query.get(target_id)
    if not target:
        return jsonify({'msg': 'user not found'}), 404
    if target.is_verified:
        return jsonify({'msg': 'cannot discard verified user'}), 409
    upload_dir = current_app.config.get('UPLOAD_FOLDER', '/tmp/uploads')
    if os.path.isdir(upload_dir):
        for fname in list(os.listdir(upload_dir)):
            if fname.startswith(f"{target_id}_"):
                try:
                    os.remove(os.path.join(upload_dir, fname))
                except Exception:
                    current_app.logger.warning('discard_user: failed to remove file %s', fname)
    try:
        db.session.delete(target)
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('discard_user: DB delete failed')
        return jsonify({'msg': 'internal error'}), 500
    return jsonify({'msg': 'discarded'}), 200

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

    blocklist = TokenBlocklist(jti=jti, expires_at=expires_at)
    db.session.add(blocklist)

    # Optional body refresh_token to revoke proactively
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}
    supplied = (data.get('refresh_token') or '').strip()
    if supplied:
        h = RefreshToken.hash_token(supplied)
        rt = RefreshToken.query.filter_by(token_hash=h).first()
        if rt and rt.is_active():
            rt.revoke()

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('logout: DB commit failed')

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


# -------------------- PASSWORD RESET --------------------
@auth_bp.route('/forgot-password', methods=['POST'])
@rate_limit(ip_and_path_key, limit=5, window_sec=900)
def forgot_password():
    """Initiate password reset. Accepts email or mobile. Sends token via chosen channel."""
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    email = (data.get('email') or '').strip().lower()
    mobile = (data.get('mobile') or '').strip()
    if not email and not mobile:
        return jsonify({'ok': False, 'msg': 'email or mobile required'}), 400

    user = None
    if email:
        user = User.query.filter_by(email=email).first()
    elif mobile:
        user = User.query.filter_by(mobile=mobile).first()

    # Always return generic success to avoid user enumeration
    if not user:
        return jsonify({'ok': True, 'msg': 'If the account exists, a reset token has been sent.'}), 200

    token = user.generate_reset_token()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('forgot_password: failed to store reset token')
        return jsonify({'ok': False, 'msg': 'internal error'}), 500

    # Dispatch via SMS if mobile provided and matches user; else log (email send placeholder)
    dispatched = False
    status = send_sms(user.mobile, f"Password reset token: {token}")
    dispatched = status == 200


    if not dispatched:
        return jsonify({'ok': False, 'msg': 'failed to dispatch token'}), 500

    return jsonify({'ok': True, 'msg': 'If the account exists, a reset token has been sent.'}), 200


@auth_bp.route('/reset-password', methods=['POST'])
def reset_password():
    """Complete password reset using identifier (email or mobile), token, and new password."""
    try:
        data = request.get_json(force=True)
    except Exception:
        data = request.form or {}

    identifier = (data.get('email') or data.get('mobile') or '').strip().lower()
    token = (data.get('token') or '').strip()
    new_password = (data.get('password') or '').strip()

    if not identifier or not token or not new_password:
        return jsonify({'ok': False, 'msg': 'identifier, token, password required'}), 400

    user = User.query.filter((User.email == identifier) | (User.mobile == identifier)).first()
    if not user or not user.verify_reset_token(token):
        return jsonify({'ok': False, 'msg': 'invalid token'}), 400

    user.set_password(new_password)
    user.clear_reset_token()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        current_app.logger.exception('reset_password: failed to update password')
        return jsonify({'ok': False, 'msg': 'internal error'}), 500
    return jsonify({'ok': True, 'msg': 'password updated'}), 200