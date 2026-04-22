import json

from client import r


def get_user(uid: str) -> dict | None:
    cached = r.get(f"user:{uid}")
    if cached:
        return json.loads(cached)
    return None


def set_user(uid: str, data: dict) -> None:
    r.set(f"user:{uid}", json.dumps(data))
    r.expire(f"user:{uid}", 3600)


def incr_views(uid: str) -> int:
    return r.incr(f"views:{uid}")
