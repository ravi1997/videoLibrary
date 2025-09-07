from flask_jwt_extended import JWTManager
from app.models import Token
from app.models.User import User
from app.extensions import db
from uuid import UUID
from datetime import datetime, timezone

def init_jwt_callbacks(jwt: JWTManager):
    @jwt.token_in_blocklist_loader
    def is_revoked(jwt_header, jwt_payload):  # pragma: no cover
        jti = jwt_payload.get("jti")
        # Consider token blocked if a block entry exists and not expired
        if not jti:
            return False
        now = datetime.now(timezone.utc)
        q = Token.query.filter(Token.token_type == 'block', Token.jti == jti, Token.expires_at > now)
        return q.first() is not None

    @jwt.additional_claims_loader
    def add_claims(identity):  # pragma: no cover
        # Coerce string UUID identities for SQLite tests / cross-dialect safety
        ident = identity
        if isinstance(identity, str):
            try:
                ident = UUID(identity)
            except Exception:
                ident = identity
        user = db.session.get(User, ident)
        if not user:
            return {}
        return {"roles": [r.value for r in user.roles]}
