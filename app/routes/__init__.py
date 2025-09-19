"""Blueprint registration module.

This file only wires together the various blueprints. The actual route
implementations for administrator and superadministrator functionality now
live in versioned modules:
    * app.routes.v1.admin_route -> admin_api_bp
    * app.routes.v1.superadmin_route -> super_api_bp
"""

from app.routes.v1.auth_route import auth_bp
from app.routes.v1.view_route import view_bp
from app.routes.v1.user_route import user_bp
from app.routes.v1.video_route import video_bp
from app.routes.v1.superadmin_route import super_api_bp  # use versioned super routes
from app.routes.v1.admin_route import admin_api_bp

def register_blueprints(app):
    """Register application blueprints with the Flask app instance.

    Page-rendering routes for admin & superadmin now live exclusively in
    view_bp. Only API blueprints remain here for those domains.
    """


    BASE = '/video'
    app.register_blueprint(view_bp, url_prefix=BASE)
    app.register_blueprint(user_bp, url_prefix=f'{BASE}/api/v1/user')
    app.register_blueprint(auth_bp, url_prefix=f'{BASE}/api/v1/auth')
    app.register_blueprint(video_bp, url_prefix=f'{BASE}/api/v1/video')
    # Versioned admin/superadmin APIs
    app.register_blueprint(super_api_bp, url_prefix=f'{BASE}/api/v1/super')
    app.register_blueprint(admin_api_bp, url_prefix=f'{BASE}/api/v1/admin')
    app.logger.info("Blueprints registered (core + admin_api + super_api)")
