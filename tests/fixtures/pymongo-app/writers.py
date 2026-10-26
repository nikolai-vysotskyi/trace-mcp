"""Write operations against MongoDB collections."""
from db import db, client, get_collection

def write_orders_insert():
    # Direct subscript insert_one and insert_many
    db["orders"].insert_one({"item": "laptop", "price": 1200})
    db["orders"].insert_many([{"item": "mouse"}, {"item": "keyboard"}])

def write_reports_update(report_id: str):
    # db.get_collection update_one and update_many
    col = db.get_collection("reports")
    col.update_one({"_id": report_id}, {"$set": {"status": "complete"}})
    col.update_many({"status": "stale"}, {"$set": {"status": "archived"}})

def write_events_replace():
    # Chained client["analytics"]["events"].replace_one
    client["analytics"]["events"].replace_one({"_id": "event_1"}, {"type": "login", "count": 1})

def write_metrics_delete():
    # Wrapper helper delete_one and delete_many
    col = get_collection("metrics")
    col.delete_one({"name": "temp_metric"})
    col.delete_many({"value": 0})

def write_audit_bulk():
    # Bulk write on audit_logs
    col = get_collection("audit_logs")
    col.bulk_write([])

def write_sessions_find_and_modify():
    # find_one_and_* operations on sessions
    db["sessions"].find_one_and_delete({"expired": True})
    db["sessions"].find_one_and_replace({"_id": "s1"}, {"active": False})
    db["sessions"].find_one_and_update({"_id": "s2"}, {"$set": {"active": True}})
