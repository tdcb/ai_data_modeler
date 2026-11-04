"""Collaboration tables (registered on the shared SQLAlchemy Base so init_db_and_seed creates them)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text

from ..auth.models import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CollabCommentRecord(Base):
    __tablename__ = "collab_comments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    model_id = Column(String(120), index=True, nullable=False)
    thread_id = Column(String(64), index=True, nullable=False)
    parent_id = Column(Integer, nullable=True)
    target_type = Column(String(32), nullable=False, default="model")  # model, entity, column, relationship
    entity_id = Column(String(160), nullable=True)
    column_id = Column(String(160), nullable=True)
    relationship_id = Column(String(160), nullable=True)
    author_email = Column(String(255), nullable=False)
    author_name = Column(String(255), nullable=False)
    body = Column(Text, nullable=False)
    mentions = Column(Text, nullable=False, default="[]")
    resolved = Column(Boolean, nullable=False, default=False)
    resolved_by_email = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=_now, nullable=False)
    updated_at = Column(DateTime, default=_now, nullable=False)


class CollabActivityRecord(Base):
    __tablename__ = "collab_activity"

    id = Column(Integer, primary_key=True, autoincrement=True)
    model_id = Column(String(120), index=True, nullable=False)
    version = Column(Integer, nullable=False, default=0)
    actor_email = Column(String(255), nullable=False)
    actor_name = Column(String(255), nullable=False)
    kind = Column(String(32), nullable=False)  # edit, comment, resolve, share, restore, join
    summary = Column(Text, nullable=False, default="")
    snapshot_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now, nullable=False)


class CollabInviteRecord(Base):
    __tablename__ = "collab_invites"

    token = Column(String(64), primary_key=True)
    model_id = Column(String(120), index=True, nullable=False)
    email = Column(String(255), nullable=True)  # None = shareable link
    role = Column(String(32), nullable=False, default="VIEW")  # VIEW, COMMENT, EDIT, ADMIN
    created_by_email = Column(String(255), nullable=False)
    accepted_by_email = Column(String(255), nullable=True)
    revoked = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=_now, nullable=False)
