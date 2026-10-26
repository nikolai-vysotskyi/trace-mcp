import boto3

ssm = boto3.client('ssm')

def get_db_param():
    return ssm.get_parameter(Name='/prod/db/endpoint', WithDecryption=True)

def get_tree():
    return ssm.get_parameters_by_path(Path='/prod/db', Recursive=True)

def set_param(val):
    ssm.put_parameter(Name='/prod/db/status', Value=val)
