"""Base model with common functionality."""

from abc import ABC, abstractmethod


class BaseModel(ABC):
    """Abstract base model."""

    @abstractmethod
    def save(self):
        """Persist the model."""
        pass

    @abstractmethod
    def delete(self):
        """Delete the model."""
        pass

    def validate(self) -> bool:
        """Validate the model data."""
        return True
