"""User model."""

from typing import Optional
from .base import BaseModel
from ..utils.helpers import format_date


class User(BaseModel):
    """A user in the system."""

    __slots__ = ('_name', '_email')

    def __init__(self, name: str, email: str):
        self._name = name
        self._email = email

    @property
    def name(self) -> str:
        return self._name

    @name.setter
    def name(self, value: str):
        self._name = value

    def save(self):
        """Save user to database."""
        self.validate()
        pass

    def delete(self):
        """Delete user from database."""
        pass

    def get_display_name(self) -> str:
        """Get the user's display name."""
        formatted = format_date(self._name)
        return formatted
