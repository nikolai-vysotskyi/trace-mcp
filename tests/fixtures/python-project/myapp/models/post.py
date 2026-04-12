"""Post model."""

from .base import BaseModel
from .user import User


class Post(BaseModel):
    """A blog post."""

    def __init__(self, title: str, author: User):
        self.title = title
        self.author = author

    def save(self):
        pass

    def delete(self):
        pass
