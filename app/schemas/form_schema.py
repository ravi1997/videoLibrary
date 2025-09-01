from marshmallow import Schema, fields, validate, post_load
from uuid import UUID
import uuid

from app.models.enumerations import FIELD_API_CALL_CHOICES, FIELD_TYPE_CHOICES, FORM_STATUS_CHOICES, ui_TYPE_CHOICES
from marshmallow import Schema, fields

# --- ResponseTemplate Schema ---
class ResponseTemplateSchema(Schema):
    name = fields.Str(required=True)
    description = fields.Str()
    structure = fields.Str()
    tags = fields.List(fields.Str())
    meta_data = fields.Dict()

# --- Option Schema ---
class OptionSchema(Schema):
    id = fields.UUID(required=True)
    description = fields.Str()
    is_default = fields.Bool(load_default=False)
    is_disabled = fields.Bool(load_default=False)
    option_label = fields.Str(required=True)
    option_value = fields.Str(required=True)
    order = fields.Int(load_default=0)
    followup_visibility_condition = fields.Str()
    created_at = fields.DateTime(dump_only=True)

# --- Question Schema ---
class QuestionSchema(Schema):
    id = fields.UUID(required=True)
    label = fields.Str(required=True)
    field_type = fields.Str(validate=validate.OneOf(FIELD_TYPE_CHOICES), required=True)
    is_required = fields.Bool(load_default=False)
    help_text = fields.Str()
    default_value = fields.Str()
    order = fields.Int()
    visibility_condition = fields.Str()
    validation_rules = fields.Str()
    is_repeatable_question = fields.Bool(load_default=False)
    repeat_min = fields.Int(load_default=0)
    repeat_max = fields.Int()
    onChange = fields.Str()
    calculated_value = fields.Str()
    is_disabled = fields.Bool(load_default=False)
    visible_header = fields.Bool(load_default=False)
    visible_name = fields.Str()
    response_templates = fields.List(fields.Nested(ResponseTemplateSchema))
    options = fields.List(fields.Nested(OptionSchema))
    field_api_call = fields.Str(validate=validate.OneOf(FIELD_API_CALL_CHOICES))
    custom_script = fields.Str()
    meta_data = fields.Dict()
    created_at = fields.DateTime(dump_only=True)
    updated_at = fields.DateTime(dump_only=True)

# --- Section Schema ---
class SectionSchema(Schema):
    id = fields.UUID(required=True)
    title = fields.Str(required=True)
    description = fields.Str()
    order = fields.Int()
    visibility_condition = fields.Str()
    validation_rules = fields.Str()
    is_disabled = fields.Bool(load_default=False)
    ui = fields.Str(validate=validate.OneOf(ui_TYPE_CHOICES), load_default="flex")
    is_repeatable_section = fields.Bool(load_default=False)
    repeat_min = fields.Int(load_default=0)
    repeat_max = fields.Int()
    questions = fields.List(fields.Nested(QuestionSchema))
    response_templates = fields.List(fields.Nested(ResponseTemplateSchema))
    meta_data = fields.Dict()
    created_at = fields.DateTime(dump_only=True)
    updated_at = fields.DateTime(dump_only=True)

# --- FormVersion Schema ---
class FormVersionSchema(Schema):
    version = fields.Str(required=True)
    created_by = fields.Str()
    created_at = fields.DateTime(dump_only=True)
    sections = fields.List(fields.Nested(SectionSchema))

# --- Form Schema ---
class FormSchema(Schema):
    id = fields.UUID(required=True)
    title = fields.Str(required=True)
    description = fields.Str()
    slug = fields.Str(required=True)
    created_by = fields.Str(required=True)
    status = fields.Str(validate=validate.OneOf(FORM_STATUS_CHOICES), load_default="draft")
    ui = fields.Str(validate=validate.OneOf(ui_TYPE_CHOICES), load_default="flex")
    submit_scripts = fields.Str()
    created_at = fields.DateTime(dump_only=True)
    updated_at = fields.DateTime(dump_only=True)
    is_public = fields.Bool(load_default=False)
    versions = fields.List(fields.Nested(FormVersionSchema))
    tags = fields.List(fields.Str())
    response_templates = fields.List(fields.Nested(ResponseTemplateSchema))
    editors = fields.List(fields.Str())
    uiers = fields.List(fields.Str())
    submitters = fields.List(fields.Str())

# --- FormResponse Schema ---
class FormResponseSchema(Schema):
    id = fields.UUID(required=True)
    form = fields.UUID(required=True)  # Assuming you want just the form ID
    data = fields.Dict()
    submitted_by = fields.Str()
    submitted_at = fields.DateTime(dump_only=True)
    updated_by = fields.Str()
    updated_at = fields.DateTime(dump_only=True)
    deleted = fields.Bool(load_default=False)
    deleted_by = fields.Str()
    deleted_at = fields.DateTime(dump_only=True)
    metadata = fields.Dict()
