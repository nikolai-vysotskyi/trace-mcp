"""API proxy that receives typed parameters — tests parameter annotation inference."""

from ..models.user import User
from ..models.base import BaseModel


def verify_and_save(user: User, force: bool = False) -> bool:
    """Receives a User via parameter annotation, calls methods on it."""
    if user.validate():
        user.save()
        return True
    return False


def get_display(user: User) -> str:
    """Another function receiving User via parameter annotation."""
    return user.get_display_name()


def process_model(model: BaseModel) -> None:
    """Receives a BaseModel via parameter annotation — tests inherited method calls."""
    model.validate()
    model.save()
