"""Dynamic dispatch patterns for testing."""

from .models.user import User
from .utils.helpers import format_date


def handle_create(data):
    """Handle create action."""
    pass


def handle_delete(data):
    """Handle delete action."""
    pass


def handle_update(data):
    """Handle update action."""
    pass


class EventHandler:
    def handle_click(self, event):
        pass

    def handle_submit(self, event):
        pass

    def handle_keypress(self, event):
        pass

    def dispatch(self, event_type, event):
        # getattr with f-string prefix — should resolve to all handle_* methods
        handler = getattr(self, f"handle_{event_type}")
        handler(event)

    def process(self, action):
        # getattr with string literal — should resolve to handle_click
        getattr(self, "handle_click")(action)


def dispatch_action(action, data):
    # Dict dispatch — should create edges to handle_create, handle_delete, handle_update
    handlers = {
        "create": handle_create,
        "delete": handle_delete,
        "update": handle_update,
    }
    handlers[action](data)


def run_specific():
    # getattr with string literal on imported class
    user = User("test", "test@test.com")
    saver = getattr(user, "save")
    saver()


def run_from_var():
    # Local string variable tracing
    method_name = "format_date"
    func = getattr(User, method_name)
