from flask_jwt_extended import JWTManager
from app.models.TokenBlocklist import TokenBlocklist
from app.models.User import User

def init_jwt_callbacks(jwt: JWTManager):
    @jwt.token_in_blocklist_loader
    def is_revoked(jwt_header, jwt_payload):  # pragma: no cover
        jti = jwt_payload.get("jti")
        return TokenBlocklist.query.filter_by(jti=jti).first() is not None

    @jwt.additional_claims_loader
    def add_claims(identity):  # pragma: no cover
        user = User.query.get(identity)
        if not user:
            return {}
        return {"roles": [r.value for r in user.roles]}