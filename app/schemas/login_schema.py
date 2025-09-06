from marshmallow import Schema, fields, validates_schema, ValidationError


class LoginSchema(Schema):
    email = fields.Email()
    username = fields.Str()
    employee_id = fields.Str()
    password = fields.Str(load_default=None)
    mobile = fields.Str(load_default=None)
    otp = fields.Str(load_default=None)
    identifier = fields.Str(load_default=None)

    @validates_schema
    def validate_login(self, data, **kwargs):
        has_pwd_flow = bool(data.get('password'))
        has_otp_flow = bool(data.get('mobile') and data.get('otp'))
        if not has_pwd_flow and not has_otp_flow:
            raise ValidationError('Either password credentials or mobile+otp required')
        if has_pwd_flow and has_otp_flow:
            raise ValidationError('Provide either password or mobile+otp, not both')
        # For password flow require one identifier
        if has_pwd_flow and not any(data.get(k) for k in ('email','username','employee_id','identifier')):
            raise ValidationError('Missing identifier for password login')
        if data.get('otp') and not data.get('mobile'):
            raise ValidationError('mobile required with otp')
