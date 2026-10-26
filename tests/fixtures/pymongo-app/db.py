"""Database initialization and collection helper."""
from pymongo import MongoClient

# Use local dummy URI without any secrets or credentials
client = MongoClient("mongodb://localhost:27017")
db = client["analytics"]

def get_collection(name: str):
    """Simple local wrapper helper returning a collection by name."""
    return db[name]

class MongoManager:
    """Wrapper class providing a collection accessor helper."""
    @classmethod
    def get_mongo_collection(cls, name: str):
        return db.get_collection(name)
