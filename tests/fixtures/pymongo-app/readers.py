"""Read operations against MongoDB collections."""
from db import db, client, get_collection, MongoManager

def read_orders_find():
    # Direct subscript on db: db["orders"].find(...)
    return list(db["orders"].find({"status": "active"}))

def read_reports_find_one(report_id: str):
    # db.get_collection("reports").find_one(...)
    return db.get_collection("reports").find_one({"_id": report_id})

def read_events_aggregate():
    # Chained client["analytics"]["events"].aggregate(...)
    return list(client["analytics"]["events"].aggregate([{"$match": {"type": "click"}}]))

def read_metrics_count():
    # Local wrapper helper assignment + count_documents
    col = get_collection("metrics")
    return col.count_documents({"archived": False})

def read_categories_distinct():
    # Class wrapper helper assignment + distinct
    col = MongoManager.get_mongo_collection("categories")
    return col.distinct("tag")
