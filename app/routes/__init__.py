from app.routes.v1.auth_route import auth_bp
from app.routes.v1.view_route import view_bp
from app.routes.v1.user_route import user_bp
from app.routes.v1.video_route import video_bp

def register_blueprints(app):
    app.register_blueprint(view_bp, url_prefix='/')

    app.register_blueprint(user_bp, url_prefix='/api/v1/user')
    app.register_blueprint(auth_bp, url_prefix='/api/v1/auth')
    app.register_blueprint(video_bp, url_prefix='/api/v1/video')
    app.logger.info("Blueprints registered: auth_routes, user_routes, video_routes")