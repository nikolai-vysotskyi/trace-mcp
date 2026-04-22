import redis

r = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)

pool = redis.ConnectionPool.from_url("redis://cache:6379/0")
