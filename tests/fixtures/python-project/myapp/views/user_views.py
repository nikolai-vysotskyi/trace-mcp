"""User views."""

from typing import TYPE_CHECKING

from ..models import User
from ..utils.helpers import format_date

if TYPE_CHECKING:
    from ..models.post import Post


def get_user(user_id: int) -> User:
    """Get a user by ID."""
    user = User("test", "test@example.com")
    user.save()
    return user


def list_users() -> list:
    """List all users."""
    return []


def get_user_display(user_id: int) -> str:
    """Get user display info with formatted date."""
    user = get_user(user_id)
    name = user.get_display_name()
    user.save()
    return format_date(name)
