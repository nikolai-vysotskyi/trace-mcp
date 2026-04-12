"""Utility helpers."""

from datetime import datetime


def format_date(dt: datetime) -> str:
    """Format a datetime for display."""
    return dt.strftime("%Y-%m-%d")


def _internal_helper():
    """Private helper, not exported."""
    pass
