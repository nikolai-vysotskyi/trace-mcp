from uvicorn import run

from app import app as wsgi


def serve() -> None:
    run(wsgi, host="0.0.0.0", port=9000)
