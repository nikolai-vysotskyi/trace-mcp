import json

from client import r


def append_event(event: dict) -> str:
    return r.xadd("events-stream", {"data": json.dumps(event)})


def read_events(last_id: str = "0") -> list:
    return r.xread({"events-stream": last_id}, block=0)
