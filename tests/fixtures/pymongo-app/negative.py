"""Negative tests: dynamic collection names and unrelated variables/dictionaries."""
from db import db, get_collection

def dynamic_subscript_lookup(col_name: str):
    # Dynamic name in db[...] should not produce a collection edge
    return db[col_name].find({"active": True})

def dynamic_get_collection(dynamic_table: str):
    # Dynamic name in get_collection(...)
    return db.get_collection(dynamic_table).find()

def dynamic_wrapper_call(runtime_name: str):
    # Dynamic name in wrapper helper
    col = get_collection(runtime_name)
    return col.find()

def unrelated_dictionary_access():
    # Normal Python dicts should not produce collection edges
    my_dict = {"users": 100, "orders": 200}
    val = my_dict["users"]
    ord_val = my_dict["orders"]
    return val, ord_val

def unrelated_methods_on_string():
    # Normal string .find(...) should not produce read edges
    msg = "find the needle in haystack"
    pos = msg.find("needle")
    return pos
