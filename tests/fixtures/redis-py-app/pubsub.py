from client import r


def listen() -> None:
    sub = r.pubsub()
    sub.subscribe("events")
    for _message in sub.listen():
        pass


def broadcast(event: str) -> int:
    return r.publish("events", event)
