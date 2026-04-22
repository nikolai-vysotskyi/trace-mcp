from redis.asyncio import (
    Redis,
    ConnectionPool,
)

pool = ConnectionPool.from_url("redis://cache:6379/0")
client = Redis(host="127.0.0.1", port=6379)


async def fetch(uid: str) -> str | None:
    return await client.get(f"user:{uid}")
