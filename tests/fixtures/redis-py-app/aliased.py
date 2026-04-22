import redis as r


def make_client():
    return r.Redis(host="127.0.0.1", port=6379)
